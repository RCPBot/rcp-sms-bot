/**
 * AI Takeoff Engine
 * Reads plan page images (or PDFs) with GPT-4o Vision and extracts a full material takeoff.
 * Returns line items matched to QBO products, fabrication cut-sheet items,
 * notes, and a project name.
 *
 * PDF inputs use the OpenAI Responses API with input_file (file_url) — no system binary needed.
 * Image inputs use the Chat Completions API with image_url content parts.
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

// ── Fuzzy match a material name to QBO products ──────────────────────────────
function matchProduct(
  materialName: string,
  qty: number,
  unit: string,
  products: Product[]
): LineItem | null {
  const lower = materialName.toLowerCase();
  // Try direct name match first
  let best = products.find(p => p.name.toLowerCase() === lower);
  // Fallback: partial match
  if (!best) {
    best = products.find(p => {
      const pn = p.name.toLowerCase();
      return pn.includes(lower) || lower.includes(pn);
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

// ── Build the system prompt ──────────────────────────────────────────────────
function buildSystemPrompt(products: Product[]): string {
  const productList = products
    .map(p => `- "${p.name}"${p.description ? ": " + p.description : ""}`)
    .join("\n");

  return `You are an expert construction estimator specializing in rebar and concrete supply for Rebar Concrete Products (McKinney, TX).

You will receive a customer's plan set (as images or a PDF). Your job is to perform a COMPLETE material takeoff and return structured JSON.

RULES:
1. Extract EVERY piece of rebar, vapor barrier, concrete chair, forming lumber, stakes, tie wire, and any other material visible in the plans.
2. For standard/straight rebar that can ship as stock 20-ft bars: list under "standardRebar".
3. For any custom bent/fabricated rebar (L-bars, U-bars, hooks, stirrups, spirals, hairpins, etc.): list under "fabRebar".
4. For all other materials (vapor barrier, chairs, forming lumber, duplex nails, stakes, tie wire, etc.): list under "otherMaterials".
5. For standardRebar: calculate totalLinearFeet needed for each bar size across the entire job. Prefer 20-ft stock lengths.
6. For fabRebar: include exact cut length, quantity, bend description, and bar size.
7. Match material names EXACTLY to products in the available QBO product list where possible.
8. If no exact match exists in the product list, use the closest name.

AVAILABLE QBO PRODUCTS:
${productList}

BAR WEIGHTS (lb/ft): #3=0.376, #4=0.668, #5=1.043, #6=1.502, #7=2.044, #8=2.670, #9=3.400, #10=4.303

Return ONLY valid JSON in exactly this format:
{
  "projectName": "project name if visible, else 'Customer Takeoff'",
  "notes": ["note about page 1", "note about page 2", ...],
  "standardRebar": [
    {"barSize": "#4", "totalLinearFt": 240, "productName": "Rebar #4 (20' Stock)"}
  ],
  "fabRebar": [
    {"mark": "B1", "barSize": "#4", "qty": 12, "cutLengthFt": 4.5, "bendDescription": "90-deg hook, 6in leg", "productName": "Fabrication-1"}
  ],
  "otherMaterials": [
    {"name": "Vapor Barrier 10 mil", "qty": 500, "unit": "SF", "productName": "Vapor Barrier 10 mil"}
  ]
}`;
}

// ── Parse raw JSON into TakeoffResult ────────────────────────────────────────
function parseRawTakeoff(raw: any, products: Product[]): TakeoffResult {
  const lineItems: LineItem[] = [];
  const fabItems: FabItem[] = [];
  const takeoffNotes: string[] = raw.notes || [];
  const projectName: string = raw.projectName || "Customer Takeoff";

  // ── Process standard rebar → stock bars ──────────────────────────────────
  for (const sr of (raw.standardRebar || [])) {
    const barSize: string = sr.barSize || "#4";
    const totalLF: number = parseFloat(sr.totalLinearFt) || 0;
    const stockLen = 20;
    const stockBarsNeeded = Math.ceil(totalLF / stockLen);
    const weightPerFt = BAR_WEIGHT[barSize] ?? 0.668;
    const totalWeight = Math.round(totalLF * weightPerFt * 100) / 100;

    // Try to match to a QBO product by product name or bar size
    const matched = matchProduct(sr.productName || barSize, stockBarsNeeded, "EA", products);
    if (matched) {
      lineItems.push(matched);
    } else {
      // Not matched — add as custom note item
      lineItems.push({
        qboItemId: "CUSTOM",
        name: `${barSize} Rebar (20' stock) — ${stockBarsNeeded} bars / ${totalLF} LF`,
        qty: stockBarsNeeded,
        unitPrice: 0,
        amount: 0,
      });
    }
    // Record fab-style row for the cut sheet (straight stock)
    fabItems.push({
      mark: `S-${barSize.replace("#", "")}`,
      barSize,
      qty: stockBarsNeeded,
      lengthFt: stockLen,
      totalLF: stockBarsNeeded * stockLen,
      weightLbs: totalWeight,
      bendDescription: "Straight — stock length",
      stockLengthFt: stockLen,
      barsPerStock: 1,
      stockBarsNeeded,
    });
  }

  // ── Process fabricated rebar ──────────────────────────────────────────────
  for (const fr of (raw.fabRebar || [])) {
    const barSize: string = fr.barSize || "#4";
    const qty: number = parseInt(fr.qty) || 1;
    const cutLengthFt: number = parseFloat(fr.cutLengthFt) || 2;
    const weightPerFt = BAR_WEIGHT[barSize] ?? 0.668;
    const totalLF = qty * cutLengthFt;
    const totalWeight = Math.round(totalLF * weightPerFt * 100) / 100;
    const priceLbs = Math.round(totalWeight * 0.75 * 100) / 100; // $0.75/lb

    const { barsPerStock, stockBarsNeeded } = calcStockBars(barSize, qty, cutLengthFt);

    // Find Fabrication-1 item in products
    const fabProduct = products.find(p => p.name.toLowerCase().includes("fabrication-1") || p.name.toLowerCase() === "fabrication-1");
    lineItems.push({
      qboItemId: fabProduct?.qboItemId || "FAB-1",
      name: `Fabrication-1: ${fr.mark || "Fab"} ${barSize} ${fr.bendDescription || "custom bend"}`,
      qty: totalWeight, // priced by weight in QBO
      unitPrice: 0.75,
      amount: priceLbs,
    });

    fabItems.push({
      mark: fr.mark || `F${fabItems.length + 1}`,
      barSize,
      qty,
      lengthFt: cutLengthFt,
      totalLF,
      weightLbs: totalWeight,
      bendDescription: fr.bendDescription || "Custom bend",
      stockLengthFt: 20,
      barsPerStock,
      stockBarsNeeded,
    });
  }

  // ── Process other materials ───────────────────────────────────────────────
  for (const om of (raw.otherMaterials || [])) {
    const qty = parseFloat(om.qty) || 1;
    const matched = matchProduct(om.productName || om.name, qty, om.unit || "EA", products);
    if (matched) {
      lineItems.push(matched);
    } else {
      lineItems.push({
        qboItemId: "CUSTOM",
        name: `${om.name} — ${qty} ${om.unit || "EA"}`,
        qty,
        unitPrice: 0,
        amount: 0,
      });
    }
  }

  return { lineItems, fabItems, takeoffNotes, projectName };
}

// ── Core takeoff function ────────────────────────────────────────────────────
// mediaItems: array of URL strings. PDF URLs are prefixed with "pdf::"
export async function performTakeoff(
  mediaItems: string[],
  products: Product[]
): Promise<TakeoffResult> {
  const systemPrompt = buildSystemPrompt(products);

  // Separate PDFs from images
  const pdfUrls = mediaItems.filter(u => u.startsWith("pdf::")).map(u => u.slice(5));
  const imageUrls = mediaItems.filter(u => !u.startsWith("pdf::") && !u.startsWith("__"));

  if (pdfUrls.length > 0) {
    // ── Use Responses API with input_file (file_id) ──────────────────────────
    // Download the PDF ourselves, upload to OpenAI Files API, then pass file_id.
    // This avoids OpenAI needing to fetch from Dropbox (which blocks server requests).
    console.log(`[Takeoff] Downloading and uploading ${pdfUrls.length} PDF(s) to OpenAI Files API`);
    const client = getClient();
    const uploadedFileIds: string[] = [];

    for (const pdfUrl of pdfUrls) {
      console.log(`[Takeoff] Downloading PDF: ${pdfUrl.substring(0, 80)}...`);
      const dlResp = await globalThis.fetch(pdfUrl, {
        headers: { "User-Agent": "RCPBot/1.0" },
        redirect: "follow",
      });
      if (!dlResp.ok) throw new Error(`HTTP ${dlResp.status} downloading PDF`);
      const pdfBuffer = Buffer.from(await dlResp.arrayBuffer());
      console.log(`[Takeoff] PDF downloaded: ${pdfBuffer.length} bytes — uploading to OpenAI`);

      // Upload to OpenAI Files API
      const { toFile } = await import("openai");
      const fileObj = await toFile(pdfBuffer, "plan.pdf", { type: "application/pdf" });
      const uploaded = await client.files.create({
        file: fileObj,
        purpose: "user_data",
      });
      console.log(`[Takeoff] Uploaded to OpenAI Files API: ${uploaded.id}`);
      uploadedFileIds.push(uploaded.id);
    }

    // Build input content parts: system text + each PDF file_id + instruction
    const inputContent: any[] = [
      {
        type: "input_text",
        text: systemPrompt,
      },
    ];

    for (const fileId of uploadedFileIds) {
      inputContent.push({
        type: "input_file",
        file_id: fileId,
      });
    }

    inputContent.push({
      type: "input_text",
      text: `Here ${uploadedFileIds.length === 1 ? "is" : "are"} ${uploadedFileIds.length} PDF plan set(s). Please perform a complete material takeoff for rebar, vapor barrier, chairs, forming lumber, stakes, tie wire, and anything else that matches our product catalog. Be thorough — examine every page carefully.`,
    });

    let rawText = "";
    try {
      const response = await client.responses.create({
        model: "gpt-4o",
        input: [
          {
            role: "user",
            content: inputContent,
          },
        ],
        text: { format: { type: "json_object" } },
        max_output_tokens: 4000,
        temperature: 0,
      } as any);

      // Extract text from response
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
    } finally {
      // Clean up uploaded files from OpenAI (fire-and-forget)
      for (const fileId of uploadedFileIds) {
        client.files.delete(fileId).catch(err =>
          console.warn(`[Takeoff] Failed to delete OpenAI file ${fileId}: ${err?.message}`)
        );
      }
    }

    let raw: any = {};
    try { raw = JSON.parse(rawText || "{}"); } catch { raw = {}; }
    return parseRawTakeoff(raw, products);

  } else {
    // ── Use Chat Completions API with image_url content parts ───────────────
    console.log(`[Takeoff] Using Chat Completions for ${imageUrls.length} image(s)`);
    const contentParts: OpenAI.Chat.ChatCompletionContentPart[] = [
      {
        type: "text",
        text: `Here are ${imageUrls.length} page(s) of the customer's plan set. Please perform a complete material takeoff for rebar, vapor barrier, chairs, forming lumber, stakes, tie wire, and anything else that matches our product catalog. Be thorough — examine every page carefully.`,
      },
    ];
    for (const url of imageUrls) {
      contentParts.push({ type: "image_url", image_url: { url, detail: "high" } });
    }

    const response = await getClient().chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: contentParts },
      ],
      response_format: { type: "json_object" },
      max_tokens: 4000,
      temperature: 0,
    });

    let raw: any = {};
    try {
      raw = JSON.parse(response.choices[0].message.content || "{}");
    } catch {
      raw = {};
    }
    return parseRawTakeoff(raw, products);
  }
}
