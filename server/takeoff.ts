/**
 * AI Takeoff Engine — Two-Pass Architecture
 *
 * Pass 1 (per chunk): Raw extraction — every bar mark, qty, dimensions, bend details.
 *   No summarizing, no consolidation. Just read and report exactly what's on each page.
 *
 * Pass 2 (single call): Consolidation — merge all chunk data, deduplicate bar marks,
 *   sum quantities, compute weights, produce the final cut sheet + other materials.
 *
 * Pass 3: Price from the consolidated cut sheet using QBO products.
 *
 * PDF inputs use the OpenAI Responses API with inline base64 — no system binary needed.
 * Image inputs fall back to Chat Completions API with image_url content parts.
 */
import OpenAI from "openai";
import type { Product, LineItem, FabItem } from "@shared/schema";

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

// ── Bar weight table (lb/ft) ────────────────────────────────────────────────
const BAR_WEIGHT: Record<string, number> = {
  "#3": 0.376, "#4": 0.668, "#5": 1.043, "#6": 1.502,
  "#7": 2.044, "#8": 2.670, "#9": 3.400, "#10": 4.303, "#11": 5.313,
};

export interface TakeoffResult {
  lineItems: LineItem[];
  fabItems: FabItem[];
  takeoffNotes: string[];
  projectName: string;
}

// ── Stock fabricated shape catalog ───────────────────────────────────────────
// Any fab shape not in this list must go to Fabrication-1 at $0.75/lb.
// Keys are normalized: "TYPE|BARSIZE|DIM" e.g. "stirrup|#3|6x18"
const STOCK_FAB_SHAPES: Record<string, { qboNameFragment: string }> = {
  // Stirrups — #3 only, 3 sizes
  "stirrup|#3|6x18":  { qboNameFragment: "stirrup" },
  "stirrup|#3|8x18":  { qboNameFragment: "stirrup" },
  "stirrup|#3|8x24":  { qboNameFragment: "stirrup" },
  // Corner bars — 2ftx2ft only, #4/#5/#6
  "corner|#4|2x2":    { qboNameFragment: "corner bar 4" },
  "corner|#5|2x2":    { qboNameFragment: "corner bar 5" },
  "corner|#6|2x2":    { qboNameFragment: "corner bar 6" },
  // Rings — #3 only, 4 diameters
  "ring|#3|8":        { qboNameFragment: "ring" },
  "ring|#3|12":       { qboNameFragment: "ring" },
  "ring|#3|18":       { qboNameFragment: "ring" },
  "ring|#3|24":       { qboNameFragment: "ring" },
};

// Normalize dimensions: "12\"x24\"" or "12x24" or "12 x 24" -> "12x24"
function normDim(d: string): string {
  return d.replace(/"|'|ft|in|\s/gi, "").replace(/[xX×by]+/, "x").toLowerCase();
}
// Normalize bar size: "#4" "4" "no4" -> "#4"
function normBar(b: string): string {
  const m = b.match(/(\d+)/);
  return m ? `#${m[1]}` : b.toLowerCase();
}

// Check if a fab shape name matches a stock item exactly
// Returns the stock shape key if found, null if it should go to Fabrication-1
function findStockFabKey(
  shapeName: string,
  barSize: string,
  dimensions: string
): string | null {
  const bar = normBar(barSize);
  const dim = normDim(dimensions);
  const name = shapeName.toLowerCase();

  let type = "";
  if (name.includes("stirrup") || name.includes("tie")) type = "stirrup";
  else if (name.includes("corner") || name.includes("l-bar") || name.includes("l bar")) type = "corner";
  else if (name.includes("ring") || name.includes("spiral")) type = "ring";
  else return null; // unknown fab shape type → always custom

  const key = `${type}|${bar}|${dim}`;
  return STOCK_FAB_SHAPES[key] ? key : null;
}

// ── Fuzzy match a material name to QBO products ──────────────────────────────
// For rebar sizes: strict — name must mention the bar size to avoid false matches.
// For fab shapes: use findStockFabKey above; if not stock, return null (caller uses Fabrication-1).
function matchProduct(
  materialName: string,
  qty: number,
  unit: string,
  products: Product[]
): LineItem | null {
  const lower = materialName.toLowerCase();

  // Guard: never fuzzy-match fabricated shape names (stirrup, corner bar, ring, tie)
  // to non-fab products like "Placement Drawings". These must only match their
  // exact QBO name or go to Fabrication-1 via the caller.
  const isFabShape = /stirrup|corner.?bar|ring|tie|l-bar|u-bar|hook|hairpin/i.test(materialName);

  let best: Product | undefined;

  // 1. Exact name match
  best = products.find(p => p.name.toLowerCase() === lower);

  // 2. For non-fab shapes: partial match (both directions)
  if (!best && !isFabShape) {
    best = products.find(p => {
      const pn = p.name.toLowerCase();
      return pn.includes(lower) || lower.includes(pn);
    });
  }

  // 3. For fab shapes: only allow match if the QBO product name also contains a fab keyword
  if (!best && isFabShape) {
    best = products.find(p => {
      const pn = p.name.toLowerCase();
      return (pn.includes(lower) || lower.includes(pn)) &&
        /stirrup|corner|ring/i.test(pn);
    });
  }

  if (!best) return null;
  const unitPrice = best.unitPrice ?? 0;
  return {
    qboItemId: best.qboItemId,
    name: best.name,
    qty,
    unitPrice,
    amount: Math.round(qty * unitPrice * 100) / 100,
  };
}

// ── Stock bar calculation ─────────────────────────────────────────────────────
function calcStockBars(
  barSize: string,
  qty: number,
  cutLengthFt: number,
  stockLengthFt = 20
): { barsPerStock: number; stockBarsNeeded: number } {
  const barsPerStock = cutLengthFt > 0 ? Math.floor(stockLengthFt / cutLengthFt) : 1;
  const stockBarsNeeded = barsPerStock > 0 ? Math.ceil(qty / barsPerStock) : qty;
  return { barsPerStock, stockBarsNeeded };
}

// ── Unit conversion helpers ───────────────────────────────────────────────────
const VAPOR_BARRIER_SF_PER_ROLL = 2000; // 20x100 roll
const CHAIRS_PER_BAG = 500;

function isVaporBarrier(name: string): boolean {
  const l = name.toLowerCase();
  return l.includes("vapor") || l.includes("poly") || l.includes("visqueen") || l.includes("10 mil") || l.includes("10mil");
}
function isChair(name: string): boolean {
  const l = name.toLowerCase();
  return l.includes("chair") || l.includes("slab bolster") || l.includes("bar chair");
}

// ── Pass 1 prompt: raw extraction per chunk ───────────────────────────────────
// Focus: read EVERY bar mark and material. No summarizing. No totals.
const PASS1_PROMPT = `You are a structural rebar detailer reading construction plan pages.
Your ONLY job is to find and list every rebar item and material shown on these pages.

PLAN TYPES — read ALL of these carefully:
1. REBAR SHOP DRAWINGS: Named bar marks (B1, S1, T1, etc.) with size, qty, cut length.
2. FOUNDATION PLANS (post-tension or conventional): Read the PLAN LEGEND, GENERAL NOTES, and all callout bubbles. The legend explains what numbers/symbols mean. Numbered circles on plan view are strand or rebar counts.
3. BEAM/PIER DETAIL SHEETS: Read every section detail for rebar callouts ("#4 bars cont.", "2-#3 bars vertical", "#3 @ 16" loops", etc.). Read any PIER REINFORCING SCHEDULE table.
4. SLAB PLANS: Look for slab reinforcing notes, chair spacing callouts, and poly/vapor barrier area.

RULES:
- List EVERY named bar mark (B1, S1, T1, etc.) with its size, quantity, cut length, and bend description.
- For straight stock bars (no bends): list under "straightBars" with barSize and totalLinearFt.
- For fabricated/bent bars (hooks, stirrups, ties, dowels): list under "fabBars" — include mark (or description if no mark), barSize, qty (piece count), cutLengthFt, and bendDescription.
- For foundation plans: read beam detail callouts and pier schedules. Each beam type shown in a detail is typically repeated many times on the plan — extract the rebar per beam type and note the beam type.
- For pier schedules: list each pier diameter with its vertical bars and tie/loop bar as separate fabBars entries.
- For other materials (vapor barrier, poly, chairs, tie wire, stakes): list under "otherMaterials".
- CONCRETE CHAIRS: if callout says "chairs 4'-0" O.C.W." and a slab area is visible, estimate total chairs from the slab square footage.
- Do NOT skip a page just because it has no formal rebar schedule — read ALL notes and details.
- Do NOT list post-tension STRANDS as rebar (strands are not our product). DO list conventional deformed bars.
- Include the page number or sheet name in notes if visible.

Return ONLY valid JSON:
{
  "projectName": "name if visible on these pages, else null",
  "notes": ["sheet F1 — foundation plan", "post-tension slab with conventional rebar in beams and piers"],
  "straightBars": [
    {"barSize": "#5", "totalLinearFt": 120, "location": "beam top and bottom"}
  ],
  "fabBars": [
    {"mark": "B1", "barSize": "#4", "qty": 24, "cutLengthFt": 5.5, "bendDescription": "90-deg hook both ends, 4in legs"},
    {"mark": "PIER-12IN-VERT", "barSize": "#6", "qty": 6, "cutLengthFt": 10, "bendDescription": "straight vertical, 12in pier"},
    {"mark": "PIER-12IN-LOOP", "barSize": "#3", "qty": 20, "cutLengthFt": 3.5, "bendDescription": "closed loop tie @ 16in spacing"}
  ],
  "otherMaterials": [
    {"name": "concrete chairs", "qty": 500, "unit": "EA"},
    {"name": "10 mil poly", "qty": 2000, "unit": "SF"}
  ]
}`;

// ── Pass 2 prompt: consolidation ──────────────────────────────────────────────
// Takes all chunk JSONs as input, produces the final complete cut sheet.
function buildPass2Prompt(chunkDataJson: string): string {
  return `You are a structural rebar estimator. You have received raw takeoff data extracted from ${JSON.parse(chunkDataJson).length} sections of a plan set.

Your job is to consolidate this data into a single accurate cut sheet:
1. MERGE duplicate bar marks across sections — if B1 appears in multiple sections, sum the quantities.
2. TOTAL all straight bars by size — sum all totalLinearFt for each bar size.
3. PRESERVE all unique fab bar marks with their full specs.
4. COMBINE other materials by type.
5. Use the project name from the first section that has one.

Here is the raw chunk data:
${chunkDataJson}

BAR WEIGHTS (lb/ft): #3=0.376, #4=0.668, #5=1.043, #6=1.502, #7=2.044, #8=2.670, #9=3.400, #10=4.303, #11=5.313

Return ONLY valid JSON in this exact format:
{
  "projectName": "Ascension Cottages",
  "notes": ["summary notes about the plan set"],
  "standardRebar": [
    {"barSize": "#5", "totalLinearFt": 840}
  ],
  "fabRebar": [
    {"mark": "B1", "barSize": "#4", "qty": 48, "cutLengthFt": 5.5, "bendDescription": "90-deg hook both ends, 4in legs"}
  ],
  "otherMaterials": [
    {"name": "10 mil poly", "qty": 4000, "unit": "SF"}
  ]
}`;
}

// ── Helper: call Responses API with inline base64 PDF ────────────────────────
async function callResponsesApi(
  client: OpenAI,
  chunkBytes: Uint8Array,
  chunkIndex: number,
  totalChunks: number,
  promptText: string,
  chunkLabel: string
): Promise<string> {
  const b64 = Buffer.from(chunkBytes).toString("base64");
  const mb = Math.round(chunkBytes.length / 1024 / 1024 * 10) / 10;
  console.log(`[Takeoff] ${chunkLabel} (${mb}MB inline)`);

  const inputContent: any[] = [
    { type: "input_text", text: promptText },
    { type: "input_file", filename: `plan-chunk-${chunkIndex + 1}.pdf`, file_data: `data:application/pdf;base64,${b64}` },
    { type: "input_text", text: `This is chunk ${chunkIndex + 1} of ${totalChunks} from the plan set. Read EVERY page carefully and report all rebar marks and materials you see. Return JSON only.` },
  ];

  let rawText = "";
  let attempts = 0;
  while (attempts < 5) {
    try {
      const response = await client.responses.create({
        model: "gpt-4o",
        input: [{ role: "user", content: inputContent }],
        text: { format: { type: "json_object" } },
        max_output_tokens: 6000,
        temperature: 0,
      } as any);

      const output = (response as any).output;
      if (Array.isArray(output)) {
        for (const item of output) {
          if (item.type === "message" && Array.isArray(item.content)) {
            for (const part of item.content) {
              if (part.type === "output_text") rawText += part.text;
            }
          }
        }
      }
      break;
    } catch (err: any) {
      if (err?.status === 429 || err?.code === "rate_limit_exceeded") {
        const match = err?.message?.match(/(\d+\.?\d*)\s*s\b/);
        const waitSec = match ? Math.ceil(parseFloat(match[1])) + 5 : 65;
        console.log(`[Takeoff] Rate limited on ${chunkLabel}, waiting ${waitSec}s...`);
        await new Promise(r => setTimeout(r, waitSec * 1000));
        attempts++;
      } else {
        throw err;
      }
    }
  }
  return rawText;
}

// ── Pass 2: consolidation via Chat Completions (text only, no PDF) ────────────
async function runConsolidationPass(client: OpenAI, chunkRaws: any[]): Promise<any> {
  const chunkDataJson = JSON.stringify(chunkRaws, null, 2);
  const prompt = buildPass2Prompt(chunkDataJson);
  console.log(`[Takeoff] Pass 2: consolidating ${chunkRaws.length} chunk(s)...`);

  let attempts = 0;
  while (attempts < 5) {
    try {
      const response = await client.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: "You are a rebar estimator. Consolidate the provided raw takeoff data into a single accurate cut sheet. Return only valid JSON." },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
        max_tokens: 6000,
        temperature: 0,
      });
      try { return JSON.parse(response.choices[0].message.content || "{}"); } catch { return {}; }
    } catch (err: any) {
      if (err?.status === 429 || err?.code === "rate_limit_exceeded") {
        const match = err?.message?.match(/(\d+\.?\d*)\s*s\b/);
        const waitSec = match ? Math.ceil(parseFloat(match[1])) + 5 : 65;
        console.log(`[Takeoff] Pass 2 rate limited, waiting ${waitSec}s...`);
        await new Promise(r => setTimeout(r, waitSec * 1000));
        attempts++;
      } else {
        throw err;
      }
    }
  }
  return {};
}

// ── Build line items + fab items from consolidated cut sheet ─────────────────
function buildFromCutSheet(consolidated: any, products: Product[]): TakeoffResult {
  const lineItems: LineItem[] = [];
  const fabItems: FabItem[] = [];
  const takeoffNotes: string[] = consolidated.notes || [];
  const projectName: string = consolidated.projectName || "Customer Takeoff";

  // ── Standard (straight stock) rebar ──────────────────────────────────────
  for (const sr of (consolidated.standardRebar || [])) {
    const barSize: string = sr.barSize || "#4";
    const totalLF: number = parseFloat(sr.totalLinearFt) || 0;
    const stockLen = 20;
    const stockBarsNeeded = Math.ceil(totalLF / stockLen);
    const weightPerFt = BAR_WEIGHT[barSize] ?? 0.668;
    const totalWeight = Math.round(totalLF * weightPerFt * 100) / 100;
    const desc = `${barSize} • ${totalLF} LF total • ${stockBarsNeeded} bars @ 20' • ${totalWeight} lbs`;

    const matched = matchProduct(sr.productName || barSize, stockBarsNeeded, "EA", products);
    if (matched) {
      lineItems.push({ ...matched, description: desc });
    } else {
      lineItems.push({ qboItemId: "CUSTOM", name: `${barSize} Rebar (20' stock)`, description: desc, qty: stockBarsNeeded, unitPrice: 0, amount: 0 });
    }
    fabItems.push({
      mark: `S-${barSize.replace("#", "")}`,
      barSize, qty: stockBarsNeeded, lengthFt: stockLen,
      totalLF: stockBarsNeeded * stockLen, weightLbs: totalWeight,
      bendDescription: "Straight — stock length", stockLengthFt: stockLen,
      barsPerStock: 1, stockBarsNeeded,
    });
  }

  // ── Fabricated rebar ──────────────────────────────────────────────────────
  for (const fr of (consolidated.fabRebar || [])) {
    const barSize: string = fr.barSize || "#4";
    const qty: number = parseInt(fr.qty) || 1;
    const cutLengthFt: number = parseFloat(fr.cutLengthFt) || 2;
    const weightPerFt = BAR_WEIGHT[barSize] ?? 0.668;
    const totalLF = qty * cutLengthFt;
    const totalWeight = Math.round(totalLF * weightPerFt * 100) / 100;
    const priceLbs = Math.round(totalWeight * 0.75 * 100) / 100;
    const { barsPerStock, stockBarsNeeded } = calcStockBars(barSize, qty, cutLengthFt);
    const mark = fr.mark || `F${fabItems.length + 1}`;
    const bendDesc = fr.bendDescription || "Custom bend";
    const desc = `Mark: ${mark} | ${barSize} | Qty: ${qty} pc | Cut length: ${cutLengthFt}' | ${bendDesc} | ${totalWeight} lbs total`;

    const fabProduct = products.find(p => p.name.toLowerCase().includes("fabrication-1") || p.name.toLowerCase() === "fabrication-1");
    lineItems.push({
      qboItemId: fabProduct?.qboItemId || "FAB-1",
      name: "Fabrication-1",
      description: desc,
      qty: totalWeight,
      unitPrice: 0.75,
      amount: priceLbs,
    });
    fabItems.push({ mark, barSize, qty, lengthFt: cutLengthFt, totalLF, weightLbs: totalWeight, bendDescription: bendDesc, stockLengthFt: 20, barsPerStock, stockBarsNeeded });
  }

  // ── Other materials ───────────────────────────────────────────────────────
  for (const om of (consolidated.otherMaterials || [])) {
    const rawQty = parseFloat(om.qty) || 1;
    const unit: string = (om.unit || "EA").toUpperCase();
    const matName: string = om.productName || om.name || "";

    let qty = rawQty;
    let desc = "";
    if (isVaporBarrier(matName) && unit === "SF") {
      const rolls = Math.ceil(rawQty / VAPOR_BARRIER_SF_PER_ROLL);
      desc = `10 mil poly • ${rawQty.toLocaleString()} SF required • ${rolls} roll(s) @ 20×100 (2,000 SF/roll)`;
      qty = rolls;
    } else if (isChair(matName) && (unit === "EA" || unit === "PC" || unit === "PCS")) {
      const bags = Math.ceil(rawQty / CHAIRS_PER_BAG);
      desc = `${rawQty} pc required • ${bags} bag(s) @ 500 pc/bag`;
      qty = bags;
    } else {
      desc = `${rawQty} ${unit}`;
    }

    const matched = matchProduct(matName, qty, unit, products);
    if (matched) {
      lineItems.push({ ...matched, description: desc });
    } else {
      lineItems.push({ qboItemId: "CUSTOM", name: om.name || matName, description: desc, qty, unitPrice: 0, amount: 0 });
    }
  }

  return { lineItems, fabItems, takeoffNotes, projectName };
}

// ── Core takeoff function ────────────────────────────────────────────────────
export async function performTakeoff(
  mediaItems: string[],
  products: Product[]
): Promise<TakeoffResult> {
  const pdfUrls = mediaItems.filter(u => u.startsWith("pdf::")).map(u => u.slice(5));
  const imageUrls = mediaItems.filter(u => !u.startsWith("pdf::") && !u.startsWith("__"));

  if (pdfUrls.length > 0) {
    const MAX_CHUNK_BYTES = 38 * 1024 * 1024;
    console.log(`[Takeoff] Downloading ${pdfUrls.length} PDF(s) for two-pass processing`);
    const client = getClient();
    const { PDFDocument } = await import("pdf-lib");

    const readyChunks: Uint8Array[] = [];

    for (const pdfUrl of pdfUrls) {
      console.log(`[Takeoff] Downloading PDF: ${pdfUrl.substring(0, 80)}...`);
      const dlResp = await globalThis.fetch(pdfUrl, {
        headers: { "User-Agent": "RCPBot/1.0" },
        redirect: "follow",
      });
      if (!dlResp.ok) throw new Error(`HTTP ${dlResp.status} downloading PDF`);
      const pdfBuffer = Buffer.from(await dlResp.arrayBuffer());
      console.log(`[Takeoff] PDF downloaded: ${pdfBuffer.length} bytes`);

      if (pdfBuffer.length <= MAX_CHUNK_BYTES) {
        console.log(`[Takeoff] PDF fits in one chunk (${Math.round(pdfBuffer.length / 1024 / 1024 * 10) / 10}MB)`);
        readyChunks.push(new Uint8Array(pdfBuffer));
      } else {
        console.log(`[Takeoff] PDF too large (${pdfBuffer.length} bytes), splitting adaptively...`);
        const srcPdf = await PDFDocument.load(pdfBuffer);
        const totalPages = srcPdf.getPageCount();
        console.log(`[Takeoff] PDF has ${totalPages} pages, splitting adaptively`);

        const segments: Array<[number, number]> = [[0, totalPages]];
        while (segments.length > 0) {
          const [start, end] = segments.shift()!;
          const pageIndices = Array.from({ length: end - start }, (_, i) => start + i);
          const chunkPdf = await PDFDocument.create();
          const copiedPages = await chunkPdf.copyPages(srcPdf, pageIndices);
          copiedPages.forEach(p => chunkPdf.addPage(p));
          const chunkBytes = await chunkPdf.save();
          const mb = Math.round(chunkBytes.length / 1024 / 1024 * 10) / 10;

          if (chunkBytes.length > MAX_CHUNK_BYTES && (end - start) > 1) {
            const mid = Math.floor((start + end) / 2);
            console.log(`[Takeoff] Pages ${start + 1}-${end} = ${mb}MB > limit, halving into ${start + 1}-${mid} and ${mid + 1}-${end}`);
            segments.unshift([mid, end]);
            segments.unshift([start, mid]);
          } else {
            console.log(`[Takeoff] Segment pages ${start + 1}-${end} = ${mb}MB — OK`);
            readyChunks.push(chunkBytes);
          }
        }
      }
    }
    console.log(`[Takeoff] ${readyChunks.length} chunk(s) ready — starting Pass 1 (raw extraction)`);

    // ── Pass 1: raw extraction per chunk ──────────────────────────────────────
    const chunkRaws: any[] = [];
    for (let i = 0; i < readyChunks.length; i++) {
      const rawText = await callResponsesApi(
        client,
        readyChunks[i],
        i,
        readyChunks.length,
        PASS1_PROMPT,
        `[Takeoff] Pass 1 chunk ${i + 1}/${readyChunks.length}`
      );
      console.log(`[Takeoff] Pass 1 chunk ${i + 1} response: ${rawText.length} chars`);
      console.log(`[Takeoff] Pass 1 chunk ${i + 1} raw: ${rawText.substring(0, 500)}`);
      try { chunkRaws.push(JSON.parse(rawText || "{}")); } catch { chunkRaws.push({}); }
    }

    // ── Pass 2: consolidation (text only, no PDF needed) ─────────────────────
    const consolidated = await runConsolidationPass(client, chunkRaws);
    console.log(`[Takeoff] Pass 2 complete — ${consolidated.standardRebar?.length || 0} straight bar size(s), ${consolidated.fabRebar?.length || 0} fab mark(s), ${consolidated.otherMaterials?.length || 0} other material(s)`);

    return buildFromCutSheet(consolidated, products);

  } else {
    // ── Image fallback: Chat Completions with image_url parts ─────────────────
    console.log(`[Takeoff] Using Chat Completions for ${imageUrls.length} image(s)`);
    const client = getClient();

    const productList = products.map(p => `- "${p.name}"`).join("\n");
    const systemPrompt = `You are an expert construction estimator for Rebar Concrete Products (McKinney, TX). Perform a complete material takeoff from the plan images and return structured JSON.\n\nAVAILABLE QBO PRODUCTS:\n${productList}\n\nBAR WEIGHTS (lb/ft): #3=0.376, #4=0.668, #5=1.043, #6=1.502, #7=2.044, #8=2.670, #9=3.400, #10=4.303\n\nReturn JSON: { "projectName": "...", "notes": [], "standardRebar": [{"barSize":"#4","totalLinearFt":240,"productName":"..."}], "fabRebar": [{"mark":"B1","barSize":"#4","qty":12,"cutLengthFt":4.5,"bendDescription":"...","productName":"Fabrication-1"}], "otherMaterials": [{"name":"...","qty":500,"unit":"SF","productName":"..."}] }`;

    const contentParts: OpenAI.Chat.ChatCompletionContentPart[] = [
      { type: "text", text: `Here are ${imageUrls.length} page(s) of the plan set. Perform a complete material takeoff.` },
    ];
    for (const url of imageUrls) {
      contentParts.push({ type: "image_url", image_url: { url, detail: "high" } });
    }

    const response = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: contentParts },
      ],
      response_format: { type: "json_object" },
      max_tokens: 6000,
      temperature: 0,
    });

    let raw: any = {};
    try { raw = JSON.parse(response.choices[0].message.content || "{}"); } catch { raw = {}; }
    return buildFromCutSheet(raw, products);
  }
}
