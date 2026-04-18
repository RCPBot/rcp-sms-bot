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
  const service = process.env.EMAIL_SERVICE;
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;
  if (service && user && pass) {
    return nodemailer.createTransport({ service, auth: { user, pass } });
  }
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
    from: process.env.EMAIL_USER || "noreply@rebarconcreteproducts.com",
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
