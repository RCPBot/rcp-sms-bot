/**
 * Clarification Rule Test
 * Tests 5 ambiguous fabrication inputs against the real system prompt.
 * Verifies the bot asks for clarification rather than assuming/calculating.
 * Run: OPENAI_API_KEY=xxx node test-clarification.mjs
 */

import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Exact system prompt (mirrors ai.ts buildSystemPrompt for a verified customer) ──
const SYSTEM_PROMPT = `You are the AI ordering agent for Rebar Concrete Products, a rebar and concrete supply company in McKinney, TX (2112 N Custer Rd, McKinney, TX 75071 | 469-631-7730).

You serve TWO roles:
1. ORDERING AGENT — take orders, quote prices, create invoices
2. CONCRETE CONSTRUCTION EXPERT — answer technical questions about concrete and rebar

━━━━━━━━━━━━━━━━━━━━━━━━━━━
CUSTOMER VERIFICATION (CRITICAL)
━━━━━━━━━━━━━━━━━━━━━━━━━━━
VERIFIED CUSTOMER ON FILE:
- Name: Brian Maddox
- Email: brian@rebarconcreteproducts.com
- Company: N/A
- Stage: ordering
- Delivery address on file: none

━━━━━━━━━━━━━━━━━━━━━━━━━━━
STOCK FABRICATED SHAPES (exact match required)
━━━━━━━━━━━━━━━━━━━━━━━━━━━
We stock these pre-bent shapes at fixed per-piece prices:

STIRRUPS (rectangular, #3 bar only):
- 6"x18" #3: $1.58/ea
- 8"x18" #3: $1.65/ea
- 8"x24" #3: $1.95/ea

CORNER BARS (L-shape, 2ft×2ft only):
- #4 Corner Bar 2ft×2ft: $2.15/ea
- #5 Corner Bar 2ft×2ft: $3.35/ea
- #6 Corner Bar 2ft×2ft: $4.85/ea

RINGS (circular, #3 bar only):
- 8" diameter: $1.05/ea
- 12" diameter: $1.35/ea
- 18" diameter: $1.99/ea
- 24" diameter: $2.65/ea

ANYTHING ELSE = FABRICATION-1 at $0.75/lb:
- Different bar size than listed above (e.g. #4 stirrups, #5 stirrups)
- Different dimensions than listed above (e.g. 12"x24" stirrups, 2ft×4ft corner bars)
- Any shape not listed above (U-bars, J-hooks, hairpins, custom bends, etc.)
- Rings in sizes other than 8", 12", 18", 24"

━━━━━━━━━━━━━━━━━━━━━━━━━━━
CUSTOM FABRICATION QUOTING
━━━━━━━━━━━━━━━━━━━━━━━━━━━
You CAN quote custom fabrication yourself — do NOT say "someone will follow up." Price it at $0.75/lb.

CLARIFICATION RULE (CRITICAL):
Before quoting ANY fabricated item, you MUST know BOTH the bar size AND the dimensions. If either is missing, ask — do NOT assume or guess.
- Customer says "corner bars 6x2" — missing bar size. Ask: "What bar size do you need for those? (#4, #5, #6, etc.)"
- Customer says "#5 corner bars" — missing dimensions. Ask: "What dimensions do you need? (e.g. 2ftx2ft)"
- Customer says "stirrups 12x24" — missing bar size. Ask: "What bar size for those stirrups?"
- NEVER default to #6 or any size. Always ask if not specified.
- Same rule for straight bars: if size is unclear, ask before quoting.
Ask in one short question — don't quote, don't calculate, just ask.

BAR WEIGHT TABLE (lb/ft):
#3=0.376, #4=0.668, #5=1.043, #6=1.502, #7=2.044, #8=2.670, #9=3.400, #10=4.303, #11=5.313

STEPS WHEN A CUSTOMER ORDERS CUSTOM FAB:
1. Calculate cut length from their dimensions (show your work briefly)
2. Calculate: total weight = qty × cut_length_ft × weight_per_ft
3. Calculate: fab price = total_weight × $0.75
4. Calculate: tax = fab price × 0.0825 (McKinney TX 8.25%)
5. Confirm back with customer
6. Wait for customer to confirm — if yes, use [CONFIRM_ORDER]

ALWAYS include tax on EVERY price you quote.
NEVER say you need to check with the team or that someone will follow up on fabrication pricing.

━━━━━━━━━━━━━━━━━━━━━━━━━━━
SMS RESPONSE RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━
- KEEP REPLIES SHORT — max 3–4 sentences. Customers are texting from job sites.
- PLAIN TEXT ONLY. Absolutely no markdown. No **asterisks**, no *italics*, no __underscores__, no # headers, no backticks.
- Numbers for lists are fine (1. 2. 3.) but keep the list short.
- Be direct and practical.`;

// ── Test cases ──────────────────────────────────────────────────────────────────
const TEST_CASES = [
  {
    id: 1,
    label: "Missing bar size — corner bars with dims only",
    input: "I need 200 corner bars 6x2",
    // Bot MUST ask what bar size (#4, #5, #6 etc.) — NOT quote
    expectClarification: true,
    forbiddenPatterns: [/\$[\d,]+/, /lb/, /cut length/i, /weight/i],
    requiredPatterns: [/#[3-9]|bar size|what size/i],
  },
  {
    id: 2,
    label: "Missing dimensions — stirrups with bar size only",
    input: "I need 500 #4 stirrups",
    // Bot MUST ask for dimensions — NOT quote (no stock #4 stirrups exist)
    expectClarification: true,
    forbiddenPatterns: [/\$[\d,]+/, /cut length/i, /total weight/i],
    requiredPatterns: [/dimension|size|wide|tall|what size|\d+.*x.*\d+/i],
  },
  {
    id: 3,
    label: "Missing bar size AND qty — just shape and dims",
    input: "quote me some stirrups 10x20",
    // Bot MUST ask bar size (and possibly qty if it wants)
    expectClarification: true,
    forbiddenPatterns: [/\$[\d,]+/, /total weight/i, /cut length/i],
    requiredPatterns: [/#[3-9]|bar size|what size/i],
  },
  {
    id: 4,
    label: "Missing qty — bar size and dims given but no count",
    input: "I need some #5 corner bars 3x3",
    // Bot MUST ask how many — NOT quote without qty
    expectClarification: true,
    forbiddenPatterns: [/total weight/i, /\$[\d,]+\.\d{2}/],
    requiredPatterns: [/how many|quantity|qty|count|pieces|pc/i],
  },
  {
    id: 5,
    label: "Missing bar size — L-bars with dims and qty",
    input: "I need 150 L-bars 4ft x 2ft",
    // Bot MUST ask bar size
    expectClarification: true,
    forbiddenPatterns: [/\$[\d,]+/, /total weight/i, /cut length/i],
    requiredPatterns: [/#[3-9]|bar size|what size/i],
  },
];

// ── Evaluate a single test ───────────────────────────────────────────────────
async function runTest(tc) {
  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: tc.input },
    ],
    max_tokens: 300,
    temperature: 0.3, // lower temp for more deterministic/rule-following output
  });

  const reply = response.choices[0].message.content || "";

  const forbidden = tc.forbiddenPatterns.filter(p => p.test(reply));
  const required = tc.requiredPatterns.filter(p => !p.test(reply));

  const passed = forbidden.length === 0 && required.length === 0;

  return { reply, passed, forbidden, required };
}

// ── Main ─────────────────────────────────────────────────────────────────────
const results = [];
let passCount = 0;

console.log("\n=== CLARIFICATION RULE TESTS ===\n");

for (const tc of TEST_CASES) {
  process.stdout.write(`Test ${tc.id}: ${tc.label}\n  Input: "${tc.input}"\n  Running...`);
  try {
    const { reply, passed, forbidden, required } = await runTest(tc);
    results.push({ ...tc, reply, passed, forbidden, required });
    if (passed) passCount++;

    const status = passed ? "PASS ✓" : "FAIL ✗";
    console.log(`\r  ${status}\n  Reply: "${reply}"`);
    if (!passed) {
      if (forbidden.length > 0) console.log(`  Forbidden patterns found: ${forbidden.map(p => p.toString()).join(", ")}`);
      if (required.length > 0) console.log(`  Required patterns missing: ${required.map(p => p.toString()).join(", ")}`);
    }
    console.log();
  } catch (err) {
    console.log(`\n  ERROR: ${err.message}\n`);
    results.push({ ...tc, reply: "", passed: false, error: err.message });
  }
}

console.log(`=== RESULTS: ${passCount}/${TEST_CASES.length} passed ===\n`);
if (passCount < TEST_CASES.length) {
  console.log("FAILED tests:");
  results.filter(r => !r.passed).forEach(r => {
    console.log(`  - Test ${r.id}: ${r.label}`);
    console.log(`    Reply: "${r.reply}"`);
  });
  process.exit(1);
} else {
  console.log("All clarification rules are working correctly.");
  process.exit(0);
}
