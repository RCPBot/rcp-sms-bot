/**
 * Tool Registry — maps tool names to their implementations.
 *
 * GPT calls a tool by name. The engine looks it up here, executes it,
 * and feeds the result back to GPT as a tool_result message.
 *
 * Adding a new vertical = add a new case block in getVerticalTools().
 */

import {
  calculateTax,
  calculateDeliveryFee,
  bundleToBarCount,
  buildOrderSummary,
  formatCurrency,
  type DeliveryModel,
} from "./universal.js";

import {
  calculateSlabRebar,
  calculateFootingRebar,
  calculateFabricationBar,
  calculateShearCut,
  calculateConcreteYardage,
  calculateWireMeshSheets,
  getBarWeight,
  getLapLength,
  type FabShape,
} from "./building_materials.js";

// ─── Tool descriptor (matches OpenAI function calling schema) ─────────────────

export interface ToolDescriptor {
  name: string;
  description: string;
  parameters: Record<string, any>;
  execute: (args: Record<string, any>, context?: ToolContext) => ToolResult;
}

export interface ToolContext {
  taxRate: number;
  deliveryModel?: DeliveryModel;
  /** Optional second delivery model for companies with split delivery logic (e.g. RCP uses per_mile for rebar, concrete_truck for concrete) */
  concreteDeliveryModel?: DeliveryModel;
  products?: Array<{ name: string; unitPrice: number | string | null }>;
}

export interface ToolResult {
  success: boolean;
  data: Record<string, any>;
  display: string; // Human-readable result to inject back to GPT
  error?: string;
}

// ─── Universal tools (every customer) ────────────────────────────────────────

export const UNIVERSAL_TOOLS: ToolDescriptor[] = [
  {
    name: "calculate_tax",
    description: "Calculate sales tax on a subtotal. Always use this — never compute tax yourself.",
    parameters: {
      type: "object",
      properties: {
        subtotal: { type: "number", description: "Pre-tax dollar amount" },
      },
      required: ["subtotal"],
    },
    execute: (args, ctx) => {
      const rate = ctx?.taxRate ?? 0.0825;
      const result = calculateTax(args.subtotal, rate);
      return { success: true, data: result, display: result.formatted };
    },
  },
  {
    name: "calculate_delivery_fee",
    description: "Calculate the delivery fee for this order based on the company's delivery model.",
    parameters: {
      type: "object",
      properties: {
        input: { type: "number", description: "Miles (for per-mile/tiered) OR yards (for concrete truck) OR omit for flat fee" },
        order_value: { type: "number", description: "Optional order value to check free delivery threshold" },
      },
      required: [],
    },
    execute: (args, ctx) => {
      if (!ctx?.deliveryModel) {
        return { success: false, data: {}, display: "No delivery model configured.", error: "No delivery model" };
      }
      const result = calculateDeliveryFee(ctx.deliveryModel, args.input, args.order_value);
      return { success: true, data: result, display: result.breakdown };
    },
  },
  {
    name: "calculate_concrete_delivery_fee",
    description: "Calculate the concrete-specific delivery fee (truck-based). Use this for any order containing concrete PSI products. For rebar/materials delivery, use calculate_delivery_fee instead.",
    parameters: {
      type: "object",
      properties: {
        yards: { type: "number", description: "Total cubic yards of concrete ordered" },
      },
      required: ["yards"],
    },
    execute: (args, ctx) => {
      // Use concreteDeliveryModel if configured, fall back to deliveryModel, then hard-code RCP defaults
      const model: DeliveryModel = ctx?.concreteDeliveryModel ?? ctx?.deliveryModel ?? {
        type: "concrete_truck",
        feePerTruck: 70,
        yardsPerTruck: 10,
        shortLoadThresholdYards: 5,
        shortLoadFee: 350,
      };
      const result = calculateDeliveryFee(model, args.yards);
      return { success: true, data: result, display: result.breakdown };
    },
  },
  {
    name: "bundle_to_bars",
    description: "Convert bundle count to individual bar count for rebar orders.",
    parameters: {
      type: "object",
      properties: {
        bundles: { type: "number", description: "Number of bundles" },
        bar_size: { type: "integer", description: "Rebar bar size (3-18)" },
      },
      required: ["bundles", "bar_size"],
    },
    execute: (args) => {
      try {
        const result = bundleToBarCount(args.bundles, args.bar_size);
        const display = `${args.bundles} bundles of #${args.bar_size} = ${result.bars} bars (${result.bundleSize} bars/bundle)`;
        return { success: true, data: result, display };
      } catch (e: any) {
        return { success: false, data: {}, display: e.message, error: e.message };
      }
    },
  },
];

// ─── Building Materials vertical tools ───────────────────────────────────────

export const BUILDING_MATERIALS_TOOLS: ToolDescriptor[] = [
  {
    name: "calculate_slab_rebar",
    description: "Calculate exact quantity of rebar bars needed for a two-way slab mat. Always use this for slab rebar — never estimate manually.",
    parameters: {
      type: "object",
      properties: {
        length_ft: { type: "number", description: "Slab length in feet" },
        width_ft: { type: "number", description: "Slab width in feet" },
        bar_size: { type: "integer", description: "Rebar bar size (3-11)" },
        spacing_in: { type: "number", description: "On-center spacing in inches (e.g. 12, 18, 24)" },
        waste_factor: { type: "number", description: "Waste multiplier (default 0.04 for 4%)" },
      },
      required: ["length_ft", "width_ft", "bar_size", "spacing_in"],
    },
    execute: (args) => {
      try {
        const result = calculateSlabRebar({
          lengthFt: args.length_ft,
          widthFt: args.width_ft,
          barSize: args.bar_size,
          spacingIn: args.spacing_in,
          wasteFactor: args.waste_factor,
        });
        return { success: true, data: result, display: `SLAB REBAR CALCULATION:\n${result.work}\n→ ORDER QUANTITY: ${result.final_qty} bars (#${args.bar_size} 20')` };
      } catch (e: any) {
        return { success: false, data: {}, display: e.message, error: e.message };
      }
    },
  },
  {
    name: "calculate_footing_rebar",
    description: "Calculate rebar quantity for a footing or grade beam. Never estimate footing rebar manually.",
    parameters: {
      type: "object",
      properties: {
        linear_ft: { type: "number", description: "Total linear footage of the footing" },
        longi_bar_size: { type: "integer", description: "Longitudinal bar size" },
        longi_bar_count: { type: "integer", description: "Number of longitudinal bars in cross-section (e.g. 4 for 2 top + 2 bottom)" },
        stirrup_spacing_in: { type: "number", description: "Stirrup/tie spacing in inches (omit if no stirrups)" },
        waste_factor: { type: "number", description: "Waste multiplier (default 0.04)" },
      },
      required: ["linear_ft", "longi_bar_size", "longi_bar_count"],
    },
    execute: (args) => {
      try {
        const result = calculateFootingRebar({
          linearFt: args.linear_ft,
          longiBarSize: args.longi_bar_size,
          longiBarCount: args.longi_bar_count,
          stirrupSpacingIn: args.stirrup_spacing_in,
          wasteFactor: args.waste_factor,
        });
        let display = `FOOTING REBAR:\n${result.work}\n→ Longitudinal: ${result.longiQty} bars`;
        if (result.stirrupQty !== undefined) display += `\n→ Stirrups/Ties: ${result.stirrupQty} pcs`;
        return { success: true, data: result, display };
      } catch (e: any) {
        return { success: false, data: {}, display: e.message, error: e.message };
      }
    },
  },
  {
    name: "calculate_fabrication",
    description: "Calculate weight and price for a custom-bent or fabricated rebar shape (stirrups, rings, L-hooks, etc.) at $0.75/lb. Always use this for any bent bar.",
    parameters: {
      type: "object",
      properties: {
        shape_type: { type: "string", enum: ["stirrup", "ring", "l_hook", "hook_180", "custom"], description: "Shape type" },
        bar_size: { type: "integer", description: "Bar size (3-11)" },
        qty: { type: "integer", description: "Number of pieces" },
        width_in: { type: "number", description: "Width in inches (for stirrup)" },
        height_in: { type: "number", description: "Height in inches (for stirrup)" },
        diameter_in: { type: "number", description: "Diameter in inches (for ring)" },
        straight_in: { type: "number", description: "Straight length in inches (for hooks)" },
        cut_length_ft: { type: "number", description: "Total cut length in feet (for custom)" },
      },
      required: ["shape_type", "bar_size", "qty"],
    },
    execute: (args) => {
      try {
        let shape: FabShape;
        switch (args.shape_type) {
          case "stirrup": shape = { type: "stirrup", widthIn: args.width_in, heightIn: args.height_in }; break;
          case "ring": shape = { type: "ring", diameterIn: args.diameter_in }; break;
          case "l_hook": shape = { type: "l_hook", straightIn: args.straight_in }; break;
          case "hook_180": shape = { type: "hook_180", straightIn: args.straight_in }; break;
          case "custom": shape = { type: "custom", cutLengthFt: args.cut_length_ft }; break;
          default: throw new Error(`Unknown shape type: ${args.shape_type}`);
        }
        const result = calculateFabricationBar(shape, args.bar_size, args.qty);
        return { success: true, data: result, display: `FABRICATION:\n${result.work}` };
      } catch (e: any) {
        return { success: false, data: {}, display: e.message, error: e.message };
      }
    },
  },
  {
    name: "calculate_shear_cut",
    description: "Calculate price for straight bars cut to a custom length shorter than stock (priced at $0.75/lb fabrication rate).",
    parameters: {
      type: "object",
      properties: {
        cut_length_ft: { type: "number", description: "Requested cut length in feet" },
        qty: { type: "integer", description: "Number of pieces" },
        bar_size: { type: "integer", description: "Bar size" },
        stock_length_ft: { type: "number", description: "Stock bar length (default 20)" },
      },
      required: ["cut_length_ft", "qty", "bar_size"],
    },
    execute: (args) => {
      try {
        const result = calculateShearCut(args.cut_length_ft, args.qty, args.bar_size, args.stock_length_ft ?? 20);
        return { success: true, data: result, display: `SHEAR CUT:\n${result.work}` };
      } catch (e: any) {
        return { success: false, data: {}, display: e.message, error: e.message };
      }
    },
  },
  {
    name: "calculate_concrete_yardage",
    description: "Calculate cubic yards of concrete for a slab or pour. Always use this formula — never estimate yardage manually.",
    parameters: {
      type: "object",
      properties: {
        length_ft: { type: "number" },
        width_ft: { type: "number" },
        thickness_in: { type: "number", description: "Slab thickness in inches" },
      },
      required: ["length_ft", "width_ft", "thickness_in"],
    },
    execute: (args) => {
      const result = calculateConcreteYardage(args.length_ft, args.width_ft, args.thickness_in);
      return { success: true, data: result, display: `CONCRETE YARDAGE: ${result.work}` };
    },
  },
  {
    name: "calculate_wire_mesh_sheets",
    description: "Calculate number of wire mesh sheets needed (8'×20' = 160 sq ft each, 10% waste included).",
    parameters: {
      type: "object",
      properties: {
        total_sqft: { type: "number", description: "Total area in square feet" },
      },
      required: ["total_sqft"],
    },
    execute: (args) => {
      const result = calculateWireMeshSheets(args.total_sqft);
      return { success: true, data: result, display: `WIRE MESH: ${result.work}` };
    },
  },
  {
    name: "get_bar_weight",
    description: "Get the unit weight (lb/ft) for a rebar bar size.",
    parameters: {
      type: "object",
      properties: {
        bar_size: { type: "integer" },
      },
      required: ["bar_size"],
    },
    execute: (args) => {
      try {
        const w = getBarWeight(args.bar_size);
        return { success: true, data: { weight: w }, display: `#${args.bar_size} = ${w} lb/ft` };
      } catch (e: any) {
        return { success: false, data: {}, display: e.message, error: e.message };
      }
    },
  },
  {
    name: "get_lap_length",
    description: "Get the standard lap splice length in feet for a bar size (40×db field standard).",
    parameters: {
      type: "object",
      properties: {
        bar_size: { type: "integer" },
      },
      required: ["bar_size"],
    },
    execute: (args) => {
      try {
        const l = getLapLength(args.bar_size);
        return { success: true, data: { lap_ft: l }, display: `#${args.bar_size} lap length = ${l} ft (${(l * 12).toFixed(1)}")` };
      } catch (e: any) {
        return { success: false, data: {}, display: e.message, error: e.message };
      }
    },
  },
];

// ─── Vertical tool sets ────────────────────────────────────────────────────────

export type Industry =
  | "building_materials"
  | "lumber_yard"
  | "stone_landscape"
  | "plumbing_supply"
  | "electrical_supply"
  | "rental_equipment"
  | "general_distribution";

/**
 * Get the full tool set for a given industry vertical.
 * Always includes universal tools. Adds industry-specific tools on top.
 */
export function getToolsForIndustry(industry: Industry): ToolDescriptor[] {
  const base = [...UNIVERSAL_TOOLS];

  switch (industry) {
    case "building_materials":
      return [...base, ...BUILDING_MATERIALS_TOOLS];

    case "lumber_yard":
      // Lumber yards share bundle math; add board-feet calculator when built
      return [...base, ...BUILDING_MATERIALS_TOOLS.filter(t =>
        ["calculate_tax", "calculate_delivery_fee", "bundle_to_bars"].includes(t.name)
      )];

    case "plumbing_supply":
    case "electrical_supply":
    case "stone_landscape":
    case "rental_equipment":
    case "general_distribution":
    default:
      // For now: universal tools only; add vertical tools as each industry is built out
      return base;
  }
}

/**
 * Convert tool descriptors to OpenAI function calling format.
 */
export function toOpenAITools(tools: ToolDescriptor[]): any[] {
  return tools.map(t => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/**
 * Execute a tool call from GPT.
 */
export function executeTool(
  name: string,
  args: Record<string, any>,
  tools: ToolDescriptor[],
  context: ToolContext
): ToolResult {
  const tool = tools.find(t => t.name === name);
  if (!tool) {
    return { success: false, data: {}, display: `Unknown tool: ${name}`, error: `Tool not found: ${name}` };
  }
  try {
    return tool.execute(args, context);
  } catch (e: any) {
    return { success: false, data: {}, display: `Tool error: ${e.message}`, error: e.message };
  }
}
