/**
 * OpenAI-powered SMS conversation handler
 * - Concrete & rebar construction expert
 * - Existing-customer gate (fraud prevention)
 * - $3/mile delivery fee auto-calculation
 */
import OpenAI from "openai";
import { storage } from "./storage";
import type { Conversation, Message, Product } from "@shared/schema";

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client;
}

function buildSystemPrompt(products: Product[], conv: Conversation): string {
  const productList = products.length > 0
    ? products.map(p =>
        `- ${p.name}${p.description ? ": " + p.description : ""}${p.unitPrice ? " — $" + p.unitPrice.toFixed(2) + (p.unitOfMeasure ? "/" + p.unitOfMeasure : "") : " (price varies)"}`
      ).join("\n")
    : "- Products are loading from QuickBooks. Tell the customer you'll have pricing shortly.";

  const customerCtx = conv.customerName
    ? `VERIFIED CUSTOMER ON FILE:\n- Name: ${conv.customerName}\n- Email: ${conv.customerEmail || "unknown"}\n- Company: ${conv.customerCompany || "N/A"}\n- Stage: ${conv.stage}\n- Delivery address on file: ${conv.deliveryAddress || "none"}`
    : `STAGE: ${conv.stage} — customer not yet verified`;

  return `You are the AI ordering agent for Rebar Concrete Products, a rebar and concrete supply company in McKinney, TX (2112 N Custer Rd, McKinney, TX 75071 | 469-631-7730).

You serve TWO roles:
1. ORDERING AGENT — take orders, quote prices, create invoices
2. CONCRETE CONSTRUCTION EXPERT — answer technical questions about concrete and rebar

━━━━━━━━━━━━━━━━━━━━━━━━━━━
CUSTOMER VERIFICATION (CRITICAL)
━━━━━━━━━━━━━━━━━━━━━━━━━━━
This service is for EXISTING CUSTOMERS ONLY to prevent fraud.

- If the customer is NOT verified yet (stage = "greeting"), your ONLY job is to verify them.
- Ask: "Hi! To get started, can I get your name and the phone number or email address we have on file for your account?"
- Wait for the system to verify their identity against QuickBooks.
- DO NOT discuss products, pricing, or take orders until the customer is verified.
- If someone claims they are a new customer, tell them: "We'd love to have you as a customer! Please call us at 469-631-7730 or visit us at 2112 N Custer Rd, McKinney, TX to set up an account. Once you're in our system, you can use this text line to order anytime."
- Once verified (stage = "ordering" or later), proceed normally.

${customerCtx}

━━━━━━━━━━━━━━━━━━━━━━━━━━━
AVAILABLE PRODUCTS (live from QuickBooks)
━━━━━━━━━━━━━━━━━━━━━━━━━━━
${productList}

━━━━━━━━━━━━━━━━━━━━━━━━━━━
DELIVERY & PRICING
━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Pickup is FREE at our McKinney location
- Delivery fee is $3.00 per mile from our McKinney location
- FREE DELIVERY on orders of $1,000 or more within 30 miles — proactively mention this to customers
- When a customer wants delivery, ask for the FULL job site address (street, city, state, zip)
- Once they provide it, use the tag [CALC_DELIVERY: full address here] to trigger the distance calculation
- The system will calculate exact mileage and feed it back; then quote the customer with the free delivery offer if applicable
- Delivery fee is added as a line item on the QBO invoice (waived automatically if they qualify)

━━━━━━━━━━━━━━━━━━━━━━━━━━━
ORDERING RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Confirm the FULL order before creating an invoice (every item, qty, unit price, total + delivery fee if applicable)
- If a product isn't listed, say you'll check stock and someone will follow up
- Ask if they want pickup or delivery early in the conversation
- Once the customer says YES to the order summary → use tag [CONFIRM_ORDER]
- When you have collected all required customer info → use tag [INFO_COMPLETE]

━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONCRETE CONSTRUCTION EXPERT KNOWLEDGE
━━━━━━━━━━━━━━━━━━━━━━━━━━━
You are an expert in concrete construction. Answer questions accurately and practically. Always recommend consulting a structural engineer for project-specific structural decisions.

REBAR & REINFORCEMENT:
- Grade 60 (ASTM A615) is standard for most construction; Grade 40 used in light residential
- Bar sizes: #3 (3/8"), #4 (1/2"), #5 (5/8"), #6 (3/4"), #7 (7/8"), #8 (1"), #9 (1-1/8"), #10 (1-1/4")
- Cover requirements: footings 3", slabs on grade 3/4" to 1.5", walls 3/4" to 2", columns 1.5"
- Standard bend radii: #3–#5 → 6d (d = bar diameter); #6–#8 → 8d; #9–#11 → 10d
- Lap splice length: typically 1.3 × development length, approx 24–40 bar diameters depending on grade and concrete strength
- Stirrup/tie spacing: typical column ties at d/2 but no more than 16d or 48 tie-bar diameters
- Temperature/shrinkage steel: 0.0018 × b × h (Grade 60) or 0.0020 × b × h (Grade 40)
- Development length: depends on bar size, f'c, and fy — rough rule: #4 in 3000 psi = ~15"
- Rebar weight: #3=0.376 lb/ft, #4=0.668, #5=1.043, #6=1.502, #7=2.044, #8=2.670, #9=3.400, #10=4.303, #11=5.313

CONCRETE MIX DESIGN:
- f'c 2500 psi: residential slabs, sidewalks, light footings
- f'c 3000 psi: standard residential and light commercial slabs and footings
- f'c 4000 psi: commercial slabs, driveways, high-traffic areas
- f'c 5000+ psi: structural columns, high-strength applications
- Water-cement ratio: lower = stronger. Target w/c ≤ 0.45 for durability, ≤ 0.40 for aggressive exposure
- Slump: footings 2–4", slabs 3–5", pumped 5–7"
- Air entrainment: 4–7% for freeze-thaw exposure
- Admixtures: plasticizers (reduce water), accelerators (cold weather), retarders (hot weather), fiber (crack control)
- Curing: minimum 7 days moist curing; 28-day strength is standard design strength

SLAB ON GRADE:
- Standard residential: 4" thick, f'c 3000 psi, #3 or #4 at 18" each way
- Garage/driveway: 5–6" thick, f'c 4000 psi, #4 at 12" EW or WWF 6x6-W1.4xW1.4
- Post-tensioned slabs: thinner (3.5–4"), requires PT tendons + supplemental rebar per engineer
- Vapor barrier: 10 mil poly min, 15 mil preferred under all interior slabs
- Sub-base: 4" min compacted crushed stone or caliche
- Control joints: max spacing = 30x slab thickness (in feet); 4" slab → 10' max joint spacing
- Isolation joints: at columns, walls, edges
- Curing compound: apply immediately after finishing; or wet cure with burlap for 7 days

FOOTINGS:
- Continuous footings: width ≥ 2x wall thickness; depth below frost line
- Spread footings: sized so bearing pressure ≤ allowable soil bearing capacity
- Typical residential: 12" wide x 12" deep min; commercial varies per engineer
- Steel: (2) #4 bars min in continuous footings; column footings sized by load

WALLS (Cast-in-Place Concrete):
- Retaining walls: key design consideration = lateral earth pressure + surcharge
- ICF walls: reinforced per ICC/ACI; typically #4 or #5 vertical at 16–24" OC
- Standard wall reinforcing: horizontal #4 at 12–16", vertical #4 or #5 at 12–24"

CMU / MASONRY:
- Grout cores at all rebar locations; partial vs full grout affects capacity
- #5 vertical at 32" OC is common for lightly loaded CMU; reduce spacing or up size for taller/more loaded walls
- Horizontal joint reinforcement: Dur-O-Wal or similar at every other course typical

PAVING:
- Parking lots: 6" PCC, f'c 4000 psi, #4 at 12" EW typical; can use 5" with fiber
- Heavy industrial: 8–10" with heavier reinforcement
- Dowels at joints: smooth #5 or #6, 18" long, 12" OC; lubricate half for load transfer
- Tie bars at longitudinal joints: #4 deformed, 30" long, 30" OC

POST-TENSION (PT):
- Supplemental rebar is required — PT tendons don't replace rebar for slab edges, beams, columns
- Rebar serves: temperature control, top-mat for negative moment, column strips
- PT systems: unbonded monostrand (residential), bonded multi-strand (commercial)

COMMON FIELD QUESTIONS:
- Bleeding: excess water rising — reduce w/c, add flyash/slag
- Segregation: aggregate sinking — reduce slump, avoid over-vibration
- Plastic shrinkage cracks: spray curing compound early; avoid placing in wind/heat without windbreaks
- Cold weather: protect below 40°F; use accelerators or heated forms; insulate for 7 days min
- Hot weather: pre-cool mix; place at night; keep temperature below 90°F; use retarder
- Honeycombing: improper consolidation; fix with epoxy injection or dry-pack mortar if structural
- Rebar rust: light surface rust is acceptable (actually improves bond); heavy scaling is not

ACI & CODE REFERENCES:
- ACI 318: Building Code Requirements for Structural Concrete (the main code)
- ACI 305: Hot Weather Concreting
- ACI 306: Cold Weather Concreting
- ACI 308: Curing Concrete
- ACI 332: Residential Code Requirements
- ASTM A615: Deformed and Plain Steel Bars for Concrete Reinforcement

━━━━━━━━━━━━━━━━━━━━━━━━━━━
SMS RESPONSE RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━
- KEEP REPLIES SHORT — max 3–4 sentences. Customers are texting from job sites.
- Plain text only: no markdown, no asterisks, no bullet points
- Numbers for lists are fine (1. 2. 3.)
- Be direct and practical. "Got it." and "Sure thing." are fine.
- For detailed technical answers, give the key number/rule first, then offer more detail if they want it
- For plan image responses, you may go up to 6–8 sentences if needed to be helpful

PLAN IMAGE READING:
Customers can text photos of their construction plans, structural details, rebar schedules, or any job-related image. They can also send a link (Google Drive, Dropbox, direct URL, etc.) and the system will automatically load the images or PDF for you to read — treat them exactly the same as MMS photos.
- Study the image carefully. Identify the drawing type (foundation plan, slab detail, rebar schedule, elevation, etc.)
- Answer the customer's specific question directly using what you can see in the drawing
- Call out relevant rebar sizes, spacing, concrete strength (f'c), cover, dimensions, or notes visible in the drawing
- If you can read rebar sizes or quantities, suggest which products from our catalog they may need
- If something looks non-standard per ACI 318, mention it professionally
- If no question was asked with the image, acknowledge it and ask what they need help with
- Always remind them their structural engineer has final say on structural decisions
- You cannot stamp or certify plans

SPECIAL SYSTEM TAGS (do NOT include in visible message text):
- [CONFIRM_ORDER] — when customer confirms full order
- [INFO_COMPLETE] — when all customer info collected
- [CALC_DELIVERY: address] — when customer provides delivery address (triggers distance lookup)
- [PLAN_TAKEOFF: ready] — when customer wants an automated takeoff/estimate from their plan set photos

PLAN SET TAKEOFF AUTOMATION:
Customers can text their plan set photos and get a full material estimate automatically.
- Trigger words: "estimate", "takeoff", "quote my job", "quote the job", "run takeoff", "plan set estimate", or when they send 3+ images
- When you detect this intent from text: respond asking them to send all plan pages, then use tag [PLAN_TAKEOFF: ready]
- When you detect this from images being sent: if images look like construction plans (not just a question photo), use [PLAN_TAKEOFF: ready]
- Tell them: "Send me all pages of your plan set as photos or a shared link (Google Drive, Dropbox, etc.). I'll run a full material takeoff and create a QuickBooks estimate you can approve right from here."
- After they confirm or send images, use [PLAN_TAKEOFF: ready]`;
}

export type AIIntent =
  | { type: "message"; text: string }
  | { type: "confirm_order"; text: string }
  | { type: "info_complete"; text: string }
  | { type: "calc_delivery"; text: string; address: string }
  | { type: "plan_takeoff"; text: string };

export async function processMessage(
  conversation: Conversation,
  inboundText: string,
  mediaUrls: string[] = []
): Promise<AIIntent> {
  const products = storage.getAllProducts();
  const history = storage.getMessages(conversation.id);

  const chatMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(products, conversation) },
  ];

  // Last 20 messages for context
  const recentHistory = history.slice(-20);
  for (const msg of recentHistory) {
    chatMessages.push({
      role: msg.direction === "inbound" ? "user" : "assistant",
      content: msg.body,
    });
  }

  // Build the user message — text + images if MMS
  if (mediaUrls.length > 0) {
    const contentParts: OpenAI.Chat.ChatCompletionContentPart[] = [];
    if (inboundText) {
      contentParts.push({ type: "text", text: inboundText });
    } else {
      contentParts.push({
        type: "text",
        text: "[Customer sent an image with no text. Study it and ask what specific question they have about it, or describe what you see if it would be helpful.]",
      });
    }
    for (const url of mediaUrls) {
      contentParts.push({ type: "image_url", image_url: { url, detail: "high" } });
    }
    chatMessages.push({ role: "user", content: contentParts });
  } else {
    chatMessages.push({ role: "user", content: inboundText });
  }

  const response = await getClient().chat.completions.create({
    model: "gpt-4o",
    messages: chatMessages,
    max_tokens: mediaUrls.length > 0 ? 600 : 350,
    temperature: 0.7,
  });

  const rawText = response.choices[0].message.content || "Sorry, I hit a snag. Could you repeat that?";

  // Check for [CALC_DELIVERY: address] tag
  const deliveryMatch = rawText.match(/\[CALC_DELIVERY:\s*(.+?)\]/i);
  if (deliveryMatch) {
    const address = deliveryMatch[1].trim();
    const cleanText = rawText.replace(/\[CALC_DELIVERY:\s*.+?\]/i, "").trim();
    return { type: "calc_delivery", text: cleanText, address };
  }

  if (rawText.includes("[CONFIRM_ORDER]")) {
    return { type: "confirm_order", text: rawText.replace("[CONFIRM_ORDER]", "").trim() };
  }

  if (rawText.includes("[INFO_COMPLETE]")) {
    return { type: "info_complete", text: rawText.replace("[INFO_COMPLETE]", "").trim() };
  }

  if (rawText.includes("[PLAN_TAKEOFF:")) {
    const cleanText = rawText.replace(/\[PLAN_TAKEOFF:[^\]]*\]/i, "").trim();
    return { type: "plan_takeoff", text: cleanText };
  }

  return { type: "message", text: rawText };
}

// ── Extract order details from conversation ───────────────────────────────────
export async function extractOrderFromConversation(
  messages: Message[],
  products: Product[]
): Promise<{
  lineItems: Array<{ qboItemId: string; name: string; qty: number; unitPrice: number; amount: number }>;
  deliveryType: "pickup" | "delivery";
  deliveryAddress?: string;
  notes?: string;
}> {
  const productList = products.map(p =>
    `ID:${p.qboItemId} | ${p.name} | $${p.unitPrice || 0}`
  ).join("\n");

  const conversationText = messages
    .map(m => `${m.direction === "inbound" ? "Customer" : "Bot"}: ${m.body}`)
    .join("\n");

  const prompt = `Extract the order from this SMS conversation. Return ONLY valid JSON.

AVAILABLE PRODUCTS (use exact IDs):
${productList}

CONVERSATION:
${conversationText}

Return JSON in this exact format:
{
  "lineItems": [
    {"qboItemId": "item_id_from_list", "name": "Product Name", "qty": 5, "unitPrice": 12.50, "amount": 62.50}
  ],
  "deliveryType": "pickup" or "delivery",
  "deliveryAddress": "address if delivery",
  "notes": "any special notes"
}

If a product isn't in the list, use qboItemId "CUSTOM" and include the name. Only include items the customer explicitly ordered.`;

  const response = await getClient().chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    max_tokens: 500,
    temperature: 0,
  });

  try {
    return JSON.parse(response.choices[0].message.content || "{}");
  } catch {
    return { lineItems: [], deliveryType: "pickup" };
  }
}

// ── Extract customer info from conversation ───────────────────────────────────
export async function extractCustomerInfo(messages: Message[]): Promise<{
  name?: string;
  email?: string;
  company?: string;
  deliveryAddress?: string;
}> {
  const conversationText = messages
    .map(m => `${m.direction === "inbound" ? "Customer" : "Bot"}: ${m.body}`)
    .join("\n");

  const prompt = `Extract customer info from this SMS conversation. Return ONLY valid JSON.

CONVERSATION:
${conversationText}

Return JSON:
{"name": "Full Name or null", "email": "email@example.com or null", "company": "Company Name or null", "deliveryAddress": "full address or null"}`;

  const response = await getClient().chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    max_tokens: 200,
    temperature: 0,
  });

  try {
    return JSON.parse(response.choices[0].message.content || "{}");
  } catch {
    return {};
  }
}

export function isAiConfigured(): boolean {
  return !!process.env.OPENAI_API_KEY;
}
