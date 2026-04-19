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
    // Download the PDF ourselves, split into <40MB chunks, upload each chunk,
    // then pass all file_ids to the Responses API.
    // OpenAI Responses API limit: 50MB per file / 50MB total across all files.
    const MAX_CHUNK_BYTES = 38 * 1024 * 1024; // 38MB to stay safely under 50MB limit
    console.log(`[Takeoff] Downloading and uploading ${pdfUrls.length} PDF(s) to OpenAI Files API`);
    const client = getClient();
    const uploadedFileIds: string[] = [];
    const { toFile } = await import("openai");
    const { PDFDocument } = await import("pdf-lib");

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
        // Small enough — upload directly
        const fileObj = await toFile(pdfBuffer, "plan.pdf", { type: "application/pdf" });
        const uploaded = await client.files.create({ file: fileObj, purpose: "user_data" });
        console.log(`[Takeoff] Uploaded chunk to OpenAI: ${uploaded.id}`);
        uploadedFileIds.push(uploaded.id);
      } else {
        // Too large — split into page chunks using pdf-lib
        // We split adaptively: if a chunk is still too big after saving, halve it.
        console.log(`[Takeoff] PDF too large (${pdfBuffer.length} bytes), splitting into chunks...`);
        const srcPdf = await PDFDocument.load(pdfBuffer);
        const totalPages = srcPdf.getPageCount();
        console.log(`[Takeoff] PDF has ${totalPages} pages, splitting adaptively`);

        // Build list of page-range segments to process (start inclusive, end exclusive)
        // Uses a queue: if a segment's rendered PDF is too big, split it in half.
        const segments: Array<[number, number]> = [[0, totalPages]];
        const readyChunks: Uint8Array[] = [];

        while (segments.length > 0) {
          const [start, end] = segments.shift()!;
          const pageIndices = Array.from({ length: end - start }, (_, i) => start + i);
          const chunkPdf = await PDFDocument.create();
          const copiedPages = await chunkPdf.copyPages(srcPdf, pageIndices);
          copiedPages.forEach(p => chunkPdf.addPage(p));
          const chunkBytes = await chunkPdf.save();
          const mb = Math.round(chunkBytes.length / 1024 / 1024 * 10) / 10;

          if (chunkBytes.length > MAX_CHUNK_BYTES && (end - start) > 1) {
            // Still too big — split in half and re-queue
            const mid = Math.floor((start + end) / 2);
            console.log(`[Takeoff] Pages ${start + 1}-${end} = ${mb}MB > limit, halving into ${start+1}-${mid} and ${mid+1}-${end}`);
            segments.unshift([mid, end]);
            segments.unshift([start, mid]);
          } else {
            console.log(`[Takeoff] Segment pages ${start + 1}-${end} = ${mb}MB — OK`);
            readyChunks.push(chunkBytes);
          }
        }

        // Upload all approved chunks
        for (let i = 0; i < readyChunks.length; i++) {
          const fileObj = await toFile(Buffer.from(readyChunks[i]), `plan-chunk-${i + 1}.pdf`, { type: "application/pdf" });
          const uploaded = await client.files.create({ file: fileObj, purpose: "user_data" });
          console.log(`[Takeoff] Uploaded chunk ${i + 1}/${readyChunks.length} to OpenAI: ${uploaded.id}`);
          uploadedFileIds.push(uploaded.id);
        }
      }
    }

    // Process each file_id separately (Responses API 50MB total limit per request)
    // Then merge all partial takeoff JSONs into one combined result.
    const allPartialRaws: any[] = [];
    try {
      for (let i = 0; i < uploadedFileIds.length; i++) {
        const fileId = uploadedFileIds[i];
        console.log(`[Takeoff] Running Responses API for chunk ${i + 1}/${uploadedFileIds.length} (file: ${fileId})`);
        const inputContent: any[] = [
          {
            type: "input_text",
            text: systemPrompt,
          },
          {
            type: "input_file",
            file_id: fileId,
          },
          {
            type: "input_text",
            text: `This is chunk ${i + 1} of ${uploadedFileIds.length} from the customer's plan set (large PDFs are split into chunks). Perform a complete material takeoff for rebar, vapor barrier, chairs, forming lumber, stakes, tie wire, and anything else visible. Be thorough — examine every page carefully. Return JSON in the exact format specified.`,
          },
        ];

        let rawText = "";
        // Retry loop for rate limit errors
        let attempts = 0;
        while (attempts < 5) {
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
            break; // success
          } catch (err: any) {
            if (err?.status === 429 || err?.code === 'rate_limit_exceeded') {
              // Parse retry-after from error message, default 60s
              const match = err?.message?.match(/(\d+\.?\d*)\s*s\b/);
              const waitSec = match ? Math.ceil(parseFloat(match[1])) + 5 : 65;
              console.log(`[Takeoff] Rate limited on chunk ${i + 1}, waiting ${waitSec}s before retry...`);
              await new Promise(r => setTimeout(r, waitSec * 1000));
              attempts++;
            } else {
              throw err;
            }
          }
        }
        console.log(`[Takeoff] Chunk ${i + 1} response length: ${rawText.length} chars`);
        try { allPartialRaws.push(JSON.parse(rawText || "{}")); } catch { allPartialRaws.push({}); }
      }
    } finally {
      // Clean up uploaded files from OpenAI (fire-and-forget)
      for (const fileId of uploadedFileIds) {
        client.files.delete(fileId).catch(err =>
          console.warn(`[Takeoff] Failed to delete OpenAI file ${fileId}: ${err?.message}`)
        );
      }
    }

    // Merge all partial results into one combined raw takeoff
    const merged: any = {
      projectName: allPartialRaws.find(r => r.projectName && r.projectName !== "Customer Takeoff")?.projectName || allPartialRaws[0]?.projectName || "Customer Takeoff",
      notes: allPartialRaws.flatMap(r => r.notes || []),
      standardRebar: allPartialRaws.flatMap(r => r.standardRebar || []),
      fabRebar: allPartialRaws.flatMap(r => r.fabRebar || []),
      otherMaterials: allPartialRaws.flatMap(r => r.otherMaterials || []),
    };

    // Consolidate duplicate bar sizes in standardRebar (sum totalLinearFt)
    const rebarMap = new Map<string, { barSize: string; totalLinearFt: number; productName: string }>();
    for (const sr of merged.standardRebar) {
      const key = sr.barSize;
      if (rebarMap.has(key)) {
        rebarMap.get(key)!.totalLinearFt += parseFloat(sr.totalLinearFt) || 0;
      } else {
        rebarMap.set(key, { barSize: sr.barSize, totalLinearFt: parseFloat(sr.totalLinearFt) || 0, productName: sr.productName });
      }
    }
    merged.standardRebar = Array.from(rebarMap.values());
    console.log(`[Takeoff] Merged ${allPartialRaws.length} chunks → ${merged.standardRebar.length} rebar sizes, ${merged.fabRebar.length} fab items, ${merged.otherMaterials.length} other materials`);

    return parseRawTakeoff(merged, products);

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
