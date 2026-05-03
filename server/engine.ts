/**
 * CoreBuild AI Engine — Option C Hybrid Architecture
 *
 * GPT handles: conversation, persona, when to call tools, natural language output
 * Tools handle: all deterministic math (slab, footing, fabrication, tax, delivery, yardage)
 *
 * Flow:
 *   1. Build system prompt from SYSTEM_PROMPT env var (or RCP hardcoded fallback)
 *   2. Get tool set for this company's industry vertical
 *   3. Send to GPT with tools available
 *   4. If GPT calls a tool → execute it deterministically → feed result back
 *   5. GPT composes final response using exact tool output
 *   6. Parse response for action tags ([CONFIRM_ORDER], [CONFIRM_ESTIMATE], etc.)
 *
 * This file exports `processMessageV2` which replaces `processMessage` in ai.ts.
 * The original `processMessage` is preserved for the main branch — this only
 * runs when ENGINE_VERSION=v2 env var is set.
 */

import OpenAI from "openai";
import { storage } from "./storage.js";
import type { Conversation, Message, Product } from "@shared/schema.js";
import {
  getToolsForIndustry,
  toOpenAITools,
  executeTool,
  type Industry,
  type ToolContext,
} from "./tools/registry.js";
import type { DeliveryModel } from "./tools/universal.js";

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

// ─── Intent types (same as original ai.ts) ────────────────────────────────────

export type AIIntent =
  | { type: "message"; text: string }
  | { type: "confirm_order"; text: string }
  | { type: "confirm_estimate"; text: string }
  | { type: "info_complete"; text: string }
  | { type: "calc_delivery"; text: string; address: string }
  | { type: "plan_takeoff"; text: string }
  | { type: "lookup_orders"; text: string };

// ─── Delivery model resolver ───────────────────────────────────────────────────

/**
 * Parse a delivery model from env vars or system prompt metadata.
 * Companies configure this during onboarding — falls back to RCP's $3/mile model.
 */
function resolveDeliveryModel(): DeliveryModel {
  const modelType = process.env.DELIVERY_MODEL ?? "per_mile";

  switch (modelType) {
    case "concrete_truck":
      return {
        type: "concrete_truck",
        feePerTruck: parseFloat(process.env.DELIVERY_FEE_PER_TRUCK ?? "70"),
        yardsPerTruck: parseFloat(process.env.DELIVERY_YARDS_PER_TRUCK ?? "10"),
        shortLoadThresholdYards: parseFloat(process.env.DELIVERY_SHORT_LOAD_THRESHOLD ?? "5"),
        shortLoadFee: parseFloat(process.env.DELIVERY_SHORT_LOAD_FEE ?? "350"),
      };
    case "flat":
      return { type: "flat", flatFee: parseFloat(process.env.DELIVERY_FLAT_FEE ?? "75") };
    case "tiered": {
      // DELIVERY_TIERS=0-30:0,31-60:50,61-100:100  (simplified parsing)
      const raw = process.env.DELIVERY_TIERS ?? "";
      const tiers = raw.split(",").map(t => {
        const [range, fee] = t.split(":");
        const [, max] = range.split("-").map(Number);
        return { maxMiles: max, fee: parseFloat(fee) };
      }).filter(t => !isNaN(t.maxMiles));
      return { type: "tiered", tiers, defaultFee: parseFloat(process.env.DELIVERY_DEFAULT_FEE ?? "150") };
    }
    case "per_mile":
    default:
      return {
        type: "per_mile",
        ratePerMile: parseFloat(process.env.DELIVERY_RATE_PER_MILE ?? "3"),
        freeThresholdMiles: process.env.DELIVERY_FREE_THRESHOLD_MILES ? parseFloat(process.env.DELIVERY_FREE_THRESHOLD_MILES) : 30,
        freeThresholdOrderValue: process.env.DELIVERY_FREE_THRESHOLD_VALUE ? parseFloat(process.env.DELIVERY_FREE_THRESHOLD_VALUE) : 1000,
      };
  }
}

// ─── Build system prompt ───────────────────────────────────────────────────────

function buildSystemPromptV2(products: Product[], conv: Conversation): string {
  const productList = products.length > 0
    ? products.map(p =>
        `- ${p.name}${p.description ? ": " + p.description : ""}${p.unitPrice ? " — $" + parseFloat(String(p.unitPrice)).toFixed(5) + (p.unitOfMeasure ? "/" + p.unitOfMeasure : "") : " (price varies)"}`
      ).join("\n")
    : "- Products loading from QuickBooks. Tell the customer pricing will be available shortly.";

  const customerCtx = conv.customerName
    ? `VERIFIED CUSTOMER:\n- Name: ${conv.customerName}\n- Email: ${conv.customerEmail || "unknown"}\n- Company: ${conv.customerCompany || "N/A"}\n- Stage: ${conv.stage}\n- Delivery address: ${conv.deliveryAddress || "none"}`
    : `STAGE: ${conv.stage} — not yet verified`;

  // Use SYSTEM_PROMPT env var if set (CoreBuild AI customer), otherwise RCP fallback
  const basePrompt = process.env.SYSTEM_PROMPT || getRCPFallbackPrompt();

  return `${basePrompt}

━━━━━━━━━━━━━━━━━━━━━━━━━━━
TOOL CALLING RULES (CRITICAL)
━━━━━━━━━━━━━━━━━━━━━━━━━━━
You have access to deterministic calculation tools. You MUST use them for:
- Any rebar quantity calculation (slabs, footings) → use calculate_slab_rebar or calculate_footing_rebar
- Any fabrication pricing (bent bars, stirrups, rings, hooks) → use calculate_fabrication
- Any shear cut (straight bars cut short) → use calculate_shear_cut
- Any concrete yardage → use calculate_concrete_yardage
- All tax calculations → use calculate_tax
- Rebar/materials delivery fees → use calculate_delivery_fee (per-mile model)
- Concrete delivery fees → use calculate_concrete_delivery_fee (truck-based model)
- Bundle-to-bar conversions → use bundle_to_bars

NEVER do these calculations in your head — always call the tool and use the result verbatim.
The tool output is exact and will match the invoice. Your arithmetic is not guaranteed to match.

━━━━━━━━━━━━━━━━━━━━━━━━━━━
LIVE PRODUCT CATALOG (from QuickBooks — authoritative prices)
━━━━━━━━━━━━━━━━━━━━━━━━━━━
${productList}

━━━━━━━━━━━━━━━━━━━━━━━━━━━
CUSTOMER CONTEXT
━━━━━━━━━━━━━━━━━━━━━━━━━━━
${customerCtx}`;
}

// ─── RCP fallback prompt (used when SYSTEM_PROMPT env is not set) ──────────────

function getRCPFallbackPrompt(): string {
  return `You are the AI ordering agent for Rebar Concrete Products.

COMPANY:
- Name: Rebar Concrete Products | Est. 2022
- Address: 2112 N Custer Rd, McKinney, TX 75071
- Phone: 469-631-7730 | Email: Office@RebarConcreteProducts.com
- Hours: Mon–Fri 6AM–3PM CST | Website: https://www.rebarconcreteproducts.com
- Tax rate: 8.25% | Delivery: $3/mile, free on orders $1,000+ within 30 miles
- Concrete delivery model: truck-based ($70/truck per 10 yards; ≤5 yards = $350 short load)

ROLES: 1) Ordering agent — quotes, invoices, estimates. 2) Concrete construction expert.

CUSTOMER VERIFICATION (CRITICAL):
- Existing customers ONLY — fraud prevention.
- Stage = "greeting": ONLY job is to verify. Ask name + phone/email on file.
- New customers: direct to call 469-631-7730 or visit the store to set up an account.
- Never discuss products until verified.
- Verification happens silently — go straight to the verified welcome, no hold messages.

ORDERING RULES:
- Always use tool outputs verbatim — never recalculate or override tool results.
- Rebar defaults to 20'. Never ask for length unless customer says "40'".
- 40' rebar sold in full bundles only: #3=266, #4=150, #5=96, #6=68.
- "sticks", "pcs", "bars" = individual pieces, never bundles.
- Before every final quote: ask about accessories (2×4, 2×6, chairs, tie wire).
- ESTIMATE (quote/pricing only) → [CONFIRM_ESTIMATE]. INVOICE (ready to buy) → [CONFIRM_ORDER].
- Concrete always delivered, never pickup. For estimates, collect name/phone/email only (no address).
- Show rebar BEFORE concrete in any combined quote.
- Tax applies to subtotal only. Delivery fee is not taxed.
- Concrete display: show per-yard math + delivery fee, then ONE bold combined total.

PRODUCT RULES:
- Stirrups stocked: 6×18 #3 ($1.58), 8×18 #3 ($1.70), 8×24 #3 ($2.55). All others = fabrication at $0.75/lb.
- Corner bars stocked: #4/2×2ft ($2.38), #5/2×2ft ($3.70), #6/2×2ft ($4.85). Others = fabrication.
- Rings stocked: 8" ($1.05), 12" ($1.35), 18" ($1.99), 24" ($2.65) — #3 only. Others = fabrication.
- Redwood = concrete expansion joint material ONLY (not forming, not landscaping).
- Lumber = 16' lengths only. Never ask about length.
- Expansion joints: 1 pack = 10 pieces.
- Wire mesh sheets are 8'×20' = 160 sq ft each.
- Poly: confirm mil AND size. Class A poly ≠ standard poly.
- "tie wire" or "tie wire roll" = Tie Wire Roll 16.5ga — no clarification needed.
- "epoxy" = SpecPoxy 3000 — quote immediately.

SMS RULES:
- Max 3–4 sentences. Plain text only — no markdown.
- Give price first, questions after.
- PLAN TAKEOFF: direct to ai.rebarconcreteproducts.com for full plan estimates.

SPECIAL TAGS (start of message, no visible text):
- [CONFIRM_ORDER] — customer confirms invoice
- [CONFIRM_ESTIMATE] — customer wants a formal estimate emailed
- [INFO_COMPLETE] — all customer info collected
- [CALC_DELIVERY: address] — trigger distance calculation
- [LOOKUP_ORDERS] — fetch order history from QuickBooks`;
}

// ─── Main engine function ──────────────────────────────────────────────────────

const MAX_TOOL_ROUNDS = 5; // Safety limit — prevent infinite tool loops

export async function processMessageV2(
  conversation: Conversation,
  inboundText: string,
  mediaUrls: string[] = [],
  orderHistory?: string,
  justAutoVerified = false,
  customerMemory?: any | null
): Promise<AIIntent> {
  const products = await storage.getAllProducts();
  const history = await storage.getMessages(conversation.id);

  // Determine industry for tool selection
  const industry = (process.env.INDUSTRY_VERTICAL ?? "building_materials") as Industry;
  const taxRate = parseFloat(process.env.TAX_RATE ?? "0.0825");
  const deliveryModel = resolveDeliveryModel();

  // If a separate concrete delivery model env var is set, use it.
  // This handles companies like RCP that have two different delivery models:
  //   DELIVERY_MODEL=per_mile               → rebar/materials (calculate_delivery_fee)
  //   CONCRETE_DELIVERY_MODEL=concrete_truck → concrete PSI products (calculate_concrete_delivery_fee)
  let concreteDeliveryModel: DeliveryModel | undefined;
  const concModelType = process.env.CONCRETE_DELIVERY_MODEL;
  if (concModelType) {
    // Temporarily swap env var to reuse resolveDeliveryModel() for the concrete model.
    // This is safe — process.env mutation is synchronous and immediately restored.
    const savedEnv = process.env.DELIVERY_MODEL;
    (process.env as any).DELIVERY_MODEL = concModelType;
    concreteDeliveryModel = resolveDeliveryModel();
    (process.env as any).DELIVERY_MODEL = savedEnv;
  }

  const toolContext: ToolContext = { taxRate, deliveryModel, concreteDeliveryModel, products };
  const tools = getToolsForIndustry(industry);
  const openAITools = toOpenAITools(tools);

  // Build base system prompt
  let systemPrompt = buildSystemPromptV2(products, conversation);

  // Inject returning customer memory
  if (customerMemory) {
    const avgVal = customerMemory.avgOrderValue ? `$${(customerMemory.avgOrderValue as number).toFixed(2)}` : "N/A";
    systemPrompt += `\n\n━━━ RETURNING CUSTOMER MEMORY ━━━\nName: ${customerMemory.name || "unknown"}\nCompany: ${customerMemory.company || "N/A"}\nOrders: ${customerMemory.orderCount || 0} | Spent: $${(customerMemory.totalSpent || 0).toFixed(2)} | Avg: ${avgVal}\nLast order: ${customerMemory.lastOrderSummary || "none"}\nTypical products: ${customerMemory.typicalProducts || "N/A"}\nNotes: ${customerMemory.notes || "none"}\nGreet by name. Skip info already on file.`;
  }

  // Inject learned rules
  try {
    const learnedRules = await storage.getLearnedRules();
    if (learnedRules.length > 0) {
      systemPrompt += `\n\n━━━ LEARNED RULES (approved — follow exactly) ━━━\n${learnedRules.map(r => r.ruleText).join("\n")}`;
    }
  } catch { /* non-fatal */ }

  // Order history
  if (orderHistory) {
    systemPrompt += `\n\n━━━ CUSTOMER ORDER HISTORY (QuickBooks) ━━━\n${orderHistory}\nUse to answer questions about past orders. Direct to 469-631-7730 for full invoice PDFs.`;
  }

  if (justAutoVerified) {
    systemPrompt += `\n\n━━━ JUST-VERIFIED HANDOFF ━━━\nCustomer was silently auto-verified. The inbound message may contain an actual order. Process any order content immediately — do NOT just say "you're verified, how can I help?".`;
  }

  // Build message list
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...history.slice(-20).map(m => ({
      role: (m.direction === "inbound" ? "user" : "assistant") as "user" | "assistant",
      content: m.body,
    })),
  ];

  // Current user message (supports MMS)
  if (mediaUrls.length > 0) {
    const parts: OpenAI.Chat.ChatCompletionContentPart[] = [
      { type: "text", text: inboundText || "[Customer sent an image — ask what they need help with]" },
      ...mediaUrls.map(url => ({ type: "image_url" as const, image_url: { url, detail: "high" as const } })),
    ];
    messages.push({ role: "user", content: parts });
  } else {
    messages.push({ role: "user", content: inboundText });
  }

  // ── Tool-calling loop ──────────────────────────────────────────────────────
  let rounds = 0;
  let finalText = "";

  while (rounds < MAX_TOOL_ROUNDS) {
    rounds++;

    const response = await getClient().chat.completions.create({
      model: "gpt-4o",
      messages,
      tools: openAITools.length > 0 ? openAITools : undefined,
      tool_choice: openAITools.length > 0 ? "auto" : undefined,
      max_tokens: mediaUrls.length > 0 ? 600 : 550,
      temperature: 0.7,
    });

    const choice = response.choices[0];

    // GPT wants to call tools
    if (choice.finish_reason === "tool_calls" && choice.message.tool_calls) {
      // Add assistant message with tool_calls
      messages.push(choice.message);

      // Execute each tool call and add results
      for (const call of choice.message.tool_calls) {
        let args: Record<string, any> = {};
        try {
          args = JSON.parse(call.function.arguments);
        } catch {
          args = {};
        }

        const result = executeTool(call.function.name, args, tools, toolContext);

        console.log(`[Engine] Tool call: ${call.function.name}(${JSON.stringify(args)}) → ${result.success ? "OK" : "ERR"}: ${result.display.substring(0, 100)}`);

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result.success
            ? `TOOL RESULT — ${call.function.name}:\n${result.display}\n\nUse these exact numbers in your response. Do not recalculate.`
            : `TOOL ERROR — ${call.function.name}: ${result.error}. Inform the customer and offer to call the office.`,
        });
      }

      // Continue loop — GPT will now compose response using tool results
      continue;
    }

    // GPT returned a final text response
    finalText = choice.message.content || "Sorry, I hit a snag. Could you repeat that?";
    break;
  }

  if (!finalText) {
    finalText = "Sorry, I hit a snag processing your request. Please call us at 469-631-7730.";
  }

  // ── Parse action tags ──────────────────────────────────────────────────────

  const deliveryMatch = finalText.match(/\[CALC_DELIVERY:\s*(.+?)\]/i);
  if (deliveryMatch) {
    return { type: "calc_delivery", text: finalText.replace(/\[CALC_DELIVERY:\s*.+?\]/i, "").trim(), address: deliveryMatch[1].trim() };
  }

  if (finalText.includes("[CONFIRM_ORDER]")) {
    return { type: "confirm_order", text: finalText.replace("[CONFIRM_ORDER]", "").trim() };
  }

  if (finalText.includes("[CONFIRM_ESTIMATE]")) {
    return { type: "confirm_estimate", text: finalText.replace("[CONFIRM_ESTIMATE]", "").trim() };
  }

  if (finalText.includes("[INFO_COMPLETE]")) {
    return { type: "info_complete", text: finalText.replace("[INFO_COMPLETE]", "").trim() };
  }

  if (finalText.includes("[LOOKUP_ORDERS]")) {
    return { type: "lookup_orders", text: finalText.replace("[LOOKUP_ORDERS]", "").trim() };
  }

  if (finalText.includes("[PLAN_TAKEOFF:")) {
    return { type: "plan_takeoff", text: finalText.replace(/\[PLAN_TAKEOFF:[^\]]*\]/i, "").trim() };
  }

  return { type: "message", text: finalText };
}
