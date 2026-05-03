/**
 * Building Materials Vertical Tools
 *
 * Deterministic math for rebar/concrete supply companies.
 * Every function here replaces a section of the old hardcoded ai.ts prompt math.
 * GPT calls these tools — it never does this arithmetic itself.
 *
 * Tools:
 *   - calculateSlabRebar(dims, barSize, spacingIn)
 *   - calculateFootingRebar(config)
 *   - calculateFabricationBar(shape, barSize, dims, qty)
 *   - calculateConcreteYardage(lengthFt, widthFt, thicknessIn)
 *   - shearCutBarsConsumed(cutLengthFt, qty, barSize)
 *   - getBarWeight(barSize)
 *   - getLapLength(barSize)
 *   - getCutLength(shape, dims)
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/** lb/ft unit weight by bar size */
export const BAR_WEIGHT_LB_PER_FT: Record<number, number> = {
  3: 0.376, 4: 0.668, 5: 1.043, 6: 1.502,
  7: 2.044, 8: 2.670, 9: 3.400, 10: 4.303, 11: 5.313,
};

/** Bar diameter in inches */
export const BAR_DIAMETER_IN: Record<number, number> = {
  3: 0.375, 4: 0.500, 5: 0.625, 6: 0.750,
  7: 0.875, 8: 1.000, 9: 1.128, 10: 1.270, 11: 1.410,
};

/** Lap length in feet using 40×db field standard */
export const LAP_LENGTH_FT: Record<number, number> = {
  3: 1.25,   // 40 × 0.375" = 15" = 1.25 ft
  4: 1.667,  // 40 × 0.500" = 20" = 1.667 ft
  5: 2.083,  // 40 × 0.625" = 25" = 2.083 ft
  6: 2.5,    // 40 × 0.750" = 30" = 2.5 ft
  7: 2.917,
  8: 3.333,
  9: 3.75,
  10: 4.167,
  11: 4.708,
};

export function getBarWeight(barSize: number): number {
  const w = BAR_WEIGHT_LB_PER_FT[barSize];
  if (!w) throw new Error(`Unknown bar size #${barSize}`);
  return w;
}

export function getLapLength(barSize: number): number {
  const l = LAP_LENGTH_FT[barSize];
  if (!l) throw new Error(`No lap length for #${barSize}`);
  return l;
}

// ─── Slab Rebar Calculator ────────────────────────────────────────────────────

export interface SlabRebarInput {
  lengthFt: number;
  widthFt: number;
  barSize: number;
  spacingIn: number;   // On-center spacing in inches
  stockLengthFt?: number; // Default 20
  wasteFactor?: number;   // Default 0.04 (4%)
}

export interface SlabRebarResult {
  rows_A: number;
  rows_B: number;
  sticks_per_row_A: number;
  sticks_per_row_B: number;
  raw_sticks: number;
  joints_A: number;
  joints_B: number;
  total_joints: number;
  lap_length_ft: number;
  lap_extra_sticks: number;
  sticks_with_laps: number;
  final_qty: number;
  work: string; // Human-readable step-by-step
}

/**
 * Calculate slab rebar quantity (two-way mat).
 * This is the exact formula from the RCP system prompt — deterministic, no drift.
 */
export function calculateSlabRebar(input: SlabRebarInput): SlabRebarResult {
  const { lengthFt, widthFt, barSize, spacingIn } = input;
  const stockLen = input.stockLengthFt ?? 20;
  const waste = input.wasteFactor ?? 0.04;
  const spacingFt = spacingIn / 12;
  const lapFt = getLapLength(barSize);

  // Step 1: rows in each direction
  const rows_A = Math.ceil(lengthFt / spacingFt) + 1;  // rows spanning widthFt
  const rows_B = Math.ceil(widthFt / spacingFt) + 1;   // rows spanning lengthFt

  // Step 2: sticks per row
  const sticks_per_row_A = Math.ceil(widthFt / stockLen);
  const sticks_per_row_B = Math.ceil(lengthFt / stockLen);

  // Step 3: total raw sticks
  const raw_sticks = rows_A * sticks_per_row_A + rows_B * sticks_per_row_B;

  // Step 4: lap material
  const joints_A = rows_A * Math.max(0, sticks_per_row_A - 1);
  const joints_B = rows_B * Math.max(0, sticks_per_row_B - 1);
  const total_joints = joints_A + joints_B;
  const lap_extra_sticks = Math.ceil((total_joints * lapFt) / stockLen);
  const sticks_with_laps = raw_sticks + lap_extra_sticks;

  // Step 5: waste
  const final_qty = Math.ceil(sticks_with_laps * (1 + waste));

  const work = [
    `Slab: ${lengthFt}'×${widthFt}', #${barSize} @ ${spacingIn}" O.C., ${stockLen}' bars, lap=${lapFt}ft, waste=${waste * 100}%`,
    `Direction A (${rows_A} rows × ${sticks_per_row_A} sticks): ${rows_A * sticks_per_row_A} sticks, ${joints_A} joints`,
    `Direction B (${rows_B} rows × ${sticks_per_row_B} sticks): ${rows_B * sticks_per_row_B} sticks, ${joints_B} joints`,
    `Raw sticks: ${raw_sticks} | Joints: ${total_joints}`,
    `Lap extra: ceil(${total_joints}×${lapFt}/${stockLen}) = ${lap_extra_sticks} sticks`,
    `With laps: ${sticks_with_laps} × ${1 + waste} = ceil(${(sticks_with_laps * (1 + waste)).toFixed(3)}) = ${final_qty} sticks`,
  ].join("\n");

  return { rows_A, rows_B, sticks_per_row_A, sticks_per_row_B, raw_sticks, joints_A, joints_B, total_joints, lap_length_ft: lapFt, lap_extra_sticks, sticks_with_laps, final_qty, work };
}

// ─── Footing Rebar Calculator ─────────────────────────────────────────────────

export interface FootingRebarInput {
  linearFt: number;
  longiBarSize: number;
  longiBarCount: number;     // bars per cross-section (e.g. 4 for 2T+2B)
  stirrupSpacingIn?: number; // if stirrups/ties used
  stockLengthFt?: number;
  wasteFactor?: number;
}

export interface FootingRebarResult {
  longiQty: number;
  stirrupQty?: number;
  work: string;
}

export function calculateFootingRebar(input: FootingRebarInput): FootingRebarResult {
  const stock = input.stockLengthFt ?? 20;
  const waste = input.wasteFactor ?? 0.04;
  const lapFt = getLapLength(input.longiBarSize);

  // Longitudinal bars: bars per row × ceil(linearFt / stockLen) + lap material
  const sticksPerBar = Math.ceil(input.linearFt / stock);
  const rawSticks = input.longiBarCount * sticksPerBar;
  const joints = input.longiBarCount * Math.max(0, sticksPerBar - 1);
  const lapExtra = Math.ceil((joints * lapFt) / stock);
  const longiQty = Math.ceil((rawSticks + lapExtra) * (1 + waste));

  let stirrupQty: number | undefined;
  const lines = [
    `Footing: ${input.linearFt} LF, ${input.longiBarCount}-#${input.longiBarSize} longi bars`,
    `Sticks/bar: ceil(${input.linearFt}/${stock}) = ${sticksPerBar}`,
    `Raw: ${input.longiBarCount}×${sticksPerBar} = ${rawSticks} sticks, ${joints} joints`,
    `Lap extra: ceil(${joints}×${lapFt}/${stock}) = ${lapExtra}`,
    `Longi total: ceil(${rawSticks + lapExtra}×${1 + waste}) = ${longiQty} sticks`,
  ];

  if (input.stirrupSpacingIn !== undefined) {
    stirrupQty = Math.ceil(input.linearFt / (input.stirrupSpacingIn / 12));
    lines.push(`Stirrups: ceil(${input.linearFt}/(${input.stirrupSpacingIn}/12)) = ${stirrupQty} pcs`);
  }

  return { longiQty, stirrupQty, work: lines.join("\n") };
}

// ─── Fabrication Calculator ───────────────────────────────────────────────────

export type FabShape =
  | { type: "stirrup"; widthIn: number; heightIn: number }
  | { type: "ring"; diameterIn: number }
  | { type: "l_hook"; straightIn: number }
  | { type: "hook_180"; straightIn: number }
  | { type: "custom"; cutLengthFt: number };

export interface FabResult {
  cutLengthFt: number;
  weightPerPiece: number;
  totalWeight: number;
  totalPrice: number;
  pricePerPiece: number;
  work: string;
}

const FAB_RATE = 0.75; // $/lb

/**
 * Calculate fabrication cost for a bent bar.
 * @param shape   Shape descriptor with dimensions
 * @param barSize Bar size (#3–#11)
 * @param qty     Number of pieces
 */
export function calculateFabricationBar(shape: FabShape, barSize: number, qty: number): FabResult {
  const weightPerFt = getBarWeight(barSize);
  const diaIn = BAR_DIAMETER_IN[barSize] ?? 0.5;

  let cutLengthFt: number;
  let shapeDesc: string;

  switch (shape.type) {
    case "stirrup": {
      const perimIn = 2 * (shape.widthIn + shape.heightIn) + 8; // 8" hook allowance
      cutLengthFt = perimIn / 12;
      shapeDesc = `Stirrup ${shape.widthIn}"×${shape.heightIn}": 2×(${shape.widthIn}+${shape.heightIn})+8 = ${perimIn}" = ${cutLengthFt.toFixed(3)}ft`;
      break;
    }
    case "ring": {
      const perimIn = Math.PI * shape.diameterIn + 4; // 4" hook allowance
      cutLengthFt = perimIn / 12;
      shapeDesc = `Ring ${shape.diameterIn}": π×${shape.diameterIn}+4 = ${perimIn.toFixed(2)}" = ${cutLengthFt.toFixed(3)}ft`;
      break;
    }
    case "l_hook": {
      const totalIn = shape.straightIn + 12 * diaIn;
      cutLengthFt = totalIn / 12;
      shapeDesc = `L-Hook: ${shape.straightIn}"+12×${diaIn}" = ${totalIn.toFixed(2)}" = ${cutLengthFt.toFixed(3)}ft`;
      break;
    }
    case "hook_180": {
      const totalIn = shape.straightIn + 4 * diaIn + 3;
      cutLengthFt = totalIn / 12;
      shapeDesc = `180° Hook: ${shape.straightIn}"+4×${diaIn}+3 = ${totalIn.toFixed(2)}" = ${cutLengthFt.toFixed(3)}ft`;
      break;
    }
    case "custom": {
      cutLengthFt = shape.cutLengthFt;
      shapeDesc = `Custom cut length: ${cutLengthFt}ft`;
      break;
    }
  }

  const weightPerPiece = +(cutLengthFt * weightPerFt).toFixed(4);
  const totalWeight = +(qty * weightPerPiece).toFixed(2);
  const pricePerPiece = +(weightPerPiece * FAB_RATE).toFixed(4);
  const totalPrice = +(totalWeight * FAB_RATE).toFixed(2);

  const work = [
    shapeDesc,
    `Weight/pc: ${cutLengthFt.toFixed(3)}ft × ${weightPerFt}lb/ft = ${weightPerPiece}lb`,
    `${qty} pcs × ${weightPerPiece}lb = ${totalWeight}lbs`,
    `Price: ${totalWeight}lbs × $${FAB_RATE}/lb = $${totalPrice.toFixed(2)}`,
  ].join("\n");

  return { cutLengthFt, weightPerPiece, totalWeight, totalPrice, pricePerPiece, work };
}

// ─── Shear Cut (straight bars cut to length) ─────────────────────────────────

export interface ShearCutResult {
  cutsPerBar: number;
  barsConsumed: number;
  totalWeight: number;
  pricePerPiece: number;
  totalPrice: number;
  work: string;
}

/**
 * Price straight bars cut to a custom length shorter than stock.
 * @param cutLengthFt  Requested cut length in feet
 * @param qty          Number of pieces
 * @param barSize      Bar size
 * @param stockLengthFt  Usually 20
 */
export function calculateShearCut(cutLengthFt: number, qty: number, barSize: number, stockLengthFt = 20): ShearCutResult {
  const weightPerFt = getBarWeight(barSize);
  const cutsPerBar = Math.floor(stockLengthFt / cutLengthFt);
  const barsConsumed = Math.ceil(qty / cutsPerBar);
  const weightPerPiece = +(cutLengthFt * weightPerFt).toFixed(4);
  const totalWeight = +(qty * weightPerPiece).toFixed(2);
  const pricePerPiece = +(weightPerPiece * FAB_RATE).toFixed(4);
  const totalPrice = +(totalWeight * FAB_RATE).toFixed(2);

  const work = [
    `Shear cut: #${barSize} @ ${cutLengthFt}ft from ${stockLengthFt}ft bars`,
    `Cuts/bar: floor(${stockLengthFt}/${cutLengthFt}) = ${cutsPerBar}`,
    `Bars consumed: ceil(${qty}/${cutsPerBar}) = ${barsConsumed} bars`,
    `Weight/pc: ${cutLengthFt}ft × ${weightPerFt}lb/ft = ${weightPerPiece}lb`,
    `Total weight: ${qty}×${weightPerPiece} = ${totalWeight}lbs`,
    `Total price: ${totalWeight}lbs × $${FAB_RATE}/lb = $${totalPrice.toFixed(2)}`,
  ].join("\n");

  return { cutsPerBar, barsConsumed, totalWeight, pricePerPiece, totalPrice, work };
}

// ─── Concrete Yardage ─────────────────────────────────────────────────────────

export interface ConcreteYardageResult {
  cubicYards: number;
  rawYards: number;
  work: string;
}

/**
 * Calculate cubic yards of concrete needed.
 * Uses (L × W × T_in) / 324 — the exact formula from the RCP system prompt.
 */
export function calculateConcreteYardage(lengthFt: number, widthFt: number, thicknessIn: number): ConcreteYardageResult {
  const raw = (lengthFt * widthFt * thicknessIn) / 324;
  const cubicYards = Math.ceil(raw);
  return {
    cubicYards,
    rawYards: +raw.toFixed(4),
    work: `(${lengthFt}×${widthFt}×${thicknessIn}) / 324 = ${raw.toFixed(4)} → ceil = ${cubicYards} yd³`,
  };
}

// ─── Wire Mesh Sheet Calculator ───────────────────────────────────────────────

export interface WireMeshResult {
  sheets: number;
  work: string;
}

/**
 * Calculate wire mesh sheets needed.
 * All sheets are 8'×20' = 160 sq ft each. Always add 10% waste.
 */
export function calculateWireMeshSheets(totalSqFt: number): WireMeshResult {
  const withWaste = totalSqFt * 1.10;
  const sheets = Math.ceil(withWaste / 160);
  return {
    sheets,
    work: `${totalSqFt} sq ft × 1.10 waste / 160 sq ft/sheet = ceil(${(withWaste / 160).toFixed(3)}) = ${sheets} sheets`,
  };
}

// ─── Server-side price correction ─────────────────────────────────────────────

/**
 * Given a list of rebar orders (qty, barSize, lengthFt) and a product lookup,
 * return exact server-computed line totals the AI must use verbatim.
 */
export function computePriceLookup(
  orders: Array<{ qty: number; barSize: number; lengthFt: number; isBundle?: boolean }>,
  products: Array<{ name: string; unitPrice: number | string | null; qboItemId?: string }>,
  taxRate = 0.0825
): string {
  const BUNDLE_SIZES: Record<number, number> = { 3: 266, 4: 150, 5: 96, 6: 68, 7: 50, 8: 38, 9: 30, 10: 24, 11: 18 };

  const results: string[] = [];
  for (const order of orders) {
    const pcs = order.isBundle ? (order.qty * (BUNDLE_SIZES[order.barSize] ?? 1)) : order.qty;
    const sizeName = `#${order.barSize}`;
    const lenStr = String(order.lengthFt);
    const product = products.find(p => {
      if (!p.unitPrice) return false;
      const n = p.name.toLowerCase();
      return n.includes(sizeName.toLowerCase()) && n.includes(lenStr);
    });
    if (product && product.unitPrice) {
      const unit = parseFloat(String(product.unitPrice));
      const sub = +(pcs * unit).toFixed(2);
      const tax = +(sub * taxRate).toFixed(2);
      const total = +(sub + tax).toFixed(2);
      results.push(
        `ORDER: ${pcs} pcs #${order.barSize} ${order.lengthFt}' | unit=$${unit} | sub=$${sub} | tax=$${tax} | total=$${total}`
      );
    }
  }

  if (!results.length) return "";
  return (
    "\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
    "SERVER-COMPUTED PRICE LOOKUP (USE VERBATIM — DO NOT RECALCULATE)\n" +
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
    results.join("\n")
  );
}
