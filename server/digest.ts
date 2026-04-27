/**
 * Daily AI Chat Digest
 * Fetches all conversations active in the last 24 hours, uses GPT to summarize
 * each one, flags issues, then sends a branded HTML email to Brian.
 */

import * as nodemailer from "nodemailer";
import OpenAI from "openai";
import { db } from "./storage";
import { conversations, messages, orders } from "@shared/schema";
import { desc, gte, eq } from "drizzle-orm";

const DIGEST_RECIPIENT = "Brian@RebarConcreteProducts.com";
const OFFICE_EMAIL = "Office@RebarConcreteProducts.com";

// ── Email transporter (reuse same setup as cutsheet.ts) ──────────────────────
function getTransporter(): nodemailer.Transporter | null {
  const service = process.env.EMAIL_SERVICE;
  const user    = process.env.EMAIL_USER;
  const pass    = process.env.EMAIL_PASS;

  if (service && user && pass) {
    return nodemailer.createTransport({ service, auth: { user, pass } });
  }

  const sgKey = process.env.SENDGRID_API_KEY;
  if (sgKey) {
    return nodemailer.createTransport({
      host: "smtp.sendgrid.net",
      port: 587,
      auth: { user: "apikey", pass: sgKey },
    });
  }

  return null;
}

// ── GPT summary for one conversation ─────────────────────────────────────────
async function summarizeConversation(
  msgs: { direction: string; body: string; createdAt: Date }[],
  customerName: string | null,
  customerPhone: string,
  hasOrder: boolean,
): Promise<{ summary: string; flags: string[]; sentiment: "good" | "neutral" | "issue" }> {

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const transcript = msgs
    .map(m => `[${m.direction === "inbound" ? "Customer" : "Bot"}] ${m.body}`)
    .join("\n");

  const prompt = `You are reviewing an AI chatbot conversation for Rebar Concrete Products, a construction materials supplier.

Customer: ${customerName || "Unknown"} (${customerPhone})
Invoice created: ${hasOrder ? "Yes" : "No"}

TRANSCRIPT:
${transcript}

Respond with valid JSON only — no markdown, no code fences:
{
  "summary": "2-3 sentence plain-English summary of what happened in this conversation",
  "flags": ["array of specific issues or things that need correction — bot errors, confused customer, wrong pricing, unanswered question, etc. Empty array if none."],
  "sentiment": "good" | "neutral" | "issue"
}

sentiment guide:
- "good" = smooth conversation, customer got what they needed, invoice created or clear next step
- "neutral" = conversation happened but no issue and no invoice (browsing, questions only)
- "issue" = bot made an error, customer seemed frustrated, conversation stalled, pricing looked wrong, anything that needs attention`;

  try {
    const res = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      max_tokens: 400,
    });

    const parsed = JSON.parse(res.choices[0].message.content || "{}");
    return {
      summary: parsed.summary || "No summary available.",
      flags: Array.isArray(parsed.flags) ? parsed.flags : [],
      sentiment: ["good", "neutral", "issue"].includes(parsed.sentiment) ? parsed.sentiment : "neutral",
    };
  } catch {
    return { summary: "Could not generate summary.", flags: [], sentiment: "neutral" };
  }
}

// ── Build HTML email ──────────────────────────────────────────────────────────
function buildHtml(
  date: string,
  stats: { total: number; withOrders: number; issues: number },
  sections: string[],
): string {
  const sentimentColor = stats.issues > 0 ? "#e53e3e" : "#38a169";
  const sentimentLabel = stats.issues > 0 ? `${stats.issues} need${stats.issues === 1 ? "s" : ""} attention` : "All clear";

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { margin:0; padding:0; background:#f4f4f4; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color:#1a1a1a; }
  .wrapper { max-width:680px; margin:0 auto; padding:24px 12px; }
  .header { background:#16161d; border-radius:10px 10px 0 0; padding:24px 32px; }
  .header-logo { color:#C8D400; font-size:22px; font-weight:800; letter-spacing:0.5px; }
  .header-sub { color:#aaa; font-size:13px; margin-top:4px; }
  .stats-bar { background:#2a2a2d; padding:20px 32px; display:flex; gap:32px; flex-wrap:wrap; }
  .stat { text-align:center; }
  .stat-num { color:#C8D400; font-size:28px; font-weight:800; line-height:1; }
  .stat-label { color:#999; font-size:12px; margin-top:4px; text-transform:uppercase; letter-spacing:0.5px; }
  .status-banner { padding:12px 32px; font-size:13px; font-weight:600; color:#fff; background:${sentimentColor}; }
  .body { background:#fff; padding:24px 32px; border-radius:0 0 10px 10px; }
  .conv { border:1px solid #e8e8e8; border-radius:8px; margin-bottom:20px; overflow:hidden; }
  .conv-header { padding:12px 16px; background:#f9f9f9; border-bottom:1px solid #e8e8e8; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; }
  .conv-name { font-weight:700; font-size:15px; }
  .conv-phone { color:#666; font-size:13px; }
  .conv-meta { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .badge { display:inline-block; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.4px; }
  .badge-good { background:#e6f4ea; color:#1e7e34; }
  .badge-neutral { background:#f0f0f0; color:#555; }
  .badge-issue { background:#fde8e8; color:#c0392b; }
  .badge-invoice { background:#e8f0fe; color:#1a56db; }
  .conv-body { padding:14px 16px; }
  .summary { font-size:14px; line-height:1.6; color:#333; margin-bottom:10px; }
  .flags { margin-top:10px; }
  .flag-title { font-size:12px; font-weight:700; color:#c0392b; text-transform:uppercase; letter-spacing:0.4px; margin-bottom:6px; }
  .flag-item { font-size:13px; color:#555; padding:6px 10px; background:#fff5f5; border-left:3px solid #e53e3e; border-radius:0 4px 4px 0; margin-bottom:4px; }
  .msg-count { font-size:12px; color:#999; }
  .footer { text-align:center; padding:20px; color:#999; font-size:12px; }
  .no-convs { text-align:center; padding:40px; color:#999; font-size:15px; }
</style>
</head>
<body>
<div class="wrapper">
  <div class="header">
    <div class="header-logo">RCP AI ASSISTANT</div>
    <div class="header-sub">Daily Chat Digest &mdash; ${date}</div>
  </div>
  <div class="stats-bar">
    <div class="stat"><div class="stat-num">${stats.total}</div><div class="stat-label">Conversations</div></div>
    <div class="stat"><div class="stat-num">${stats.withOrders}</div><div class="stat-label">Invoices Created</div></div>
    <div class="stat"><div class="stat-num">${stats.issues}</div><div class="stat-label">Need Attention</div></div>
  </div>
  <div class="status-banner">${sentimentLabel}</div>
  <div class="body">
    ${sections.length === 0
      ? `<div class="no-convs">No conversations yesterday. Quiet day!</div>`
      : sections.join("\n")}
  </div>
</div>
<div class="footer">Rebar Concrete Products &bull; 2112 N Custer Rd, McKinney TX &bull; Mon&ndash;Fri 6am&ndash;3pm</div>
</body>
</html>`;
}

function buildConvSection(params: {
  customerName: string | null;
  customerPhone: string;
  msgCount: number;
  hasOrder: boolean;
  summary: string;
  flags: string[];
  sentiment: "good" | "neutral" | "issue";
}): string {
  const displayName = params.customerName || "Unknown Customer";
  const badgeClass = `badge-${params.sentiment}`;
  const badgeText = params.sentiment === "good" ? "Good" : params.sentiment === "issue" ? "Needs Attention" : "Neutral";

  const flagsHtml = params.flags.length > 0
    ? `<div class="flags">
        <div class="flag-title">&#9888; Issues Found</div>
        ${params.flags.map(f => `<div class="flag-item">${escHtml(f)}</div>`).join("")}
       </div>`
    : "";

  const invoiceBadge = params.hasOrder
    ? `<span class="badge badge-invoice">Invoice Created</span>`
    : "";

  return `<div class="conv">
  <div class="conv-header">
    <div>
      <div class="conv-name">${escHtml(displayName)}</div>
      <div class="conv-phone">${escHtml(params.customerPhone)} &bull; <span class="msg-count">${params.msgCount} messages</span></div>
    </div>
    <div class="conv-meta">
      ${invoiceBadge}
      <span class="badge ${badgeClass}">${badgeText}</span>
    </div>
  </div>
  <div class="conv-body">
    <div class="summary">${escHtml(params.summary)}</div>
    ${flagsHtml}
  </div>
</div>`;
}

function escHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function sendDailyDigest(): Promise<{ sent: boolean; reason?: string }> {
  const transporter = getTransporter();
  if (!transporter) {
    console.warn("[Digest] No email transport configured — skipping digest.");
    return { sent: false, reason: "No email transport configured" };
  }

  // Fetch conversations updated in the last 24 hours
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const recentConvs = await db
    .select()
    .from(conversations)
    .where(gte(conversations.updatedAt, since))
    .orderBy(desc(conversations.updatedAt));

  // Date label for subject/header (yesterday in CDT)
  const dateLabel = since.toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
    timeZone: "America/Chicago",
  });

  if (recentConvs.length === 0) {
    // Still send a quiet-day email so Brian knows the system is running
    const html = buildHtml(dateLabel, { total: 0, withOrders: 0, issues: 0 }, []);
    await transporter.sendMail({
      from: `"RCP AI Assistant" <${process.env.EMAIL_USER || OFFICE_EMAIL}>`,
      to: DIGEST_RECIPIENT,
      subject: `RCP AI Digest — ${dateLabel} — No activity`,
      html,
    });
    return { sent: true };
  }

  // Fetch messages + orders for each conversation in parallel
  const enriched = await Promise.all(
    recentConvs.map(async conv => {
      const [msgs, convOrders] = await Promise.all([
        db.select().from(messages).where(eq(messages.conversationId, conv.id)),
        db.select().from(orders).where(eq(orders.conversationId, conv.id)),
      ]);
      return { conv, msgs, hasOrder: convOrders.length > 0 };
    })
  );

  // Summarize each conversation with GPT (rate-limit: stagger slightly)
  const sections: string[] = [];
  let issueCount = 0;
  let orderCount = 0;

  for (const { conv, msgs, hasOrder } of enriched) {
    if (msgs.length === 0) continue; // Skip empty conversations

    const { summary, flags, sentiment } = await summarizeConversation(
      msgs.map(m => ({ direction: m.direction, body: m.body, createdAt: m.createdAt! })),
      conv.customerName ?? null,
      conv.phone,
      hasOrder,
    );

    if (sentiment === "issue") issueCount++;
    if (hasOrder) orderCount++;

    sections.push(buildConvSection({
      customerName: conv.customerName ?? null,
      customerPhone: conv.phone,
      msgCount: msgs.length,
      hasOrder,
      summary,
      flags,
      sentiment,
    }));

    // Small delay to avoid hammering OpenAI
    await new Promise(r => setTimeout(r, 300));
  }

  const html = buildHtml(
    dateLabel,
    { total: enriched.filter(e => e.msgs.length > 0).length, withOrders: orderCount, issues: issueCount },
    sections,
  );

  const subjectFlag = issueCount > 0 ? ` ⚠️ ${issueCount} issue${issueCount > 1 ? "s" : ""}` : " ✓ All clear";
  await transporter.sendMail({
    from: `"RCP AI Assistant" <${process.env.EMAIL_USER || OFFICE_EMAIL}>`,
    to: DIGEST_RECIPIENT,
    subject: `RCP AI Digest — ${dateLabel}${subjectFlag}`,
    html,
  });

  console.log(`[Digest] Sent daily digest to ${DIGEST_RECIPIENT} — ${enriched.length} conversations, ${issueCount} issues`);
  return { sent: true };
}
