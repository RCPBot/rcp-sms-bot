/**
 * Universal Tools — available to ALL CoreBuild AI customers regardless of industry.
 *
 * These are deterministic functions GPT calls instead of doing the math itself.
 * Every result here is exact — no drift, no hallucination possible.
 *
 * Tools in this file:
 *   - calculateTax(subtotal, rate)
 *   - calculateDeliveryFee(config, miles)
 *   - bundleToBarCount(bundles, barSize)
 *   - parseDimensions(text)
 *   - formatCurrency(amount)
 */

// ─── Tax ──────────────────────────────────────────────────────────────────────

export interface TaxResult {
  subtotal: number;
  taxAmount: number;
  total: number;
  taxRate: number;
  formatted: string;
}

/**
 * Calculate sales tax on a subtotal.
 * @param subtotal  Pre-tax dollar amount
 * @param taxRate   Decimal rate (e.g. 0.0825 for 8.25%)
 */
export function calculateTax(subtotal: number, taxRate: number): TaxResult {
  const taxAmount = +(subtotal * taxRate).toFixed(2);
  const total = +(subtotal + taxAmount).toFixed(2);
  return {
    subtotal: +subtotal.toFixed(2),
    taxAmount,
    total,
    taxRate,
    formatted: `Subtotal: $${subtotal.toFixed(2)}\nTax (${(taxRate * 100).toFixed(2)}%): $${taxAmount.toFixed(2)}\nTotal: $${total.toFixed(2)}`,
  };
}

// ─── Delivery fee ─────────────────────────────────────────────────────────────

export type DeliveryModel =
  | { type: "per_mile"; ratePerMile: number; freeThresholdMiles?: number; freeThresholdOrderValue?: number }
  | { type: "flat"; flatFee: number }
  | { type: "tiered"; tiers: Array<{ maxMiles: number; fee: number }>; defaultFee: number }
  | { type: "concrete_truck"; feePerTruck: number; yardsPerTruck: number; shortLoadThresholdYards: number; shortLoadFee: number };

export interface DeliveryFeeResult {
  fee: number;
  waived: boolean;
  breakdown: string;
}

/**
 * Calculate delivery fee from a model config + distance or quantity.
 * @param model     DeliveryModel describing how this company charges delivery
 * @param input     miles (for per_mile/tiered) OR yards (for concrete_truck) OR undefined (for flat)
 * @param orderValue  Optional — used to check free delivery thresholds
 */
export function calculateDeliveryFee(
  model: DeliveryModel,
  input?: number,
  orderValue?: number
): DeliveryFeeResult {
  switch (model.type) {
    case "per_mile": {
      const miles = input ?? 0;
      const withinFreeZone = model.freeThresholdMiles !== undefined && miles <= model.freeThresholdMiles;
      const aboveFreeValue = model.freeThresholdOrderValue !== undefined && orderValue !== undefined && orderValue >= model.freeThresholdOrderValue;
      if (withinFreeZone && aboveFreeValue) {
        return { fee: 0, waived: true, breakdown: `FREE delivery — order over $${model.freeThresholdOrderValue} within ${model.freeThresholdMiles} miles` };
      }
      const fee = +(miles * model.ratePerMile).toFixed(2);
      return { fee, waived: false, breakdown: `${miles} miles × $${model.ratePerMile}/mile = $${fee.toFixed(2)}` };
    }
    case "flat": {
      return { fee: model.flatFee, waived: false, breakdown: `Flat delivery fee: $${model.flatFee.toFixed(2)}` };
    }
    case "tiered": {
      const miles = input ?? 0;
      const tier = model.tiers.find(t => miles <= t.maxMiles);
      const fee = tier ? tier.fee : model.defaultFee;
      return { fee, waived: false, breakdown: `Delivery (${miles} miles): $${fee.toFixed(2)}` };
    }
    case "concrete_truck": {
      const yards = input ?? 0;
      if (yards <= model.shortLoadThresholdYards) {
        return {
          fee: model.shortLoadFee,
          waived: false,
          breakdown: `Short Load Fee (${yards} yards ≤ ${model.shortLoadThresholdYards}): $${model.shortLoadFee.toFixed(2)}`,
        };
      }
      const trucks = Math.ceil(yards / model.yardsPerTruck);
      const fee = +(trucks * model.feePerTruck).toFixed(2);
      return {
        fee,
        waived: false,
        breakdown: `Concrete Truck Delivery: ceil(${yards}/${model.yardsPerTruck}) = ${trucks} truck${trucks !== 1 ? "s" : ""} × $${model.feePerTruck} = $${fee.toFixed(2)}`,
      };
    }
  }
}

// ─── Bundle math ──────────────────────────────────────────────────────────────

/** Standard bundle sizes for rebar (bars per bundle, 20' stock) */
export const REBAR_BUNDLE_SIZES: Record<number, number> = {
  3: 266, 4: 150, 5: 96, 6: 68, 7: 50, 8: 38, 9: 30, 10: 24, 11: 18, 14: 10, 18: 6,
};

/**
 * Convert bundle count to bar (piece) count.
 * @param bundles   Number of bundles ordered
 * @param barSize   Bar size (3–18)
 */
export function bundleToBarCount(bundles: number, barSize: number): { bars: number; bundleSize: number } {
  const bundleSize = REBAR_BUNDLE_SIZES[barSize];
  if (!bundleSize) throw new Error(`Unknown bundle size for #${barSize}`);
  return { bars: bundles * bundleSize, bundleSize };
}

// ─── Currency formatting ──────────────────────────────────────────────────────

export function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

// ─── Order summary builder ────────────────────────────────────────────────────

export interface LineItemSummary {
  name: string;
  qty: number;
  unitPrice: number;
  amount: number;
  description?: string;
}

/**
 * Build a formatted order summary string from line items + tax + optional delivery.
 */
export function buildOrderSummary(
  items: LineItemSummary[],
  taxRate: number,
  deliveryFee = 0,
  label = "ORDER SUMMARY"
): string {
  const lines: string[] = [`${label}:`];
  let subtotal = 0;

  for (const item of items) {
    const amount = +(item.qty * item.unitPrice).toFixed(2);
    subtotal += amount;
    lines.push(`- ${item.qty} ${item.name}${item.description ? ` (${item.description})` : ""} @ $${item.unitPrice.toFixed(5)}/ea = $${amount.toFixed(2)}`);
  }

  const tax = calculateTax(subtotal, taxRate);
  lines.push(`Subtotal: $${subtotal.toFixed(2)}`);
  lines.push(`Tax (${(taxRate * 100).toFixed(2)}%): $${tax.taxAmount.toFixed(2)}`);
  if (deliveryFee > 0) {
    lines.push(`Delivery: $${deliveryFee.toFixed(2)}`);
  }
  const total = +(subtotal + tax.taxAmount + deliveryFee).toFixed(2);
  lines.push(`Total: $${total.toFixed(2)}`);

  return lines.join("\n");
}
