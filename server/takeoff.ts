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
import Anthropic from "@anthropic-ai/sdk";
import type { Product, LineItem, FabItem } from "@shared/schema";

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-5";
const CLAUDE_FALLBACK_MODEL = "claude-3-5-sonnet-20241022";

const FABRICATION_QBO_ID = "1010000301";

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

// ── Dedicated fuzzy matcher for stock rebar bars ─────────────────────────────
// QBO names for stock bars vary ("Rebar #5 20' Stock", "#5 Rebar 20ft", etc),
// so matchProduct's strict rules fail. This matcher loosens requirements:
// must contain the bar size + the stock length + a "rebar/bar/steel" word,
// and must not be a fab shape (stirrup, corner, ring, etc).
function matchStockRebarProduct(
  size: string,
  stockLen: number,
  qty: number,
  products: Product[]
): LineItem | null {
  const sizeNum = size.replace('#', '').trim();
  const lenStr = String(stockLen);

  const candidates = products.filter(p => {
    const pn = p.name.toLowerCase();
    const hasSize = pn.includes(`#${sizeNum}`) || pn.includes(`no${sizeNum}`) || pn.includes(`no. ${sizeNum}`);
    const hasLen = pn.includes(`${lenStr}'`) || pn.includes(`${lenStr} ft`) || pn.includes(`${lenStr}ft`) || pn.includes(`${lenStr} '`) || pn.includes(`${lenStr}-ft`);
    const isRebar = pn.includes('rebar') || pn.includes('bar') || pn.includes('steel');
    const isFabShape = /stirrup|corner|ring|tie|l-bar|u-bar|hook|hairpin/i.test(pn);
    return hasSize && hasLen && isRebar && !isFabShape;
  });

  if (candidates.length === 0) return null;
  const best = candidates.find(p => p.name.toLowerCase().includes(`${lenStr}'`)) || candidates[0];
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
const CHAIRS_PER_BAG = 500;

function isVaporBarrier(name: string): boolean {
  const l = name.toLowerCase();
  return l.includes("vapor") || l.includes("poly") || l.includes("visqueen") || l.includes(" mil");
}
function isWireChair(name: string): boolean {
  const l = name.toLowerCase();
  // Wire/plastic chairs sold in 500-pc bags
  return (l.includes("chair") && !l.includes("dobie")) || l.includes("slab bolster") || l.includes("bar chair");
}
function isDobie(name: string): boolean {
  const l = name.toLowerCase();
  return l.includes("dobie") || l.includes("dobie brick") || l.includes("concrete block chair") || l.includes("concrete brick");
}
// Keep isChair as a combined alias for backward compat
function isChair(name: string): boolean {
  return isWireChair(name) || isDobie(name);
}

// Match a dobie brick to the right QBO product
function matchDobieProduct(qty: number, products: Product[]): LineItem | null {
  // Default to Dobie Brick 3"x3"x2" at $0.55
  const best = products.find(p => p.name.toLowerCase().includes("dobie brick"));
  if (!best) return null;
  return {
    qboItemId: best.qboItemId,
    name: best.name,
    qty,
    unitPrice: best.unitPrice ?? 0.55,
    amount: Math.round(qty * (best.unitPrice ?? 0.55) * 100) / 100,
  };
}

// Parse poly mil thickness and roll size from a material name like "6 mil poly 32x100" or "10mil"
// Returns the best-matching QBO product name fragment to search for
function matchPolyProduct(matName: string, qty: number, products: Product[]): LineItem | null {
  const l = matName.toLowerCase();

  // Detect mil thickness
  let mil = 10; // default
  const milMatch = l.match(/(\d+)\s*mil/);
  if (milMatch) mil = parseInt(milMatch[1]);

  // Detect roll width (32 or 20)
  let width = 20; // default
  if (l.includes("32")) width = 32;

  // Build search fragment: e.g. "Poly 6 Mil 32x100"
  const fragment = `poly ${mil} mil ${width}x`;
  const best = products.find(p => p.name.toLowerCase().includes(fragment));
  if (best) {
    return {
      qboItemId: best.qboItemId,
      name: best.name,
      qty,
      unitPrice: best.unitPrice ?? 0,
      amount: Math.round(qty * (best.unitPrice ?? 0) * 100) / 100,
    };
  }

  // Fallback: just match by mil thickness
  const milFragment = `poly ${mil} mil`;
  const fallback = products.find(p => p.name.toLowerCase().includes(milFragment));
  if (fallback) {
    return {
      qboItemId: fallback.qboItemId,
      name: fallback.name,
      qty,
      unitPrice: fallback.unitPrice ?? 0,
      amount: Math.round(qty * (fallback.unitPrice ?? 0) * 100) / 100,
    };
  }

  return null;
}

// ── Pass 1 prompt: raw extraction per chunk ───────────────────────────────────
// Focus: classify EVERY bar mark as fabricated (bent) or stock (straight),
// produce cut-sheet-style records with show-your-math quantities.
const PASS1_PROMPT = `You are a licensed structural rebar detailer producing a CUT SHEET from construction plan pages.
You MUST classify every single bar mark as FABRICATED (any bend, hook, L-shape, stirrup, tie, spiral, dowel with hook)
or STOCK (perfectly straight cut from a 20' or 40' stick with zero bends).

The output is a flat list of bar-mark records — one object per mark — not a summary and not totals.
This is the same format a professional engineer uses on a REBAR-CAD BAR LIST.

══ PLAN TYPES ══
1. REBAR SHOP DRAWINGS: named bar marks (B1, S1, T1, 3A01, 5A01) with size, pcs, length, bend type (T2, T3, Type 17, etc.).
2. FOUNDATION PLANS — DRILLED PIER / GRADE BEAM (most common Texas residential):
   - Read GENERAL NOTES. "ALL GRADE BEAMS: 4-#5 CONT., #3 STIRRUPS @ 12\" O.C." applies to EVERY beam.
   - Count total drilled piers from the plan view; note each pier diameter & depth from the schedule.
   - Pier verticals, pier ties, beam stirrups, corner bars = ALL FABRICATED (bent / hooked / looped).
   - Grade-beam continuous top/bottom bars, slab mat bars, curb longitudinal = STOCK (straight).
3. FOUNDATION PLANS — POST-TENSION: numbered circles = strand counts (NOT rebar). Conventional rebar lives in notes.
4. BEAM / PIER DETAIL SHEETS: every section cut — size, pcs per section, cut length, bend type.
5. SLAB PLANS: chair spacing, poly area, slab thickness, slab bars (usually stock straight).

══ CLASSIFICATION RULES — MEMORIZE ══
isFabricated = true  when the bar has ANY of: bend, hook, stirrup loop, spiral, L-shape, hairpin, Type code.
isFabricated = false when the bar is a straight cut length only (continuous top/bottom, slab mat, curb longitudinal).

Typical fabricated items (bendType examples in parens):
  • Pier verticals with top hook (Type 2 / T2)
  • Pier tie loops / rings / spirals (Type 17 / Ring)
  • Grade-beam stirrups (Type 3 / T3 / closed stirrup)
  • Beam corner bars at intersections (Type 20 / L-bar)
  • Dowels with 90° leg (T2)
  • Slab curb L-bars (L-bar)

Typical stock (straight) items:
  • Grade-beam continuous TOP & BOTTOM bars (CONT.)
  • Slab mat #3 or #4 bars in a grid (each way)
  • Curb longitudinal bars
  • Any "cut-to-length from 20' or 40' stock" callout with no bend detail

══ QUANTITY CALCULATION — SHOW YOUR MATH ══
NEVER output qty=0 or cutLengthFt=0. If you cannot read it, estimate conservatively and say so in notes.
Put the arithmetic inline in the "math" field for every record.

• DRILLED PIER VERTICALS (fab):     qty = bars_per_pier × pier_count.  cutLen = pier_depth + 2ft stub/hook.
• DRILLED PIER TIES (fab):          qty = ceil(pier_depth_ft / spacing_ft) × pier_count.  cutLen = π × cage_OD + 1ft.
• GRADE-BEAM CONTINUOUS (stock):    qty = stick_count;  cutLen = 20ft or 40ft.  totalLF = bars_per_beam × beam_LF × 1.10 (10% lap).
• GRADE-BEAM STIRRUPS (fab):        qty = ceil(beam_LF / spacing_ft) + 1.  cutLen = 2×(inside_w + inside_h)/12 + 1ft hooks.
• CORNER BARS (fab):                qty = intersection_count × bars_per_intersection.  cutLen = leg_A + leg_B.
• SLAB MAT (stock):                 totalLF = 2 × floor_SF × (1 + lap%);  qty = ceil(totalLF / 20).  cutLen = 20.
• CURB L-BARS (fab):                qty = perimeter_ft / spacing_ft;  cutLen = legA + legB (e.g. 1+1 = 2ft).
• Estimate flags go in the record's "math" string, not as separate items.

══ OTHER MATERIALS ══
• Poly/vapor barrier: include mil thickness AND roll size in name (e.g. "6 mil poly 32x100"). Quantity in SF.
• Foundation plans use DOBIE BRICKS, not wire chairs. Rule: 1 dobie per 4 LF of beam.
• Anchor bolts: 1/2" × 10" at 6'-0" O.C. along exterior perimeter unless plan says otherwise.
• Void boxes if called out: 1 per LF of beam between piers.
• Do NOT list PT strands as rebar.

══ WORKED EXAMPLE (drilled pier + grade beam) ══
Plan: 60 piers × 12"dia × 16'deep. 3-#5 vertical per pier, #3 ties @ 24" O.C.
Grade beams total 1,126 LF, (2)#5 CONT. top+bottom, #3 stirrups @ 24" O.C. Perimeter 298 LF.

bars output:
 { mark:"PIER-VERT", isFabricated:true,  bendType:"T2",       size:"#5", qty:180, cutLengthFt:18.0, legDims:["16'","2'"], location:"pier verticals",  math:"3 bars/pier × 60 piers = 180; 16' depth + 2' stub = 18'",  weightLb:3379 }
 { mark:"PIER-TIE",  isFabricated:true,  bendType:"Ring",     size:"#3", qty:540, cutLengthFt:3.62, legDims:["10\"dia"],  location:"pier ties @ 24in O.C.", math:"ceil(16/2)+1 = 9 ties/pier × 60 = 540; π×(10/12)+1' = 3.62'", weightLb:735 }
 { mark:"BEAM-CONT", isFabricated:false, bendType:"STRAIGHT", size:"#5", qty:124, cutLengthFt:20.0, legDims:[],           location:"grade beam top+bottom cont.", math:"2 bars × 1126 LF × 1.10 lap = 2479 LF; ceil(2479/20) = 124 sticks", weightLb:2586 }
 { mark:"BEAM-STIR", isFabricated:true,  bendType:"T3",       size:"#3", qty:565, cutLengthFt:5.67, legDims:["8\"","20\""], location:"grade beam stirrups @ 24in O.C.", math:"1126/2 + 1 = 565; 2×(8+20)/12 + 1' hooks = 5.67'", weightLb:1204 }
 { mark:"CORNER",    isFabricated:true,  bendType:"T20",      size:"#5", qty:112, cutLengthFt:4.0,  legDims:["2'","2'"],  location:"beam intersections 2 ea", math:"56 intersections × 2 = 112; 24\"+24\" legs = 4.0'", weightLb:467 }

══ OUTPUT FORMAT ══
Return ONLY valid JSON — no prose, no markdown fences:
{
  "projectName": "name from title block, else null",
  "notes": ["sheet F1 — drilled pier foundation", "60 piers 12\" dia 16' deep", "1126 LF total beams"],
  "bars": [
    {
      "mark": "PIER-VERT",
      "isFabricated": true,
      "bendType": "T2",
      "size": "#5",
      "qty": 180,
      "cutLengthFt": 18.0,
      "legDims": ["16'","2'"],
      "location": "pier verticals",
      "math": "3 bars/pier × 60 piers = 180",
      "weightLb": 3379
    }
  ],
  "otherMaterials": [
    {"name": "6 mil poly 32x100", "qty": 6161, "unit": "SF"},
    {"name": "dobie brick",       "qty": 282,  "unit": "EA"}
  ]
}

REMEMBER: every bar record MUST have isFabricated set to a boolean. No nulls, no "maybe".`;

// ── Pass 2 prompt: consolidation ──────────────────────────────────────────────
// Takes all chunk JSONs as input, deduplicates bar marks, splits into fab vs stock,
// and returns the final cut sheet in the engineer's format.
function buildPass2Prompt(chunkDataJson: string): string {
  return `You are a structural rebar estimator consolidating raw takeoff data from ${JSON.parse(chunkDataJson).length} section(s) of a plan set.

Your job is to produce the FINAL cut sheet in the format a professional detailer uses:
 • One line item "Fabrication-1" that rolls up ALL bent bars by total weight @ $0.75/lb
 • Separate stock-bar line items for every straight bar group (e.g. "Rebar #5 20'" × N sticks)
 • Other materials grouped by type

══ CONSOLIDATION RULES ══
1. DEDUPLICATE bar marks across chunks. If mark "3A01" appears in multiple chunks with matching size+location,
   treat them as the SAME bars — pick the chunk with the most detail, DO NOT add quantities together.
2. SUM quantities only when the same mark legitimately spans multiple sections (e.g. a mark that
   appears on two separate detail sheets for two different wings of a building).
3. CLASSIFY each bar into the correct bucket using the isFabricated flag from Pass 1:
     isFabricated === true  → fabricatedBars[]   (goes to Fabrication-1 line)
     isFabricated === false → stockBars[]        (goes to stock bar line items)
   If Pass 1 left isFabricated unset, infer it: any bar whose description mentions
   bend, hook, stirrup, tie, loop, ring, spiral, L-bar, corner, hairpin, or any "Type N" code
   is fabricated. Straight continuous bars, slab mat, curb longitudinal are stock.
4. STOCK BAR GROUPING: group stock bars by (size, preferred_stock_length).
     Use 20' sticks unless any single cut length in the group exceeds 19' → then use 40'.
     stickCount = ceil(totalLinearFt_for_that_group / stock_length_ft). Always round UP.
5. Sum Fabrication-1 total: totalFabWeight = Σ (qty × cutLengthFt × lb/ft) across all fabricatedBars.
6. Use the projectName from the first chunk that provides one.

Here is the raw chunk data:
${chunkDataJson}

BAR WEIGHTS (lb/ft): #3=0.376, #4=0.668, #5=1.043, #6=1.502, #7=2.044, #8=2.670, #9=3.400, #10=4.303, #11=5.313

══ REQUIRED OUTPUT FORMAT (valid JSON only) ══
{
  "projectName": "Crystal Perez Residence",
  "notes": ["60 piers, 1126 LF beams", "FLAG: interior beam count estimated"],
  "fabricatedBars": [
    {"mark":"PIER-VERT", "size":"#5", "qty":180, "cutLengthFt":18.0, "bendType":"T2",   "legDims":["16'","2'"],  "location":"pier verticals",         "weightLb":3379},
    {"mark":"PIER-TIE",  "size":"#3", "qty":540, "cutLengthFt":3.62, "bendType":"Ring", "legDims":["10\\"dia"],   "location":"pier ties",              "weightLb":735},
    {"mark":"BEAM-STIR", "size":"#3", "qty":565, "cutLengthFt":5.67, "bendType":"T3",   "legDims":["8\\"","20\\""],"location":"grade beam stirrups",   "weightLb":1204},
    {"mark":"CORNER",    "size":"#5", "qty":112, "cutLengthFt":4.0,  "bendType":"T20",  "legDims":["2'","2'"],    "location":"beam intersections",     "weightLb":467}
  ],
  "stockBars": [
    {"size":"#5", "stockLengthFt":20, "cutLengthFt":20, "totalLinearFt":2479, "stickCount":124, "location":"grade beam top+bottom cont.",  "weightLb":2586},
    {"size":"#3", "stockLengthFt":20, "cutLengthFt":20, "totalLinearFt":12322,"stickCount":617, "location":"slab mat #3 @ 12\\" grid",      "weightLb":4633}
  ],
  "fabTotalWeightLb": 5785,
  "otherMaterials": [
    {"name":"6 mil poly 32x100", "qty":6161, "unit":"SF"},
    {"name":"dobie brick",       "qty":282,  "unit":"EA"}
  ]
}

Do NOT return the old schema (standardRebar / fabRebar). Use the new keys above: fabricatedBars, stockBars, fabTotalWeightLb, otherMaterials.`;
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
        max_output_tokens: 12000,
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

// ── Back-compat: accept either old schema (standardRebar/fabRebar)
//    or new schema (stockBars/fabricatedBars). Normalize to new shape. ────────
function normalizeToNewSchema(c: any): {
  projectName: string;
  notes: string[];
  fabricatedBars: any[];
  stockBars: any[];
  fabTotalWeightLb?: number;
  otherMaterials: any[];
} {
  const notes: string[] = c.notes || [];
  const projectName: string = c.projectName || "Customer Takeoff";
  const otherMaterials: any[] = c.otherMaterials || [];

  // Already new schema
  if (Array.isArray(c.fabricatedBars) || Array.isArray(c.stockBars)) {
    return {
      projectName, notes,
      fabricatedBars: c.fabricatedBars || [],
      stockBars: c.stockBars || [],
      fabTotalWeightLb: c.fabTotalWeightLb,
      otherMaterials,
    };
  }

  // Pass-1 "bars[]" flat list — split by isFabricated
  if (Array.isArray(c.bars)) {
    const fab = c.bars.filter((b: any) => b.isFabricated === true);
    const stock = c.bars.filter((b: any) => b.isFabricated === false).map((b: any) => {
      const cutLen = parseFloat(b.cutLengthFt) || 20;
      const qty = parseInt(b.qty) || 0;
      return {
        size: b.size || b.barSize || "#4",
        stockLengthFt: cutLen > 19 ? 40 : 20,
        cutLengthFt: cutLen,
        totalLinearFt: qty * cutLen,
        stickCount: qty,
        location: b.location || "",
        weightLb: b.weightLb,
      };
    });
    return { projectName, notes, fabricatedBars: fab.map((b: any) => ({ ...b, size: b.size || b.barSize })), stockBars: stock, otherMaterials };
  }

  // Legacy schema — standardRebar + fabRebar
  const fabricatedBars: any[] = (c.fabRebar || []).map((fr: any) => ({
    mark: fr.mark,
    size: fr.barSize,
    qty: parseInt(fr.qty) || 0,
    cutLengthFt: parseFloat(fr.cutLengthFt) || 0,
    bendType: fr.bendType,
    legDims: fr.legDims,
    location: fr.bendDescription || fr.location,
  }));
  const stockBars: any[] = (c.standardRebar || []).map((sr: any) => {
    const barSize = sr.barSize || "#4";
    const stockLen = 20;
    let stickCount: number;
    let totalLF: number;
    if (sr.qty && !sr.totalLinearFt) {
      stickCount = parseInt(sr.qty) || 1;
      totalLF = stickCount * stockLen;
    } else {
      totalLF = parseFloat(sr.totalLinearFt) || 0;
      stickCount = parseInt(sr.stickCount) || Math.ceil((parseFloat(sr.totalLinearFt) || 0) / stockLen) || 1;
    }
    const weightLb = sr.weightLb ?? Math.round(totalLF * (BAR_WEIGHT[normBar(barSize)] ?? 0.376) * 100) / 100;
    return { size: barSize, stockLengthFt: stockLen, cutLengthFt: stockLen, totalLinearFt: totalLF, stickCount, location: sr.location || "", weightLb };
  });
  return { projectName, notes, fabricatedBars, stockBars, otherMaterials };
}

// ── Render the engineer-style cut sheet table as plain text ─────────────────
function renderCutSheetTable(fab: any[], stock: any[], fabTotalLb: number, stockTotalLb: number): string[] {
  const lines: string[] = [];
  const bar = "─".repeat(67);
  lines.push("REBAR CUT SHEET");
  lines.push(bar);
  lines.push("Mark       Qty   Size  Cut Len    Type            Weight");
  for (const b of fab) {
    const mark = String(b.mark || "").padEnd(10).slice(0, 10);
    const qty = String(b.qty ?? "").padStart(5);
    const size = String(b.size || "").padEnd(5).slice(0, 5);
    const len = String(b.cutLengthFt ?? "").padEnd(10).slice(0, 10);
    const typ = `${b.bendType || "bent"} (fab)`.padEnd(15).slice(0, 15);
    const wt = `${Math.round(b.weightLb ?? 0)} lb`;
    lines.push(`${mark} ${qty}  ${size} ${len} ${typ} ${wt}`);
  }
  if (stock.length) {
    lines.push("[STRAIGHT / STOCK]");
    for (const s of stock) {
      const mark = `STK-${String(s.size || "").replace("#", "")}`.padEnd(10).slice(0, 10);
      const qty = String(s.stickCount ?? "").padStart(5);
      const size = String(s.size || "").padEnd(5).slice(0, 5);
      const len = `${s.cutLengthFt || s.stockLengthFt || 20}'`.padEnd(10).slice(0, 10);
      const typ = "STRAIGHT".padEnd(15);
      const wt = `${Math.round(s.weightLb ?? 0)} lb`;
      lines.push(`${mark} ${qty}  ${size} ${len} ${typ} ${wt}`);
    }
  }
  lines.push(bar);
  lines.push(`FAB TOTAL:   ${Math.round(fabTotalLb).toLocaleString()} lb  →  Fabrication-1 @ $0.75/lb`);
  lines.push(`STOCK TOTAL: ${Math.round(stockTotalLb).toLocaleString()} lb  →  stock bar line items`);
  lines.push(bar);
  return lines;
}

// ── Build line items + fab items from consolidated cut sheet ─────────────────
function buildFromCutSheet(consolidated: any, products: Product[]): TakeoffResult {
  const lineItems: LineItem[] = [];
  const fabItems: FabItem[] = [];

  const norm = normalizeToNewSchema(consolidated);
  const takeoffNotes: string[] = [...norm.notes];
  const projectName = norm.projectName;

  // ── STOCK BARS: one line item per (size, stockLength) group ───────────────
  // Re-group in case Pass 2 left multiple entries for the same (size, stockLen).
  const stockGroups = new Map<string, { size: string; stockLen: number; totalLF: number; stickCount: number; weightLb: number; locations: string[] }>();
  for (const s of norm.stockBars) {
    const size: string = s.size || "#4";
    const cutLen = parseFloat(s.cutLengthFt) || 0;
    const stockLen = parseFloat(s.stockLengthFt) || (cutLen > 19 ? 40 : 20);
    const weightPerFt = BAR_WEIGHT[size] ?? 0.668;
    const totalLF = parseFloat(s.totalLinearFt) || ((parseInt(s.stickCount) || 0) * stockLen);
    const sticks = parseInt(s.stickCount) || Math.ceil(totalLF / stockLen);
    const weightLb = typeof s.weightLb === "number" ? s.weightLb : Math.round(totalLF * weightPerFt * 100) / 100;
    const key = `${size}|${stockLen}`;
    const g = stockGroups.get(key);
    if (g) {
      g.totalLF += totalLF;
      g.stickCount += sticks;
      g.weightLb += weightLb;
      if (s.location) g.locations.push(s.location);
    } else {
      stockGroups.set(key, { size, stockLen, totalLF, stickCount: sticks, weightLb, locations: s.location ? [s.location] : [] });
    }
  }

  console.log(`[Takeoff] Stock groups: ${JSON.stringify([...stockGroups.entries()].map(([k,v]) => ({k, sticks: v.stickCount, lb: Math.round(v.weightLb)})))}`);

  let stockTotalLb = 0;
  const normalizedStockForTable: any[] = [];
  for (const g of stockGroups.values()) {
    stockTotalLb += g.weightLb;
    const name = `Rebar ${g.size} ${g.stockLen}'`;
    const desc = `${g.stickCount} stick(s) @ ${g.stockLen}' - ${Math.round(g.totalLF)} LF - ${Math.round(g.weightLb)} lb${g.locations.length ? ` - ${g.locations.join("; ")}` : ""}`;
    const matched = matchStockRebarProduct(g.size, g.stockLen, g.stickCount, products);
    if (matched) {
      lineItems.push({ ...matched, description: desc });
    } else {
      lineItems.push({ qboItemId: "CUSTOM", name, description: desc, qty: g.stickCount, unitPrice: 0, amount: 0 });
    }
    fabItems.push({
      mark: `STK-${g.size.replace("#", "")}-${g.stockLen}`,
      barSize: g.size, qty: g.stickCount, lengthFt: g.stockLen,
      totalLF: g.totalLF, weightLbs: Math.round(g.weightLb * 100) / 100,
      bendDescription: "Straight stock length",
      stockLengthFt: g.stockLen, barsPerStock: 1, stockBarsNeeded: g.stickCount,
    });
    normalizedStockForTable.push({ size: g.size, stockLengthFt: g.stockLen, cutLengthFt: g.stockLen, stickCount: g.stickCount, weightLb: g.weightLb });
  }

  // ── FABRICATED BARS: collect weights + emit fabItems, single Fabrication-1 line at end ──
  let fabTotalLb = 0;
  const fabForTable: any[] = [];
  const fabProduct = products.find(p => p.name.toLowerCase().includes("fabrication-1") || p.name.toLowerCase() === "fabrication-1");

  for (const fr of norm.fabricatedBars) {
    const barSize: string = fr.size || fr.barSize || "#4";
    const qty: number = parseInt(fr.qty) || 0;
    const cutLengthFt: number = parseFloat(fr.cutLengthFt) || 0;
    if (qty === 0 || cutLengthFt === 0) continue;
    const weightPerFt = BAR_WEIGHT[barSize] ?? 0.668;
    const totalLF = qty * cutLengthFt;
    const weightLb = typeof fr.weightLb === "number" ? fr.weightLb : Math.round(totalLF * weightPerFt * 100) / 100;
    fabTotalLb += weightLb;
    const { barsPerStock, stockBarsNeeded } = calcStockBars(barSize, qty, cutLengthFt);
    const mark = fr.mark || `F${fabItems.length + 1}`;
    const bendDesc = fr.location || fr.bendDescription || fr.bendType || "Custom bend";
    fabItems.push({
      mark, barSize, qty, lengthFt: cutLengthFt,
      totalLF, weightLbs: Math.round(weightLb * 100) / 100,
      bendDescription: `${fr.bendType ? fr.bendType + " — " : ""}${bendDesc}`,
      stockLengthFt: 20, barsPerStock, stockBarsNeeded,
    });
    fabForTable.push({ mark, size: barSize, qty, cutLengthFt, bendType: fr.bendType, weightLb });
  }

  // Fabrication-1 uses Pass 2's pre-summed weight when present; else use our recomputed total.
  const fabLbForBilling = typeof norm.fabTotalWeightLb === "number" && norm.fabTotalWeightLb > 0
    ? norm.fabTotalWeightLb
    : Math.round(fabTotalLb * 100) / 100;

  if (fabLbForBilling > 0) {
    const priceLbs = Math.round(fabLbForBilling * 0.75 * 100) / 100;
    const markList = fabForTable.map(f => f.mark).slice(0, 12).join(", ");
    const desc = `Total fabricated (bent) bars: ${Math.round(fabLbForBilling).toLocaleString()} lb @ $0.75/lb. Marks: ${markList}${fabForTable.length > 12 ? ", ..." : ""}`;
    lineItems.push({
      qboItemId: fabProduct?.qboItemId || FABRICATION_QBO_ID,
      name: "Fabrication-1",
      description: desc,
      qty: 1,
      unitPrice: priceLbs,
      amount: priceLbs,
    });
  }

  // Emit the cut-sheet table into takeoffNotes
  const tableLines = renderCutSheetTable(fabForTable, normalizedStockForTable, fabLbForBilling, stockTotalLb);
  takeoffNotes.push(...tableLines);

  // ── Other materials ───────────────────────────────────────────────────────
  for (const om of (consolidated.otherMaterials || [])) {
    const rawQty = parseFloat(om.qty) || 1;
    const unit: string = (om.unit || "EA").toUpperCase();
    const matName: string = om.productName || om.name || "";

    let qty = rawQty;
    let desc = "";

    if (isVaporBarrier(matName)) {
      if (unit === "SF") {
        // Convert SF -> rolls. Detect roll size from name (32x100=3200SF, 20x100=2000SF)
        const isWide = matName.toLowerCase().includes("32");
        const rollSF = isWide ? 3200 : 2000;
        const rolls = Math.ceil(rawQty / rollSF);
        const widthLabel = isWide ? "32x100" : "20x100";
        const milMatch = matName.match(/(\d+)\s*mil/i);
        const milLabel = milMatch ? `${milMatch[1]} mil` : "poly";
        desc = `${milLabel} - ${rawQty.toLocaleString()} SF - ${rolls} roll(s) @ ${widthLabel} (${rollSF.toLocaleString()} SF/roll)`;
        qty = rolls;
      } else if (unit === "ROLL" || unit === "ROLLS") {
        qty = rawQty;
        desc = `${rawQty} roll(s)`;
      } else {
        qty = rawQty;
        desc = `${rawQty} ${unit}`;
      }
      const matched = matchPolyProduct(matName, qty, products);
      if (matched) {
        lineItems.push({ ...matched, description: desc });
      } else {
        lineItems.push({ qboItemId: "CUSTOM", name: matName, description: desc, qty, unitPrice: 0, amount: 0 });
      }
    } else if (isDobie(matName)) {
      qty = rawQty;
      desc = `${rawQty} EA`;
      const matched = matchDobieProduct(qty, products);
      if (matched) {
        lineItems.push({ ...matched, description: desc });
      } else {
        lineItems.push({ qboItemId: "CUSTOM", name: "Dobie Brick", description: desc, qty, unitPrice: 0.55, amount: Math.round(qty * 0.55 * 100) / 100 });
      }
    } else if (isWireChair(matName)) {
      if (unit === "EA" || unit === "PC" || unit === "PCS") {
        const bags = Math.ceil(rawQty / CHAIRS_PER_BAG);
        desc = `${rawQty} pc required - ${bags} bag(s) @ 500 pc/bag`;
        qty = bags;
      } else {
        desc = `${rawQty} ${unit}`;
      }
      const matched = matchProduct(matName, qty, unit, products);
      if (matched) {
        lineItems.push({ ...matched, description: desc });
      } else {
        lineItems.push({ qboItemId: "CUSTOM", name: matName, description: desc, qty, unitPrice: 0, amount: 0 });
      }
    } else {
      desc = `${rawQty} ${unit}`;
      const matched = matchProduct(matName, qty, unit, products);
      if (matched) {
        lineItems.push({ ...matched, description: desc });
      } else {
        lineItems.push({ qboItemId: "CUSTOM", name: om.name || matName, description: desc, qty, unitPrice: 0, amount: 0 });
      }
    }
  }

    return { lineItems, fabItems, takeoffNotes, projectName };
}

// ════════════════════════════════════════════════════════════════════════════
// ── Claude multi-pass takeoff ────────────────────────────────────────────────
// Structural shop drawings render bar-list / bend-schedule tables as vector
// graphics — there is no text layer. We rasterize each PDF page to PNG with
// pdftoppm (poppler-utils) and send the images to Claude as image blocks.
// Pass 1: raw bar-mark extraction per chunk.
// Pass 2: validation pass on same chunk to catch anything missed.
// Pass 3: consolidation (merge chunks, dedupe, classify fab vs stock).
// Weights are ALWAYS computed in TS (never trusted from the model).
// ════════════════════════════════════════════════════════════════════════════

// Rasterize a PDF (bytes) to an array of PNG buffers using pdftoppm.
// Railway/nixpacks already installs poppler-utils. Falls back to empty array
// if pdftoppm fails so caller can fall back to document-block mode.
async function renderPdfToPngs(pdfBytes: Uint8Array, dpi = 200, maxPages = 20): Promise<Buffer[]> {
  const { execFileSync } = await import("child_process");
  const fs = await import("fs");
  const os = await import("os");
  const path = await import("path");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rcp-plan-"));
  const pdfPath = path.join(dir, "plan.pdf");
  const outPrefix = path.join(dir, "page");
  fs.writeFileSync(pdfPath, Buffer.from(pdfBytes));

  try {
    execFileSync("pdftoppm", [
      "-r", String(dpi),
      "-png",
      "-l", String(maxPages),
      pdfPath,
      outPrefix,
    ], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (err: any) {
    console.warn(`[Takeoff/Claude] pdftoppm failed: ${err?.message || err}`);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    return [];
  }

  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith("page") && f.endsWith(".png"))
    .sort();
  const buffers: Buffer[] = [];
  for (const f of files) {
    try { buffers.push(fs.readFileSync(path.join(dir, f))); } catch {}
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  console.log(`[Takeoff/Claude] Rendered ${buffers.length} page(s) to PNG @${dpi}dpi`);
  return buffers;
}

// Build image content blocks for the Anthropic messages API from PNG buffers.
function buildImageBlocks(pngBuffers: Buffer[]): any[] {
  return pngBuffers.map(buf => ({
    type: "image",
    source: { type: "base64", media_type: "image/png", data: buf.toString("base64") },
  }));
}

// Validate an extracted bars[] array. Returns total weight in lbs and flags.
function validateExtractedBars(bars: any[]): { totalWeightLb: number; ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!Array.isArray(bars) || bars.length === 0) {
    return { totalWeightLb: 0, ok: false, reasons: ["no bars extracted"] };
  }
  let totalWeightLb = 0;
  for (const b of bars) {
    const sz = normBar(b.size || b.barSize || "");
    const qty = parseInt(b.qty) || 0;
    const cut = parseFloat(b.cutLengthFt) || 0;
    const n = parseInt(sz.replace("#", ""));
    if (!Number.isFinite(n) || n < 3 || n > 11) reasons.push(`bad size ${sz}`);
    if (cut < 1.0 || cut > 40.0) reasons.push(`bad cutLen ${cut} for ${sz}`);
    if (qty <= 0) reasons.push(`bad qty ${qty} for ${sz}`);
    const wPerFt = BAR_WEIGHT[sz] ?? 0;
    totalWeightLb += qty * cut * wPerFt;
  }
  const ok = totalWeightLb >= 500 && reasons.length === 0;
  return { totalWeightLb, ok, reasons };
}

async function claudeWithRetry(
  anthropic: Anthropic,
  messages: any[],
  maxTokens: number,
  label: string
): Promise<string> {
  let attempts = 0;
  while (attempts < 4) {
    try {
      const models = [CLAUDE_MODEL, CLAUDE_FALLBACK_MODEL];
      const model = models[Math.min(attempts, models.length - 1)];
      const resp = await anthropic.messages.create({
        model,
        max_tokens: maxTokens,
        messages,
      });
      const parts = (resp.content || []) as any[];
      let text = "";
      for (const p of parts) {
        if (p.type === "text" && typeof p.text === "string") text += p.text;
      }
      return text;
    } catch (err: any) {
      const status = err?.status ?? err?.response?.status;
      if (status === 429 || status === 529) {
        const wait = 20_000 + attempts * 15_000;
        console.log(`[Takeoff/Claude] ${label} rate/overload (${status}), waiting ${wait}ms...`);
        await new Promise(r => setTimeout(r, wait));
        attempts++;
        continue;
      }
      if (status === 404 || status === 400) {
        // model mismatch — bump attempt to try fallback model
        console.log(`[Takeoff/Claude] ${label} got ${status} — trying fallback model`);
        attempts++;
        continue;
      }
      throw err;
    }
  }
  return "";
}

function stripJsonFences(s: string): string {
  return s
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

function safeJsonParse(s: string): any {
  if (!s) return {};
  const cleaned = stripJsonFences(s);
  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to extract the first balanced JSON object/array
    const objStart = cleaned.indexOf("{");
    const arrStart = cleaned.indexOf("[");
    const start = objStart < 0 ? arrStart : arrStart < 0 ? objStart : Math.min(objStart, arrStart);
    const end = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
    if (start >= 0 && end > start) {
      try { return JSON.parse(cleaned.slice(start, end + 1)); } catch {}
    }
    return {};
  }
}

// Pass 1 prompt for Claude — targets structural shop-drawing bar lists.
// These PDFs render the bar list / bend schedule tables as vector graphics
// (no text layer), so we send the pages as images and instruct Claude to
// read visually.
const CLAUDE_PASS1_PROMPT = `You are analyzing a structural reinforcing steel shop drawing (placement plan) from a rebar fabricator (e.g. Ready Cable, Commercial Metals). The bar list and bend schedule tables in these drawings are rendered as vector graphics — READ THEM VISUALLY from the image, they are not extractable as text.

Your job is to extract the complete BAR LIST from this drawing.

Look for a table (usually in the lower right area of page 2) with columns like:
  REQ | QTY | SIZE | LENGTH | MARK | NOTE
or similar columns for bar schedule data.

Also look for:
- A BEND SCHEDULE showing bar mark numbers with bend dimensions (501, 601, 701, 201, 401, 504, etc.)
- Section details with rebar callouts (e.g. "SHORT BEAMS: (3) #5 T&B, #3 STIRRUPS @ 18\\" OC")
- Any table showing rebar quantities, sizes, and lengths
- Section labels like FOUNDATION, SHORT BEAMS, LONG BEAMS, SUMPOUT, COLUMNS, PILASTER

For EACH bar entry, emit ONE object in the bars[] array with:
- mark: the mark number/letter shown in the MARK column (e.g. "501", "601", "701", "A", "S1"). Use "STR" for straight bars with no mark.
- isFabricated: BOOLEAN. true if the bar has any bend/hook/stirrup/tie/loop shown in the bend schedule; false if it is a straight cut.
- bendType: "straight" if no mark/bend, "stirrup" for U-shaped or closed tie, "L-hook" if one end bent, "90-hook", "180-hook", "U-tie", "hooked", or "custom" for other bends.
- size: bar size as "#3", "#4", "#5", "#6", "#7", "#8", etc. (always prefixed with #)
- qty: the QTY or REQ count (integer). If a section note says "×4 LOCATIONS" or "4 PLACES", multiply the per-location qty by that number and put the multiplied total here.
- cutLengthFt: cut length in DECIMAL feet. Convert feet-inches exactly:
    "20'-0\\"" → 20.0
    "8'-2\\""  → 8.167
    "4'-0\\""  → 4.0
    "3'-6\\""  → 3.5
    "6'-0\\""  → 6.0
- legDims: (optional) for bent bars, inside leg dimensions in inches, e.g. ["11","40"] for an 11x40 stirrup (13" beam minus 2" cover = 11" inside; 42" beam minus 2" = 40").
- location: the NOTE column value or section label verbatim, e.g. "Foundation 14\\" OCEW", "Short beam 3 CONT T&B", "Long beam stirrup 18\\" OC", "Sumpout U-tie", "Column 501", "Pilaster hooked".

IMPORTANT:
- Return EVERY row of the bar list as a separate object. Do NOT collapse multiple rows.
- Convert ALL lengths to decimal feet.
- For stirrups/ties inside dimensions: subtract 2" from beam width and height for cover.
- Multiply by repetition factors ("×4 LOCATIONS", "4 PLACES") when present.
- Straight bars (no mark, no bend) → isFabricated: false. Everything else (stirrups, U-ties, L-hooks, bent bars with mark numbers like 501/601/701/201/401/504/500) → isFabricated: true.
- Bar sizes are integers 3 through 11 only.
- NEVER output qty=0 or cutLengthFt=0. If you cannot read a row clearly, estimate conservatively from context.
- Do NOT list post-tension strands as rebar.

Return ONLY valid JSON — no prose, no markdown fences:
{
  "projectName": "from title block, or null",
  "notes": ["sheet type", "drawing number", "section list"],
  "bars": [
    {
      "mark": "501",
      "isFabricated": true,
      "bendType": "stirrup",
      "size": "#3",
      "qty": 794,
      "cutLengthFt": 8.167,
      "legDims": ["11","40"],
      "location": "Short beam stirrup @ 18\\" OC"
    },
    {
      "mark": "STR",
      "isFabricated": false,
      "bendType": "straight",
      "size": "#5",
      "qty": 420,
      "cutLengthFt": 20.0,
      "location": "Short beam 3 CONT T&B"
    }
  ],
  "otherMaterials": []
}

Every bar MUST have isFabricated as boolean (true/false), never null.`;

const CLAUDE_PASS2_VALIDATION_PROMPT = (pass1Json: string) => `I previously extracted this rebar schedule from the same shop drawing pages you are looking at now:

${pass1Json}

Look at the page images again carefully (the BAR LIST and BEND SCHEDULE tables are drawn as graphics — read them visually). Are there any rebar rows I MISSED? Look specifically for:
- Rows in the BAR LIST table I did not capture
- Bar marks in the BEND SCHEDULE that are not represented in my list
- Section callouts (e.g. "×4 LOCATIONS") where quantities should be multiplied
- Any quantity, size, or cut length that looks wrong compared to the drawing

Return ONLY the ADDITIONAL items that were missed as JSON (same schema as before — use the bars[] format with mark/isFabricated/bendType/size/qty/cutLengthFt/location):
{
  "bars": [ /* only missed items, or [] if nothing missed */ ],
  "otherMaterials": [ /* only missed materials, or [] */ ],
  "corrections": [ /* plain-text notes about wrong qty/size/length, or [] */ ]
}

If nothing was missed, return: {"bars":[],"otherMaterials":[],"corrections":[]}`;

function mergeChunkExtractions(pass1: any, pass2: any): any {
  const bars: any[] = Array.isArray(pass1?.bars) ? [...pass1.bars] : [];
  const seenMarks = new Set(bars.map(b => (b.mark || "").toString().toLowerCase()));
  for (const extra of (pass2?.bars || [])) {
    const key = (extra.mark || "").toString().toLowerCase();
    if (!key || !seenMarks.has(key)) {
      bars.push(extra);
      if (key) seenMarks.add(key);
    }
  }

  const other: any[] = Array.isArray(pass1?.otherMaterials) ? [...pass1.otherMaterials] : [];
  const seenOther = new Set(other.map(m => `${(m.name || "").toLowerCase()}|${m.unit || ""}`));
  for (const extra of (pass2?.otherMaterials || [])) {
    const key = `${(extra.name || "").toLowerCase()}|${extra.unit || ""}`;
    if (!seenOther.has(key)) {
      other.push(extra);
      seenOther.add(key);
    }
  }

  const notes: string[] = [...(pass1?.notes || [])];
  if (Array.isArray(pass2?.corrections)) {
    for (const c of pass2.corrections) {
      if (typeof c === "string" && c.trim()) notes.push(`validation: ${c.trim()}`);
    }
  }

  return {
    projectName: pass1?.projectName || null,
    notes,
    bars,
    otherMaterials: other,
  };
}

// Consolidation prompt for Claude — same structure as GPT Pass 2 but text-only.
function buildClaudeConsolidationPrompt(chunkDataJson: string): string {
  return `You are a structural rebar estimator consolidating raw takeoff data from ${JSON.parse(chunkDataJson).length} section(s) of a plan set.

Your job is to produce the FINAL cut sheet in the format a professional detailer uses:
• One rolled-up total weight for ALL fabricated bars (goes to Fabrication-1 line @ $0.75/lb)
• Separate stock-bar line items per (size, stock-length) group
• Other materials grouped by type

CONSOLIDATION RULES:
1. DEDUPE bar marks across chunks. If the same mark appears in multiple chunks with matching size+location,
   treat them as ONE (pick the most detailed chunk; do NOT sum).
2. SUM quantities only when a mark legitimately spans different sections (e.g. two separate detail sheets).
3. CLASSIFY using isFabricated from Pass 1. If unset, infer: any bar with bend/hook/stirrup/tie/loop/ring/spiral/L-bar/corner/hairpin/"Type N" is fabricated.
4. STOCK BAR GROUPING: group by (size, stock_length). Use 20' unless any cut length exceeds 19' → then 40'.
   stickCount = ceil(totalLinearFt / stock_length). Round UP.
5. Use projectName from the first chunk that provides one.

Raw chunk data:
${chunkDataJson}

Return ONLY valid JSON:
{
  "projectName": "name or null",
  "notes": ["observations"],
  "fabricatedBars": [
    {"mark":"PIER-VERT","size":"#5","qty":180,"cutLengthFt":18.0,"bendType":"T2","legDims":["16'","2'"],"location":"pier verticals"}
  ],
  "stockBars": [
    {"size":"#5","stockLengthFt":20,"cutLengthFt":20,"totalLinearFt":2479,"stickCount":124,"location":"grade beam cont."}
  ],
  "otherMaterials": [
    {"name":"6 mil poly 32x100","qty":6161,"unit":"SF"},
    {"name":"dobie brick","qty":282,"unit":"EA"}
  ]
}

Use exactly these keys: fabricatedBars, stockBars, otherMaterials. Do NOT return weightLb or fabTotalWeightLb — weights are computed downstream.`;
}

// Build the visual content blocks for a chunk. Prefers PNG page images
// (rendered via pdftoppm) so Claude can READ the bar-list/bend-schedule
// tables, which are drawn as vector graphics with no text layer. Falls
// back to a PDF document block if rasterization fails.
async function buildChunkVisualBlocks(chunkBytes: Uint8Array, label: string): Promise<any[]> {
  const pngs = await renderPdfToPngs(chunkBytes, 200, 20);
  if (pngs.length > 0) {
    console.log(`[Takeoff/Claude] ${label}: using ${pngs.length} PNG image block(s)`);
    return buildImageBlocks(pngs);
  }
  console.warn(`[Takeoff/Claude] ${label}: PNG render failed, falling back to PDF document block`);
  const b64 = Buffer.from(chunkBytes).toString("base64");
  return [{
    type: "document",
    source: { type: "base64", media_type: "application/pdf", data: b64 },
  }];
}

async function runClaudePass1(
  anthropic: Anthropic,
  chunkBytes: Uint8Array,
  chunkIndex: number,
  totalChunks: number
): Promise<any> {
  const label = `pass1 chunk ${chunkIndex + 1}/${totalChunks}`;
  const visualBlocks = await buildChunkVisualBlocks(chunkBytes, label);

  const rawText = await claudeWithRetry(
    anthropic,
    [{
      role: "user",
      content: [
        ...visualBlocks,
        { type: "text", text: `This is chunk ${chunkIndex + 1} of ${totalChunks} from a structural shop drawing. Read the bar list and bend schedule tables VISUALLY from the images above.\n\n${CLAUDE_PASS1_PROMPT}` },
      ],
    }],
    8000,
    label
  );
  console.log(`[Takeoff/Claude] ${label} response: ${rawText.length} chars`);
  return safeJsonParse(rawText);
}

async function runClaudePass2(
  anthropic: Anthropic,
  chunkBytes: Uint8Array,
  chunkIndex: number,
  totalChunks: number,
  pass1: any
): Promise<any> {
  const label = `pass2 chunk ${chunkIndex + 1}/${totalChunks}`;
  const pass1Json = JSON.stringify(pass1 || {}, null, 2).slice(0, 20000);
  const visualBlocks = await buildChunkVisualBlocks(chunkBytes, label);

  const rawText = await claudeWithRetry(
    anthropic,
    [{
      role: "user",
      content: [
        ...visualBlocks,
        { type: "text", text: CLAUDE_PASS2_VALIDATION_PROMPT(pass1Json) },
      ],
    }],
    3000,
    label
  );
  console.log(`[Takeoff/Claude] ${label} response: ${rawText.length} chars`);
  return safeJsonParse(rawText);
}

async function runClaudeConsolidation(anthropic: Anthropic, chunkRaws: any[]): Promise<any> {
  const chunkDataJson = JSON.stringify(chunkRaws, null, 2).slice(0, 80000);
  const prompt = buildClaudeConsolidationPrompt(chunkDataJson);
  console.log(`[Takeoff/Claude] Pass 3 (consolidation): ${chunkRaws.length} chunk(s)`);
  const rawText = await claudeWithRetry(
    anthropic,
    [{ role: "user", content: [{ type: "text", text: prompt }] }],
    6000,
    "consolidation"
  );
  return safeJsonParse(rawText);
}

async function performClaudeTakeoff(
  pdfUrls: string[],
  products: Product[]
): Promise<TakeoffResult> {
  const MAX_CHUNK_BYTES = 28 * 1024 * 1024; // Claude's 32MB document cap, leave headroom for base64 overhead
  const anthropic = getAnthropic();
  const { PDFDocument } = await import("pdf-lib");

  const readyChunks: Uint8Array[] = [];
  for (const pdfUrl of pdfUrls) {
    console.log(`[Takeoff/Claude] Downloading PDF: ${pdfUrl.substring(0, 80)}...`);
    const dlResp = await globalThis.fetch(pdfUrl, {
      headers: { "User-Agent": "RCPBot/1.0" },
      redirect: "follow",
    });
    if (!dlResp.ok) throw new Error(`HTTP ${dlResp.status} downloading PDF`);
    const pdfBuffer = Buffer.from(await dlResp.arrayBuffer());
    console.log(`[Takeoff/Claude] PDF: ${Math.round(pdfBuffer.length / 1024 / 1024 * 10) / 10}MB`);

    if (pdfBuffer.length <= MAX_CHUNK_BYTES) {
      readyChunks.push(new Uint8Array(pdfBuffer));
    } else {
      const srcPdf = await PDFDocument.load(pdfBuffer);
      const totalPages = srcPdf.getPageCount();
      console.log(`[Takeoff/Claude] PDF too large — splitting ${totalPages} pages adaptively`);
      const segments: Array<[number, number]> = [[0, totalPages]];
      while (segments.length > 0) {
        const [start, end] = segments.shift()!;
        const pageIndices = Array.from({ length: end - start }, (_, i) => start + i);
        const chunkPdf = await PDFDocument.create();
        const copied = await chunkPdf.copyPages(srcPdf, pageIndices);
        copied.forEach(p => chunkPdf.addPage(p));
        const bytes = await chunkPdf.save();
        if (bytes.length > MAX_CHUNK_BYTES && (end - start) > 1) {
          const mid = Math.floor((start + end) / 2);
          segments.unshift([mid, end]);
          segments.unshift([start, mid]);
        } else {
          readyChunks.push(bytes);
        }
      }
    }
  }

  console.log(`[Takeoff/Claude] ${readyChunks.length} chunk(s) ready — starting multi-pass extraction`);

  const chunkRaws: any[] = [];
  const allBarsForValidation: any[] = [];
  for (let i = 0; i < readyChunks.length; i++) {
    const pass1 = await runClaudePass1(anthropic, readyChunks[i], i, readyChunks.length);
    const hasBars = Array.isArray(pass1?.bars) && pass1.bars.length > 0;
    let merged = pass1;
    if (hasBars) {
      try {
        const pass2 = await runClaudePass2(anthropic, readyChunks[i], i, readyChunks.length, pass1);
        merged = mergeChunkExtractions(pass1, pass2);
        console.log(`[Takeoff/Claude] chunk ${i + 1} merged: ${merged.bars?.length ?? 0} bars, ${merged.otherMaterials?.length ?? 0} other`);
      } catch (e: any) {
        console.warn(`[Takeoff/Claude] pass2 skipped for chunk ${i + 1}: ${e?.message || e}`);
      }
    }
    chunkRaws.push(merged);
    if (Array.isArray(merged?.bars)) allBarsForValidation.push(...merged.bars);
  }

  // Validate extracted bars before consolidating. A 2-page structural shop
  // drawing should produce substantial tonnage — if we're under the floor,
  // Claude didn't read the bar list and we should let GPT-4o try.
  const v = validateExtractedBars(allBarsForValidation);
  console.log(`[Takeoff/Claude] validation: ${allBarsForValidation.length} bars, ~${Math.round(v.totalWeightLb)} lb total; reasons=${v.reasons.slice(0, 3).join("; ") || "ok"}`);
  if (v.totalWeightLb < 500) {
    throw new Error(`Claude extraction below weight floor (~${Math.round(v.totalWeightLb)} lb < 500 lb); triggering GPT-4o fallback`);
  }

  const consolidated = await runClaudeConsolidation(anthropic, chunkRaws);
  console.log(`[Takeoff/Claude] consolidated — fab: ${consolidated.fabricatedBars?.length ?? 0}, stock: ${consolidated.stockBars?.length ?? 0}, other: ${consolidated.otherMaterials?.length ?? 0}`);

  return buildFromCutSheet(consolidated, products);
}

// ── Core takeoff function ────────────────────────────────────────────────────
// planSourceUrl: the raw external URL from the customer's message (Drive/Dropbox/etc.)
//   When provided and PERPLEXITY_API_KEY is set, sonar-pro reads the document directly.
//   Falls back to the two-pass GPT-4o pipeline for MMS images or local PDFs.
export async function performTakeoff(
  mediaItems: string[],
  products: Product[],
  planSourceUrl?: string
): Promise<TakeoffResult> {
  // sonar-pro is a web search model — it cannot fetch private Dropbox/Drive download URLs.
  // Construction plans are image-based PDFs that must be read via GPT-4o Responses API inline base64.
  // The planSourceUrl is preserved for future use (e.g. public web-hosted plan pages).
  // All plan takeoffs route through the GPT-4o two-pass pipeline below.

  const pdfUrls = mediaItems.filter(u => u.startsWith("pdf::")).map(u => u.slice(5));
  const imageUrls = mediaItems.filter(u => !u.startsWith("pdf::") && !u.startsWith("__"));

  // Preferred path: Claude multi-pass (PDFs only — Claude reads PDFs natively).
  // Falls back to GPT-4o two-pass pipeline on error or if ANTHROPIC_API_KEY is missing.
  if (pdfUrls.length > 0 && process.env.ANTHROPIC_API_KEY) {
    try {
      const result = await performClaudeTakeoff(pdfUrls, products);
      if (result.lineItems && result.lineItems.length > 0) {
        console.log(`[Takeoff] Claude pipeline succeeded: ${result.lineItems.length} line item(s)`);
        return result;
      }
      console.warn(`[Takeoff] Claude pipeline returned 0 items — falling back to GPT-4o`);
    } catch (err: any) {
      console.error(`[Takeoff] Claude pipeline failed (${err?.message || err}) — falling back to GPT-4o`);
    }
  }

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
    console.log(`[Takeoff] Pass 2 — fab marks: ${consolidated.fabricatedBars?.length ?? consolidated.fabRebar?.length ?? 0}, stock groups: ${consolidated.stockBars?.length ?? consolidated.standardRebar?.length ?? 0}, other: ${consolidated.otherMaterials?.length ?? 0}`);

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

// ── Perplexity sonar-pro single-pass takeoff ─────────────────────────────────
// Used when a raw external URL (Drive/Dropbox/etc.) is available.
// sonar-pro fetches and reads the document itself — no base64, no chunking.

const SONAR_PROMPT = (productList: string) => `You are a structural rebar estimator performing a material takeoff for Rebar Concrete Products, McKinney TX.

Read the construction plan set at the URL provided in this message. Extract ALL rebar and materials.

PLAN TYPES — read ALL carefully:
1. REBAR SHOP DRAWINGS: Named bar marks (B1, S1, T1) with size, qty, cut length, bend description.
2. FOUNDATION PLANS (post-tension or conventional): Read PLAN LEGEND, GENERAL NOTES, all callout bubbles. Numbered circles on plan view are strand or rebar counts.
3. BEAM/PIER DETAIL SHEETS: Every section detail for rebar callouts. Read any PIER REINFORCING SCHEDULE table.
4. SLAB PLANS: Slab reinforcing notes, chair spacing, poly/vapor barrier area.

RULES:
- Straight stock bars: list in "standardRebar" with barSize AND either totalLinearFt OR qty (piece count).
- Fabricated/bent bars: list in "fabRebar" with mark, barSize, qty (pieces), cutLengthFt, bendDescription.
- For foundation plans: beam detail callouts + pier schedules. Each beam type repeats — extract per type and note repetitions.
- Do NOT list post-tension STRANDS as rebar.
- For poly/vapor barrier: always include mil thickness AND roll dimensions in name (e.g. "6 mil poly 32x100").
- Foundation plans use DOBIE BRICKS (not wire chairs). Output as name "dobie brick" with EA count.
  Estimate dobie count from beam lengths: 1 dobie per 4 LF of beam, or use exact count if shown.
- Wire chairs (500-pc bags) only for elevated slabs/decks.
- NEVER return null for qty or cutLengthFt. Estimate if needed — a rough number is better than null.
- Include project name if visible on the plan.

AVAILABLE QBO PRODUCTS (match names exactly where possible):
${productList}

BAR WEIGHTS (lb/ft): #3=0.376, #4=0.668, #5=1.043, #6=1.502, #7=2.044, #8=2.670, #9=3.400, #10=4.303, #11=5.313

Return ONLY valid JSON in this exact format:
{
  "projectName": "name from plan title block, or null",
  "notes": ["sheet notes", "plan type observations"],
  "standardRebar": [
    {"barSize": "#5", "totalLinearFt": 840, "location": "beam top and bottom"},
    {"barSize": "#3", "qty": 25, "location": "corner bars per general notes"}
  ],
  "fabRebar": [
    {"mark": "B1", "barSize": "#4", "qty": 48, "cutLengthFt": 5.5, "bendDescription": "90-deg hook both ends, 4in legs"},
    {"mark": "PIER-12IN-LOOP", "barSize": "#3", "qty": 20, "cutLengthFt": 3.5, "bendDescription": "closed loop tie @ 16in spacing"}
  ],
  "otherMaterials": [
    {"name": "6 mil poly 32x100", "qty": 3200, "unit": "SF"},
    {"name": "dobie brick", "qty": 24, "unit": "EA"}
  ]
}`;

export async function performSonarTakeoff(
  planUrl: string,
  products: Product[]
): Promise<TakeoffResult> {
  const productList = products
    .filter(p => p.unitPrice && p.unitPrice > 0)
    .map(p => `- "${p.name}" @ $${p.unitPrice?.toFixed(2)}`)
    .join("\n");

  const prompt = SONAR_PROMPT(productList);

  console.log(`[Takeoff/Sonar] Starting sonar-pro takeoff for: ${planUrl.substring(0, 80)}...`);

  const resp = await globalThis.fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.PERPLEXITY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "sonar-pro",
      messages: [
        {
          role: "system",
          content: "You are a structural rebar estimator. Read the plan set at the URL the user provides and return a complete material takeoff as JSON. Return ONLY valid JSON — no prose, no markdown fences.",
        },
        {
          role: "user",
          content: `Please perform a complete material takeoff from this plan set: ${planUrl}\n\n${prompt}`,
        },
      ],
      temperature: 0,
      max_tokens: 8000,
      return_citations: false,
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Perplexity API error ${resp.status}: ${errBody.substring(0, 200)}`);
  }

  const data = await resp.json() as any;
  const rawText: string = data?.choices?.[0]?.message?.content || "";
  console.log(`[Takeoff/Sonar] Response: ${rawText.length} chars — first 500: ${rawText.substring(0, 500)}`);

  // Strip markdown fences if model adds them anyway
  const jsonText = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();

  let consolidated: any = {};
  try {
    consolidated = JSON.parse(jsonText);
  } catch (err) {
    console.error(`[Takeoff/Sonar] JSON parse failed — raw: ${rawText.substring(0, 300)}`);
    throw new Error("sonar-pro returned non-JSON response");
  }

  const itemCount = (consolidated.standardRebar?.length || 0) + (consolidated.fabRebar?.length || 0) + (consolidated.otherMaterials?.length || 0);
  console.log(`[Takeoff/Sonar] Parsed: ${consolidated.standardRebar?.length || 0} straight bar sizes, ${consolidated.fabRebar?.length || 0} fab marks, ${consolidated.otherMaterials?.length || 0} other materials (${itemCount} total)`);

  return buildFromCutSheet(consolidated, products);
}
