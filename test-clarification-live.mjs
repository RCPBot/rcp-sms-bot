/**
 * Clarification Rule Live Test
 * Uses Brian Maddox's real phone (+16822694416) which is verified in QBO.
 * Sends each test input as a new message in sequence and checks bot replies.
 * Run: node test-clarification-live.mjs
 */

const BASE_URL = "https://rcp-sms-bot-production.up.railway.app";
const TEST_PHONE = "+16822694416"; // Brian Maddox — verified in QBO

const TEST_CASES = [
  {
    id: 1,
    label: "Missing bar size — corner bars with dims only",
    input: "I need 200 corner bars 6x2",
    passIf: (reply) => {
      const hasPrice = /\$[\d,]+\.\d{2}/.test(reply);
      const hasWeight = /\d+\s*(lb|lbs)/i.test(reply) && /total/i.test(reply);
      const askingBarSize = /#[3-9]|bar size|which size|what size|what bar|bar number/i.test(reply);
      return !hasPrice && !hasWeight && askingBarSize;
    },
    failReason: (reply) => {
      const issues = [];
      if (/\$[\d,]+\.\d{2}/.test(reply)) issues.push("quoted a dollar amount without knowing bar size");
      if (/\d+\s*(lb|lbs)/i.test(reply) && /total/i.test(reply)) issues.push("calculated weight without knowing bar size");
      if (!/#[3-9]|bar size|which size|what size|what bar|bar number/i.test(reply)) issues.push("did not ask for bar size");
      return issues.join("; ") || "unknown";
    },
  },
  {
    id: 2,
    label: "Missing dimensions — #4 stirrups, no size given",
    input: "I need 500 #4 stirrups",
    passIf: (reply) => {
      const hasPrice = /\$[\d,]+\.\d{2}/.test(reply);
      const hasWeight = /total weight/i.test(reply);
      const askingDims = /dimension|how wide|how tall|what size|width|height|\d+[\"x]\d+\?|inches|size of|measurements/i.test(reply);
      return !hasPrice && !hasWeight && askingDims;
    },
    failReason: (reply) => {
      const issues = [];
      if (/\$[\d,]+\.\d{2}/.test(reply)) issues.push("quoted a dollar amount without knowing dimensions");
      if (/total weight/i.test(reply)) issues.push("calculated total weight without knowing dimensions");
      if (!/dimension|how wide|how tall|what size|width|height|\d+[\"x]\d+\?|inches|size of|measurements/i.test(reply)) issues.push("did not ask for dimensions");
      return issues.join("; ") || "unknown";
    },
  },
  {
    id: 3,
    label: "Missing bar size AND qty — shape and dims only",
    input: "quote me some stirrups 10x20",
    passIf: (reply) => {
      const hasPrice = /\$[\d,]+\.\d{2}/.test(reply);
      const hasWeight = /total weight/i.test(reply);
      const askingBarSize = /#[3-9]|bar size|which size|what size|what bar|bar number/i.test(reply);
      return !hasPrice && !hasWeight && askingBarSize;
    },
    failReason: (reply) => {
      const issues = [];
      if (/\$[\d,]+\.\d{2}/.test(reply)) issues.push("quoted a price without knowing bar size");
      if (/total weight/i.test(reply)) issues.push("calculated weight without knowing bar size");
      if (!/#[3-9]|bar size|which size|what size|what bar|bar number/i.test(reply)) issues.push("did not ask for bar size");
      return issues.join("; ") || "unknown";
    },
  },
  {
    id: 4,
    label: "Missing qty — bar size and dims given, no count",
    input: "I need some #5 corner bars 3x3",
    passIf: (reply) => {
      const hasFullPriceCalc = /total weight/i.test(reply) || (/\$[\d,]+\.\d{2}/.test(reply) && /total/i.test(reply));
      const askingQty = /how many|quantity|qty|count|how much|pieces|number of/i.test(reply);
      return !hasFullPriceCalc && askingQty;
    },
    failReason: (reply) => {
      const issues = [];
      if (/total weight/i.test(reply)) issues.push("calculated total weight without knowing quantity");
      if (/\$[\d,]+\.\d{2}/.test(reply) && /total/i.test(reply)) issues.push("quoted a total price without knowing quantity");
      if (!/how many|quantity|qty|count|how much|pieces|number of/i.test(reply)) issues.push("did not ask for quantity");
      return issues.join("; ") || "unknown";
    },
  },
  {
    id: 5,
    label: "Missing bar size — L-bars with dims and qty",
    input: "I need 150 L-bars 4ft x 2ft",
    passIf: (reply) => {
      const hasPrice = /\$[\d,]+\.\d{2}/.test(reply);
      const hasWeight = /total weight/i.test(reply);
      const askingBarSize = /#[3-9]|bar size|which size|what size|what bar|bar number/i.test(reply);
      return !hasPrice && !hasWeight && askingBarSize;
    },
    failReason: (reply) => {
      const issues = [];
      if (/\$[\d,]+\.\d{2}/.test(reply)) issues.push("quoted a price without knowing bar size");
      if (/total weight/i.test(reply)) issues.push("calculated weight without knowing bar size");
      if (!/#[3-9]|bar size|which size|what size|what bar|bar number/i.test(reply)) issues.push("did not ask for bar size");
      return issues.join("; ") || "unknown";
    },
  },
];

// ── Send one SMS to the inbound webhook ─────────────────────────────────────
async function sendSms(body) {
  const params = new URLSearchParams({
    From: TEST_PHONE,
    Body: body,
    NumMedia: "0",
    To: "+18178800900",
    MessageSid: `SM_test_${Date.now()}_${Math.random().toString(36).slice(2)}`,
  });
  const res = await fetch(`${BASE_URL}/api/sms/inbound`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  return res.ok;
}

// ── Get the latest outbound message after a given timestamp ──────────────────
async function waitForReply(afterMs, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1200));
    const res = await fetch(`${BASE_URL}/api/conversations`);
    const convs = await res.json();
    const conv = convs.find(c => c.phone === TEST_PHONE);
    if (!conv) continue;

    const detailRes = await fetch(`${BASE_URL}/api/conversations/${conv.id}`);
    const detail = await detailRes.json();
    const msgs = (detail.messages || []).filter(
      m => m.direction === "outbound" && new Date(m.createdAt).getTime() > afterMs
    );
    if (msgs.length > 0) return msgs[msgs.length - 1].body;
  }
  return null;
}

// ── Ensure conversation is in ordering stage ──────────────────────────────────
async function ensureVerified() {
  // Check current state
  const res = await fetch(`${BASE_URL}/api/conversations`);
  const convs = await res.json();
  const conv = convs.find(c => c.phone === TEST_PHONE);

  if (conv && conv.verified && conv.stage === "ordering") {
    // Already good — reset completed status so bot accepts new messages
    console.log("  (conversation already verified and in ordering stage)");
    return conv;
  }

  // Send a greeting to create/reactivate the conversation
  const greetAt = Date.now();
  await sendSms("Hi");
  const greetReply = await waitForReply(greetAt, 15000);
  console.log(`  Greeting reply: "${greetReply?.slice(0, 80)}..."`);

  // Send identity to trigger QBO verification
  const verifyAt = Date.now();
  await sendSms("Brian Maddox 469-631-7730");
  const verifyReply = await waitForReply(verifyAt, 15000);
  console.log(`  Verify reply: "${verifyReply?.slice(0, 80)}..."`);

  return null;
}

// ── Main ─────────────────────────────────────────────────────────────────────
const results = [];
let passCount = 0;

console.log("\n=== CLARIFICATION RULE LIVE TESTS ===");
console.log(`Target: ${BASE_URL}`);
console.log(`Test phone: ${TEST_PHONE} (Brian Maddox — pre-verified in QBO)\n`);

// Make sure we start from a verified ordering state
console.log("Ensuring bot is in verified ordering stage...");
await ensureVerified();

// Give it a moment to settle
await new Promise(r => setTimeout(r, 2000));

for (const tc of TEST_CASES) {
  console.log(`\nTest ${tc.id}: ${tc.label}`);
  console.log(`  Input: "${tc.input}"`);
  process.stdout.write(`  Waiting for reply...`);

  try {
    const sentAt = Date.now();
    await sendSms(tc.input);
    const reply = await waitForReply(sentAt, 25000);

    if (!reply) {
      console.log(`\r  FAIL ✗ — no reply within 25s`);
      results.push({ ...tc, reply: null, passed: false });
      continue;
    }

    const passed = tc.passIf(reply);
    if (passed) passCount++;

    const status = passed ? "PASS ✓" : "FAIL ✗";
    console.log(`\r  ${status}`);
    console.log(`  Reply: "${reply}"`);
    if (!passed) console.log(`  Problem: ${tc.failReason(reply)}`);
    results.push({ ...tc, reply, passed });

    // Small pause between tests so the conversation stays clean
    await new Promise(r => setTimeout(r, 1500));
  } catch (err) {
    console.log(`\r  ERROR: ${err.message}`);
    results.push({ ...tc, reply: null, passed: false, error: err.message });
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${"=".repeat(50)}`);
console.log(`RESULTS: ${passCount}/${TEST_CASES.length} passed\n`);

results.forEach(r => {
  const icon = r.passed ? "✓" : "✗";
  console.log(`  ${icon} Test ${r.id}: ${r.label}`);
  if (!r.passed) {
    console.log(`      Input:   "${r.input}"`);
    console.log(`      Reply:   "${r.reply}"`);
    if (r.error) console.log(`      Error:   ${r.error}`);
    else console.log(`      Problem: ${r.failReason ? r.failReason(r.reply || "") : "see above"}`);
  }
});

console.log();
if (passCount === TEST_CASES.length) {
  console.log("All clarification rules working correctly on the live bot.");
  process.exit(0);
} else {
  console.log(`${TEST_CASES.length - passCount} test(s) failed. Review prompts and re-run.`);
  process.exit(1);
}
