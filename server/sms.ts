/**
 * Twilio SMS sender
 */
import twilio from "twilio";
import * as nodemailer from "nodemailer";

let _client: twilio.Twilio | null = null;

function getClient() {
  if (!_client) {
    _client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return _client;
}

export async function sendSms(to: string, body: string): Promise<void> {
  const from = process.env.TWILIO_PHONE_NUMBER;
  if (!from) throw new Error("TWILIO_PHONE_NUMBER not set");

  // Twilio SMS max is 1600 chars — split if needed
  const chunks = splitMessage(body, 1550);
  for (const chunk of chunks) {
    try {
      await getClient().messages.create({ from, to, body: chunk });
    } catch (err: any) {
      console.error(
        `[Twilio] SMS send FAILED to ${to} — code: ${err?.code} status: ${err?.status} message: ${err?.message}`
      );
      throw err; // re-throw so caller can trigger email fallback
    }
  }
}

// ── Email fallback when SMS is blocked ───────────────────────────────────────
function getEmailTransporter() {
  const user = process.env.GMAIL_USER || process.env.EMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD || process.env.EMAIL_PASS;
  if (user && pass) {
    return nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
  }
  console.warn("[Email] No email credentials configured (GMAIL_USER/GMAIL_APP_PASSWORD not set)");
  return null;
}

export async function sendPaymentLinkEmail(params: {
  to: string;
  customerName: string;
  invoiceNumber: string;
  total: number;
  paymentLink: string;
}): Promise<void> {
  const transporter = getEmailTransporter();
  if (!transporter) {
    console.warn("[Email] No email transport configured — cannot send payment link fallback");
    return;
  }
  await transporter.sendMail({
    from: `"Rebar Concrete Products" <${process.env.GMAIL_USER || process.env.EMAIL_USER || "noreply@rebarconcreteproducts.com"}>`,
    to: params.to,
    subject: `Your Rebar Concrete Products Invoice #${params.invoiceNumber} — Pay Online`,
    text: [
      `Hi ${params.customerName},`,
      ``,
      `Your invoice #${params.invoiceNumber} has been created for $${params.total.toFixed(2)}.`,
      ``,
      `Pay online here:`,
      params.paymentLink,
      ``,
      `Thank you for your business!`,
      `Rebar Concrete Products`,
      `(469) 631-7730`,
      `2112 N Custer Rd, McKinney, TX 75071`,
    ].join("\n"),
    html: `
      <p>Hi ${params.customerName},</p>
      <p>Your invoice <strong>#${params.invoiceNumber}</strong> has been created for <strong>$${params.total.toFixed(2)}</strong>.</p>
      <p><a href="${params.paymentLink}" style="background:#e63946;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">Pay Invoice Now</a></p>
      <p style="color:#666;font-size:13px;">Or copy this link: ${params.paymentLink}</p>
      <hr/>
      <p style="color:#888;font-size:12px;">Rebar Concrete Products &nbsp;|&nbsp; (469) 631-7730 &nbsp;|&nbsp; 2112 N Custer Rd, McKinney, TX 75071</p>
    `,
  });
  console.log(`[Email] Payment link fallback sent to ${params.to} for invoice #${params.invoiceNumber}`);
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, maxLen));
    remaining = remaining.slice(maxLen);
  }
  return chunks;
}

// ── Order verification codes ─────────────────────────────────────────────────
export async function sendVerificationCode(to: string, code: string): Promise<void> {
  const body = `Your Rebar Concrete Products order verification code is: ${code}\n\nThis code expires in 5 minutes. Do not share it.`;
  await sendSms(to, body);
  console.log(`[Verify] Sent verification code to ${to}`);
}

export function isTwilioConfigured(): boolean {
  return !!(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_PHONE_NUMBER
  );
}

export function validateTwilioRequest(
  signature: string,
  url: string,
  params: Record<string, string>
): boolean {
  if (!process.env.TWILIO_AUTH_TOKEN) return false;
  // In production, validate Twilio signature to prevent spoofing
  // In dev mode, skip validation
  if (process.env.NODE_ENV !== "production") return true;
  return twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, signature, url, params);
}

// ── Staff notification on paid invoice ───────────────────────────────────────
const STAFF_PHONES = ["+19452765415", "+14698257551"];
const STAFF_EMAILS = ["Brian@RebarConcreteProducts.com", "Office@RebarConcreteProducts.com"];

export async function sendStaffOrderNotification(params: {
  invoiceNumber: string;
  customerName: string;
  total: number;
  deliveryAddress: string;
  memo: string;
  lines: Array<{ name: string; qty: number; amount: number }>;
  source?: string; // "sms" | "web"
}): Promise<void> {
  const { invoiceNumber, customerName, total, deliveryAddress, memo, lines, source } = params;
  const sourceLabel = source === "web" ? "WEB CHAT ORDER" : "SMS BOT ORDER";

  // Build concise line-item summary (max ~10 lines to keep SMS readable)
  const itemLines = lines
    .slice(0, 10)
    .map(l => `  • ${l.qty > 1 ? l.qty + "x " : ""}${l.name}: $${l.amount.toFixed(2)}`)
    .join("\n");
  const moreItems = lines.length > 10 ? `\n  ...and ${lines.length - 10} more items` : "";

  const deliveryLine = deliveryAddress ? `\nDeliver to: ${deliveryAddress}` : "";
  const memoLine = memo ? `\nNotes: ${memo}` : "";

  const smsBody = [
    `🔔 NEW ${sourceLabel} — Invoice #${invoiceNumber}`,
    `Customer: ${customerName}`,
    `Total: $${total.toFixed(2)}`,
    deliveryLine,
    memoLine,
    ``,
    `Items:`,
    itemLines,
    moreItems,
    ``,
    `View in QBO: https://qbo.intuit.com/app/invoice`,
  ].filter(l => l !== undefined).join("\n").trim();

  const emailHtml = `
    <h2 style="color:#C8D400;background:#1a1a1a;padding:16px;margin:0;">🔔 New ${sourceLabel} — Invoice #${invoiceNumber}</h2>
    <table style="width:100%;font-family:sans-serif;font-size:14px;border-collapse:collapse;">
      <tr><td style="padding:8px 16px;font-weight:bold;">Customer</td><td style="padding:8px 16px;">${customerName}</td></tr>
      <tr style="background:#f9f9f9;"><td style="padding:8px 16px;font-weight:bold;">Total</td><td style="padding:8px 16px;">$${total.toFixed(2)}</td></tr>
      ${deliveryAddress ? `<tr><td style="padding:8px 16px;font-weight:bold;">Deliver To</td><td style="padding:8px 16px;">${deliveryAddress}</td></tr>` : ""}
      ${memo ? `<tr style="background:#f9f9f9;"><td style="padding:8px 16px;font-weight:bold;">Notes</td><td style="padding:8px 16px;">${memo}</td></tr>` : ""}
    </table>
    <h3 style="padding:8px 16px;">Items</h3>
    <ul style="font-family:sans-serif;font-size:14px;">
      ${lines.map(l => `<li>${l.qty > 1 ? l.qty + "x " : ""}${l.name} — $${l.amount.toFixed(2)}</li>`).join("")}
    </ul>
    <p style="padding:8px 16px;"><a href="https://qbo.intuit.com/app/invoice" style="background:#C8D400;color:#111;padding:10px 20px;border-radius:4px;text-decoration:none;font-weight:bold;">View in QuickBooks</a></p>
    <hr/><p style="color:#888;font-size:12px;padding:8px 16px;">Rebar Concrete Products | 2112 N Custer Rd, McKinney TX 75071 | (469) 631-7730</p>
  `;

  const emailText = smsBody;

  // Send SMS to all staff phones
  for (const phone of STAFF_PHONES) {
    try {
      await sendSms(phone, smsBody);
      console.log(`[StaffNotify] SMS sent to ${phone} for invoice #${invoiceNumber}`);
    } catch (err: any) {
      console.error(`[StaffNotify] SMS failed to ${phone}:`, err?.message);
    }
  }

  // Send email to all staff emails
  const transporter = getEmailTransporter();
  if (transporter) {
    for (const email of STAFF_EMAILS) {
      try {
        await transporter.sendMail({
          from: `"Rebar Concrete Products" <${process.env.GMAIL_USER || process.env.EMAIL_USER || "noreply@rebarconcreteproducts.com"}>`,
          to: email,
          subject: `🔔 New ${sourceLabel} — Invoice #${invoiceNumber} | ${customerName} | $${total.toFixed(2)}`,
          text: emailText,
          html: emailHtml,
        });
        console.log(`[StaffNotify] Email sent to ${email} for invoice #${invoiceNumber}`);
      } catch (err: any) {
        console.error(`[StaffNotify] Email failed to ${email}:`, err?.message);
      }
    }
  } else {
    console.warn("[StaffNotify] No email transport configured — staff email skipped");
  }
}
