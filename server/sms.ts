/**
 * Twilio SMS sender
 */
import twilio from "twilio";

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
    await getClient().messages.create({ from, to, body: chunk });
  }
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
