import type { Express } from "express";
import type { Server } from "http";
import express from "express";
import { storage } from "./storage";
import { sendSms, isTwilioConfigured, sendPaymentLinkEmail, sendEstimateEmail, sendStaffOrderNotification, sendVerificationCode } from "./sms";
import { processMessage, extractOrderFromConversation, extractCustomerInfo, isAiConfigured } from "./ai";
import { syncProducts, findOrCreateCustomer, findExistingCustomer, createInvoice, createEstimate, getEstimateStatus, lookupCustomerByPhone, calcDeliveryFee, isQboConfigured, getCustomerInvoices, convertEstimateToInvoice, updateRailwayEnvVar, setLiveRefreshToken, getOrCreateBotCustomer, getOrCreateEstCustomer, getQboItems, getInvoiceById, getPurchaseOrders, qboGet } from "./qbo";
import { performTakeoff } from "./takeoff";
import { resolveLinksFromText, extractUrls } from "./link-resolver";
import { generateCutSheetPdf, emailCutSheet, emailCutSheetToCustomer, generatePlacementDrawingPdf, forwardPlansToOffice, generateBidPdf, emailBidPdf, OFFICE_EMAIL } from "./cutsheet";
import { sendDailyDigest } from "./digest";
import type { LineItem } from "@shared/schema";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";


const OWNER_EMAIL = "maddoxconstruction1987@gmail.com";
const TAX_RATE = 0.0825; // McKinney, TX: 8.25% combined sales tax

const orderConfirmationInProgress = new Set<number>();

/**
 * Post-process the AI's outbound quote message — find any qty × bar-size line items,
 * compute exact totals server-side from DB prices, and replace whatever
 * Subtotal/Tax/Total lines the AI wrote with the correct numbers.
 * This ensures the quote message always matches the invoice.
 */
/**
 * Server-side price correction for AI quote messages.
 *
 * Strategy: find the line-item block ("- NNN bars/pcs of #X..."),
 * compute exact subtotal from DB prices, then CUT the entire
 * Subtotal/Tax/Total section the AI wrote and REPLACE it with
 * server-computed exact numbers. No regex arithmetic on the AI text.
 */
async function fixPriceText(text: string, deliveryFee = 0): Promise<string> {
  // Only act if the message contains a subtotal line
  if (!/subtotal/i.test(text)) return text;

  const products = await storage.getAllProducts();

  // ── Step 1: parse line items from the text ───────────────────────────────
  // Match the bullet/dash line items the AI writes:
  // "- 925 bars of #3 (3/8") 20': ..."
  // "• 600x Rebar #3 (3/8") 20': ..."
  // We only look at ITEM lines (starting with - or •), not the intro sentence,
  // to avoid counting the same product twice.
  const lineItemRe = /^[\-•]\s*(\d+)(?:x)?\s*(?:bars?|pcs?|pieces?|sticks?)?\s*(?:of\s+)?(?:Rebar\s+)?#(\d+)[^\n]*(20'|20\s*ft|40'|40\s*ft)?/gim;
  let match: RegExpExecArray | null;
  let subtotal = 0;
  let foundAny = false;

  lineItemRe.lastIndex = 0;
  while ((match = lineItemRe.exec(text)) !== null) {
    const qty = parseInt(match[1], 10);
    const size = match[2];
    const lengthStr = match[3];
    const length = lengthStr && lengthStr.trim().startsWith('40') ? '40' : '20';

    const product = products.find(p => {
      if (!p.unitPrice) return false;
      const name = p.name.toLowerCase();
      return name.includes(`#${size}`) && name.includes(length);
    });

    if (product && product.unitPrice) {
      subtotal += qty * parseFloat(String(product.unitPrice));
      foundAny = true;
    }
  }

  if (!foundAny) return text;

  // ── Step 2: cut everything from "Subtotal:" onward and replace ───────────
  // Work line-by-line: find the Subtotal line, extend through Tax/Delivery/Total,
  // then replace the entire block with server-computed values.
  const lines = text.split('\n');
  const subIdx = lines.findIndex(l => /^subtotal/i.test(l.trim()));
  if (subIdx === -1) return text;

  // Extend endIdx through all price lines (Subtotal / Tax / Delivery / Total)
  let endIdx = subIdx;
  for (let i = subIdx; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/^(subtotal|tax|delivery|total)/i.test(l)) {
      endIdx = i;
    } else if (l === '') {
      // blank line — peek ahead: if next non-blank is a price line, keep going
      const next = lines.slice(i + 1).find(ll => ll.trim() !== '');
      if (next && /^(subtotal|tax|delivery|total)/i.test(next.trim())) continue;
      break;
    } else {
      break;
    }
  }

  const tax = subtotal * TAX_RATE;
  const total = subtotal + tax + deliveryFee;

  const priceLines = [
    `Subtotal: $${subtotal.toFixed(2)}`,
    `Tax (8.25%): $${tax.toFixed(2)}`,
    ...(deliveryFee > 0 ? [`Delivery: $${deliveryFee.toFixed(2)}`] : []),
    `Total: $${total.toFixed(2)}`,
  ];

  const beforeLines = lines.slice(0, subIdx);
  const afterLines = lines.slice(endIdx + 1);
  // Strip leading blank lines from afterLines
  while (afterLines.length && afterLines[0].trim() === '') afterLines.shift();

  const resultLines = [
    ...beforeLines,
    ...priceLines,
    ...(afterLines.length ? ['', ...afterLines] : []),
  ];
  return resultLines.join('\n').trimEnd();
}

// Best-effort parser for "project name + delivery address" customer replies.
// Handles:
//   "Project: Ascension Cottages, 123 Main St, McKinney TX 75071"
//   "Project name is Ascension Cottages. Address 123 Main St, McKinney TX"
//   "Ascension Cottages — 123 Main St, McKinney, TX 75071"
//   "123 Main St, McKinney TX 75071"    (address only)
function parseProjectInfo(raw: string): { name?: string; address?: string } {
  const text = (raw || "").trim();
  if (!text) return {};

  let name: string | undefined;
  let address: string | undefined;

  // 1. Explicit labels
  const nameMatch = text.match(/(?:project(?:\s*name)?|job(?:site)?(?:\s*name)?|site)\s*(?:is|:|=|-)\s*([^,\n.]+)/i);
  if (nameMatch) name = nameMatch[1].trim();
  const addrMatch = text.match(/(?:(?:delivery|project|site|job(?:site)?)\s*address|address|addr)\s*(?:is|:|=|-)\s*(.+)/i);
  if (addrMatch) address = addrMatch[1].trim();

  // 2. Find a street-number-led address anywhere in the text
  if (!address) {
    const streetLike = text.match(/\b\d{1,6}\s+[A-Za-z][A-Za-z0-9.\s]*?(?:St|Street|Rd|Road|Ave|Avenue|Blvd|Boulevard|Ln|Lane|Dr|Drive|Ct|Court|Hwy|Highway|Pkwy|Parkway|Way|Cir|Circle|Ter|Terrace|Pl|Place)\b[^\n]*/i);
    if (streetLike) address = streetLike[0].trim();
  }

  // 3. Split on em-dash / " - " / " — " for "Name — Address" pattern
  if (!name) {
    const dash = text.split(/\s[—–-]\s/);
    if (dash.length >= 2 && /\d/.test(dash[1])) {
      const candidate = dash[0].trim();
      if (candidate.length > 2 && candidate.length < 80 && !/\d{3,}/.test(candidate)) {
        name = candidate;
      }
    }
  }

  // Clean up any trailing punctuation
  if (name) name = name.replace(/[.,;:]+$/, "").trim();
  if (address) address = address.replace(/[.;]+$/, "").trim();

  return { name, address };
}

function isAddressComplete(address: string): boolean {
  // Must have at least a city or zip code
  // A complete address has either:
  // - A comma (separating street from city) OR
  // - A 5-digit zip code OR
  // - A recognizable state abbreviation (TX, CA, etc.)
  const hasComma = address.includes(',');
  const hasZip = /\b\d{5}\b/.test(address);
  const hasState = /\b[A-Z]{2}\b/.test(address); // state abbreviation
  return hasComma || hasZip || hasState;
}

// Sync QBO products on startup, then every 30 minutes
async function startProductSync() {
  if (isQboConfigured()) {
    await syncProducts().catch(console.error);
    setInterval(() => syncProducts().catch(console.error), 30 * 60 * 1000);
  }
}

// ── Shared bundle-breakdown helper ─────────────────────────────────────────
// Bundle quantities per bar size (20' sticks)
const REBAR_BUNDLE_SIZES: Record<string, number> = {
  "#3": 266, "#4": 150, "#5": 96, "#6": 68,
  "#7": 49, "#8": 49, "#9": 49, "#10": 49, "#11": 49,
};

function addBundleDesc(item: LineItem): LineItem {
  // Only applies to rebar line items — skip fabrication, delivery, custom, rings, etc.
  if (item.qboItemId === "1010000301" || item.qboItemId === "CUSTOM") return item;
  // Must look like a rebar product: name contains #3–#11
  const sizeMatch = item.name.match(/(#(\d+))/);
  if (!sizeMatch) return item;
  const barSize = sizeMatch[1];
  const bundleSize = REBAR_BUNDLE_SIZES[barSize];
  if (!bundleSize) return item;
  const pcs = Math.round(item.qty);
  if (pcs <= 0) return item;
  const fullBundles = Math.floor(pcs / bundleSize);
  const remainder = pcs % bundleSize;
  let bundleDesc: string;
  if (fullBundles > 0 && remainder > 0) {
    bundleDesc = `${fullBundles} full bundle${fullBundles > 1 ? "s" : ""} (${fullBundles * bundleSize} pcs) + ${remainder} loose pcs = ${pcs} pcs total`;
  } else if (fullBundles > 0) {
    bundleDesc = `${fullBundles} full bundle${fullBundles > 1 ? "s" : ""} = ${pcs} pcs total`;
  } else {
    bundleDesc = `${pcs} loose pcs (less than 1 full bundle)`;
  }
  const existingDesc = item.description ? `${item.description} | ` : "";
  return { ...item, description: `${existingDesc}${bundleDesc}` };
}

// ── In-memory verification code store ────────────────────────────────────────
// Key: phone (E.164), Value: { code, expiresAt, payload, attempts }
const pendingVerifications = new Map<string, {
  code: string;
  expiresAt: number;
  payload?: any; // stored web-order payload, released after verify
  attempts: number;
}>();

// Phones that have successfully verified (within last 10 min) — allows /api/web-order to proceed
const verifiedWebPhones = new Map<string, number>(); // phone (E.164) -> grantedAt ms

function generateCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6-digit
}

function normalizeVerifyInput(input: string): string {
  // Accept "123456", "123 456", "code is 123456", etc.
  const match = input.replace(/\s/g, "").match(/\d{6}/);
  return match ? match[0] : "";
}
// ─────────────────────────────────────────────────────────────────────────────

export function registerRoutes(httpServer: Server, app: Express) {
  // Register the token-export endpoint FIRST to guarantee no catch-all/static
  // middleware can intercept it. Returns JSON of current QBO refresh token state.

  // GET /api/qbo/items  // GET /api/qbo/items — returns all active QBO items with live pricing
  app.get('/api/qbo/items', async (_req, res) => {
    try {
      if (!isQboConfigured()) {
        return res.status(503).json({ error: 'QBO not configured' });
      }
      const items = await getQboItems();
      res.json({ count: items.length, items, fetchedAt: new Date().toISOString() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/qbo/invoices-with-item?itemKeyword=concrete&days=25
  // Returns invoices in last N days that contain a line item matching itemKeyword
  app.get('/api/qbo/invoices-with-item', async (req, res) => {
    try {
      if (!isQboConfigured()) return res.status(503).json({ error: 'QBO not configured' });
      const keyword = ((req.query.itemKeyword as string) || 'concrete').toLowerCase();
      const days = parseInt((req.query.days as string) || '25', 10);
      const since = new Date();
      since.setDate(since.getDate() - days);
      const sinceDate = since.toISOString().split('T')[0];
      const sql = `SELECT * FROM Invoice WHERE TxnDate >= '${sinceDate}' MAXRESULTS 200`;
      const encoded = encodeURIComponent(sql);
      const invoiceData = await qboGet(`/query?query=${encoded}`);
      const invoices: any[] = invoiceData.QueryResponse?.Invoice || [];
      const matched = invoices
        .map((inv: any) => {
          const concreteLines = (inv.Line || [])
            .filter((l: any) => {
              const name = (l.SalesItemLineDetail?.ItemRef?.name || '').toLowerCase();
              return name.includes(keyword);
            })
            .map((l: any) => ({
              item: l.SalesItemLineDetail?.ItemRef?.name,
              qty: l.SalesItemLineDetail?.Qty,
              unitPrice: l.SalesItemLineDetail?.UnitPrice,
              amount: l.Amount,
            }));
          if (!concreteLines.length) return null;
          return {
            id: inv.Id,
            invoiceNumber: inv.DocNumber,
            date: inv.TxnDate,
            customer: inv.CustomerRef?.name,
            status: inv.Balance > 0 ? 'Outstanding' : 'Paid',
            totalAmt: inv.TotalAmt,
            balance: inv.Balance,
            concreteLines,
          };
        })
        .filter(Boolean);
      res.json({ sinceDate, keyword, count: matched.length, invoices: matched, fetchedAt: new Date().toISOString() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/qbo/purchase-orders?vendor=cowtown&days=25
  // Returns all POs from specified vendor in the last N days, flagging unreceived ones
  app.get('/api/qbo/purchase-orders', async (req, res) => {
    try {
      if (!isQboConfigured()) return res.status(503).json({ error: 'QBO not configured' });
      const vendor = (req.query.vendor as string) || 'cowtown';
      const days = parseInt((req.query.days as string) || '25', 10);
      const since = new Date();
      since.setDate(since.getDate() - days);
      const sinceDate = since.toISOString().split('T')[0];
      const pos = await getPurchaseOrders({ vendorNameContains: vendor, sinceDate });
      const rawMode = req.query.raw === '1';
      if (rawMode) {
        return res.json({ pos: pos.map((po: any) => ({ poNumber: po.DocNumber, memo: po.Memo, lines: po.Line })) });
      }
      const results = pos.map((po: any) => ({
        id: po.Id,
        poNumber: po.DocNumber,
        date: po.TxnDate,
        vendor: po.VendorRef?.name,
        status: po.POStatus,
        received: po.POStatus === 'Closed',
        totalAmt: po.TotalAmt,
        memo: po.Memo,
        lines: (po.Line || []).map((l: any) => ({
          type: l.DetailType,
          description: l.Description || l.ItemBasedExpenseLineDetail?.Description || null,
          item: l.ItemBasedExpenseLineDetail?.ItemRef?.name || l.AccountBasedExpenseLineDetail?.AccountRef?.name || null,
          qty: l.ItemBasedExpenseLineDetail?.Qty || null,
          unitPrice: l.ItemBasedExpenseLineDetail?.UnitPrice || null,
          amount: l.Amount || null,
        })),
      }));
      const unreceived = results.filter((r: any) => !r.received);
      res.json({
        vendor,
        sinceDate,
        total: results.length,
        unreceivedCount: unreceived.length,
        unreceived,
        all: results,
        fetchedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/qbo/token', async (_req, res) => {
    try {
      const token = await storage.getSetting('qbo_refresh_token');
      const envToken = process.env.QBO_REFRESH_TOKEN || '';
      res.json({
        db_token: token || null,
        env_token: envToken ? envToken.substring(0, 20) + '...' : '(not set)',
        source: token ? 'sqlite' : 'env',
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/request-verification ────────────────────────────────────────────
  // Web chat calls this right before checkout — sends a 6-digit code to the customer's phone.
  // Body: { phone: "+15551234567", payload: <full web-order body to hold until verified> }
  app.post("/api/request-verification", express.json(), async (req, res) => {
    try {
      const { phone, payload } = req.body || {};
      if (!phone) return res.status(400).json({ error: "phone is required" });

      // Normalize to E.164
      const digits = phone.replace(/\D/g, "");
      const e164 = digits.length === 10 ? `+1${digits}` : `+${digits}`;

      const code = generateCode();
      const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes
      pendingVerifications.set(e164, { code, expiresAt, payload: payload || null, attempts: 0 });

      await sendVerificationCode(e164, code);
      console.log(`[Verify] Code ${code} issued for ${e164}, expires ${new Date(expiresAt).toISOString()}`);

      res.json({ success: true, message: `Verification code sent to ${e164}` });
    } catch (err: any) {
      console.error("[Verify] request-verification error:", err);
      res.status(500).json({ error: err.message || "Failed to send verification code" });
    }
  });

  // ── POST /api/confirm-verification ───────────────────────────────────────────
  // Web chat submits the code the customer typed. Returns { verified: true } on success.
  // Body: { phone: "+15551234567", code: "123456" }
  app.post("/api/confirm-verification", express.json(), async (req, res) => {
    try {
      const { phone, code } = req.body || {};
      if (!phone || !code) return res.status(400).json({ error: "phone and code are required" });

      const digits = phone.replace(/\D/g, "");
      const e164 = digits.length === 10 ? `+1${digits}` : `+${digits}`;
      const normalized = normalizeVerifyInput(String(code));

      const pending = pendingVerifications.get(e164);
      if (!pending) {
        return res.status(400).json({ error: "No verification pending for this number. Please request a new code." });
      }
      if (Date.now() > pending.expiresAt) {
        pendingVerifications.delete(e164);
        return res.status(400).json({ error: "Code expired. Please request a new code." });
      }
      pending.attempts++;
      if (pending.attempts > 5) {
        pendingVerifications.delete(e164);
        return res.status(429).json({ error: "Too many incorrect attempts. Please request a new code." });
      }
      if (normalized !== pending.code) {
        return res.status(400).json({ error: `Incorrect code. ${6 - pending.attempts} attempt(s) remaining.` });
      }

      // Code matched — release stored payload and clear
      const storedPayload = pending.payload;
      pendingVerifications.delete(e164);
      // Grant web-order token (valid 10 min)
      verifiedWebPhones.set(e164, Date.now());
      console.log(`[Verify] Code verified for ${e164} — web-order token granted`);

      res.json({ verified: true, payload: storedPayload });
    } catch (err: any) {
      console.error("[Verify] confirm-verification error:", err);
      res.status(500).json({ error: err.message || "Verification failed" });
    }
  });

  app.use(express.urlencoded({ extended: false }));
  startProductSync();

  // ── Twilio SMS Webhook ──────────────────────────────────────────────────────
  // Point your Twilio phone number's webhook to: POST /api/sms/inbound
  app.post("/api/sms/inbound", async (req, res) => {
    // Respond to Twilio immediately (prevent timeout)
    res.set("Content-Type", "text/xml");
    res.send("<Response></Response>");

    const { From: fromPhone, Body: messageBody, NumMedia } = req.body;
    if (!fromPhone) return;

    const cleanPhone = fromPhone.trim();
    const cleanBody = (messageBody || "").trim();

    // Log all inbound media for diagnostics
    const numMediaRaw = parseInt(NumMedia || "0", 10);
    if (numMediaRaw > 0) {
      for (let _i = 0; _i < numMediaRaw; _i++) {
        console.log(`[MMS] Inbound media ${_i}: URL=${req.body[`MediaUrl${_i}`]?.substring(0,60)} Type=${req.body[`MediaContentType${_i}`]}`);
      }
    } else {
      console.log(`[SMS] Inbound text-only message from ${cleanPhone}: "${cleanBody.substring(0,60)}"`);
    }

    // Collect any MMS media Twilio sends (images + PDFs)
    // Download with Basic auth — Twilio URLs require it; OpenAI can't fetch them directly.
    const mediaUrls: string[] = [];
    const mmsPdfUrls: string[] = []; // PDFs sent as MMS attachments
    const numMedia = parseInt(NumMedia || "0", 10);
    const accountSid = process.env.TWILIO_ACCOUNT_SID!;
    const authToken = process.env.TWILIO_AUTH_TOKEN!;
    const twilioAuth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

    for (let i = 0; i < numMedia; i++) {
      const url = req.body[`MediaUrl${i}`];
      const type = (req.body[`MediaContentType${i}`] || "").toLowerCase();
      if (!url) continue;

      try {
        const mediaResp = await globalThis.fetch(url, {
          headers: { Authorization: `Basic ${twilioAuth}` },
        });
        if (!mediaResp.ok) {
          console.warn(`[MMS] Could not download Twilio media (${mediaResp.status}): ${url}`);
          continue;
        }
        const mediaBuf = await mediaResp.arrayBuffer();

        if (type.startsWith("image/")) {
          // Image → base64 data URI for OpenAI vision
          const mimeType = type.split(";")[0] || "image/jpeg";
          const b64 = Buffer.from(mediaBuf).toString("base64");
          mediaUrls.push(`data:${mimeType};base64,${b64}`);
          console.log(`[MMS] Downloaded image (${Math.round(mediaBuf.byteLength / 1024)}KB) as base64`);
        } else if (
          type.includes("pdf") ||
          type.includes("msword") ||
          type.includes("officedocument") ||
          type.includes("octet-stream")
        ) {
          // PDF/document → save to /tmp and expose via internal URL for takeoff engine
          const ext = type.includes("pdf") ? ".pdf" : ".pdf";
          const tmpName = `mms_${Date.now()}_${i}${ext}`;
          const tmpPath = path.join(os.tmpdir(), tmpName);
          fs.writeFileSync(tmpPath, Buffer.from(mediaBuf));
          const internalUrl = `http://localhost:${process.env.PORT || 5000}/api/tmp/${tmpName}`;
          mmsPdfUrls.push(internalUrl);
          console.log(`[MMS] Downloaded PDF/doc (${Math.round(mediaBuf.byteLength / 1024)}KB) → ${tmpPath}`);
        } else {
          console.log(`[MMS] Skipped unsupported media type: ${type}`);
        }
      } catch (err: any) {
        console.warn(`[MMS] Failed to download Twilio media: ${err?.message}`);
      }
    }

    // Resolve any links in the message body (Google Drive, Dropbox, direct PDFs, etc.)
    let linkResolveFailed = false;
    const pdfUrls: string[] = []; // PDF URLs for OpenAI Files API
    if (cleanBody) {
      try {
        const resolved = await resolveLinksFromText(cleanBody);
        if (resolved.imageUrls.length > 0) {
          console.log(`[LinkResolver] Resolved ${resolved.resolvedCount} link(s) → ${resolved.imageUrls.length} image(s) from message`);
          mediaUrls.push(...resolved.imageUrls);
        }
        if (resolved.pdfUrls.length > 0) {
          console.log(`[LinkResolver] Resolved ${resolved.pdfUrls.length} PDF(s) from message`);
          pdfUrls.push(...resolved.pdfUrls);
        }
        if (resolved.failedCount > 0) {
          if (resolved.resolvedCount === 0) linkResolveFailed = true;
        }
      } catch (err: any) {
        console.warn(`[LinkResolver] Error resolving links: ${err?.message}`);
        linkResolveFailed = true;
      }
    }

    // Merge MMS PDF attachments into pdfUrls
    if (mmsPdfUrls.length > 0) {
      pdfUrls.push(...mmsPdfUrls);
      console.log(`[MMS] Added ${mmsPdfUrls.length} MMS PDF(s) to pdfUrls`);
    }

    // ── Forward plans to office email (MMS PDFs + any plan links in message) ──
    // Fires whenever a customer sends a PDF (MMS) or a plan link (Dropbox/Drive).
    // Fire-and-forget: never block the webhook response.
    const linkUrls = cleanBody ? extractUrls(cleanBody) : [];
    const customerGotPlans = mmsPdfUrls.length > 0 || pdfUrls.length > 0;
    if (customerGotPlans) {
      try {
        const existingConvForForward = await storage.getConversationByPhone(cleanPhone);
        const mmsLocalPaths = mmsPdfUrls
          .map(u => {
            const m = u.match(/\/api\/tmp\/(.+)$/);
            return m ? path.join(os.tmpdir(), m[1]) : null;
          })
          .filter((p): p is string => !!p);
        forwardPlansToOffice({
          customerName: existingConvForForward?.customerName || "Unknown Customer",
          customerPhone: cleanPhone,
          originalMessage: cleanBody,
          projectDetails: existingConvForForward?.projectName || "",
          pdfPaths: mmsLocalPaths,
          planLinks: linkUrls.length > 0 ? linkUrls : undefined,
        }).catch(e => console.error("[PlanForward] fire-and-forget error:", e));
      } catch (forwardErr: any) {
        console.error(`[PlanForward] error preparing forward: ${forwardErr?.message}`);
      }
    }

    if (mmsPdfUrls.length > 0) {
      // ── Trigger takeoff IMMEDIATELY after MMS PDF download completes ─────
      // Must fire here (inside the async download scope) because the early
      // trigger further down can race or be bypassed by other gating logic.
      try {
        const existingConv = await storage.getConversationByPhone(cleanPhone);
        if (
          existingConv &&
          existingConv.verified &&
          existingConv.stage !== "plan_processing" &&
          existingConv.stage !== "takeoff_pending" &&
          existingConv.stage !== "estimating" &&
          existingConv.stage !== "invoice_review"
        ) {
          console.log(`[MMS] Verified customer (conv ${existingConv.id}, stage=${existingConv.stage}) — firing takeoff from MMS handler`);
          // Overwrite pendingImagesJson with ONLY the freshly downloaded MMS PDFs —
          // do NOT merge with stale prior-session entries. Any old PDFs, base64
          // images, or cross-session leftovers must not contaminate this takeoff.
          await storage.updateConversation(existingConv.id, {
            stage: "plan_processing",
            pendingImagesJson: JSON.stringify(mmsPdfUrls.map(u => `pdf::${u}`)),
          });

          const ack = "Got your plans! I've forwarded them to our team for a detailed takeoff. We'll have your preliminary estimate ready shortly. In the meantime, can you provide the project name and delivery address so we can prepare your quote?";
          await storage.addMessage({ conversationId: existingConv.id, direction: "outbound", body: ack });
          try { await sendSms(cleanPhone, ack); } catch (smsErr: any) {
            console.warn(`[MMS] Ack SMS failed: ${smsErr?.message}`);
          }

          // Record inbound message before we return so the conversation log reflects it
          const bodyWithMedia = cleanBody || `[📎 PDF attached]`;
          await storage.addMessage({
            conversationId: existingConv.id,
            direction: "inbound",
            body: bodyWithMedia,
          });

          // Pass ONLY the newly downloaded MMS PDF paths — NOT the full
          // pendingImagesJson, which can contain stale entries from prior sessions.
          const takeoffImages = mmsPdfUrls.map(u => `pdf::${u}`);
          const rawPlanUrlFromMms = (() => {
            const urls = extractUrls(cleanBody);
            return urls.length > 0 ? urls[0] : undefined;
          })();
          console.log(`[MMS] Calling handlePlanTakeoff(conv=${existingConv.id}, phone=${cleanPhone}, images=${takeoffImages.length})`);
          handlePlanTakeoff(existingConv.id, cleanPhone, takeoffImages, rawPlanUrlFromMms).catch(err => {
            console.error("[MMS] handlePlanTakeoff failed:", err);
          });
          return;
        } else {
          console.log(`[MMS] Not firing takeoff from MMS handler — conv=${existingConv?.id ?? "none"}, verified=${existingConv?.verified ?? "n/a"}, stage=${existingConv?.stage ?? "n/a"}`);
        }
      } catch (triggerErr: any) {
        console.error(`[MMS] Error in immediate-takeoff trigger: ${triggerErr?.message}`);
      }
    }

    // If a link was sent but we couldn't open it, notify the customer right away
    if (linkResolveFailed && mediaUrls.length === 0 && pdfUrls.length === 0) {
      const failMsg = `Sorry, we weren't able to open that link. Please try sending the file again, or call us at 469-631-7730 and we'll take care of it.`;
      try { await sendSms(cleanPhone, failMsg); } catch {}
      return;
    }

    // Require at least a body or an image
    if (!cleanBody && mediaUrls.length === 0) return;

    try {
      // Get or create conversation
      let conv = await storage.getOrCreateConversation(cleanPhone);

      // ── FRAUD GATE: existing customers only ──────────────────────────────────
      let justAutoVerified = false;
      if (conv.stage === "greeting" && !conv.verified && isQboConfigured()) {
        const found = await lookupCustomerByPhone(cleanPhone);
        if (found) {
          conv = await storage.updateConversation(conv.id, {
            verified: true,
            qboCustomerId: found.id,
            customerName: found.name,
            customerEmail: found.email,
            customerCompany: found.company || null,
            stage: "ordering",
          });
          justAutoVerified = true;
          console.log(`[Verify] Auto-verified ${cleanPhone} as QBO customer: ${found.name}`);
        } else {
          console.log(`[Verify] ${cleanPhone} not found in QBO customer list`);
        }
      }

      // ── Persist any resolved images/PDFs so they survive across messages ─────
      // (e.g. customer sends link before verified; we store it and use it later)
      // PDFs stored with "pdf::" prefix to distinguish from image URLs
      const newMedia = [
        ...mediaUrls,
        ...pdfUrls.map(u => `pdf::${u}`),
      ];
      if (newMedia.length > 0) {
        const _parsedExisting = conv.pendingImagesJson ? JSON.parse(conv.pendingImagesJson) : [];
        const existing: string[] = Array.isArray(_parsedExisting) ? _parsedExisting : [];
        // Deduplicate — never store the same URL twice (prevents duplicate takeoff on retry)
        const merged = [...existing];
        for (const u of newMedia) { if (!merged.includes(u)) merged.push(u); }
        conv = await storage.updateConversation(conv.id, { pendingImagesJson: JSON.stringify(merged) });
        console.log(`[Images] Stored ${mediaUrls.length} image(s) + ${pdfUrls.length} PDF(s) — total pending: ${merged.length}`);
      }

      // Save inbound message — always preserve the original text/link.
      // Only replace body with image note when it's a pure MMS with no text.
      const bodyWithMedia = (numMedia > 0 && !cleanBody)
        ? `[📷 ${numMedia} image(s) attached]`
        : cleanBody; // original URL/text always shown as-is
      await storage.addMessage({
        conversationId: conv.id,
        direction: "inbound",
        body: bodyWithMedia,
      });

      // ── Capture project name/address from customer reply after plan upload ───
      // If the customer has plans in flight (stage = plan_processing / estimating
      // / takeoff_pending, OR has pending PDFs) and hasn't given us project info
      // yet, parse this text for "project name" + a delivery/job-site address.
      if (
        cleanBody &&
        pdfUrls.length === 0 && // this message isn't itself a plan upload
        (!conv.projectName || !conv.projectAddress)
      ) {
        const pendingHasPdf = (() => {
          try {
            const p = conv.pendingImagesJson ? JSON.parse(conv.pendingImagesJson) : [];
            return Array.isArray(p) && p.some((u: any) => typeof u === "string" && u.startsWith("pdf::"));
          } catch { return false; }
        })();
        const planInFlight =
          conv.stage === "plan_processing" ||
          conv.stage === "takeoff_pending" ||
          conv.stage === "estimating" ||
          pendingHasPdf;
        if (planInFlight) {
          const parsed = parseProjectInfo(cleanBody);
          const updates: { projectName?: string; projectAddress?: string } = {};
          if (parsed.name && !conv.projectName) updates.projectName = parsed.name;
          if (parsed.address && !conv.projectAddress) updates.projectAddress = parsed.address;
          if (Object.keys(updates).length > 0) {
            conv = await storage.updateConversation(conv.id, updates);
            console.log(`[Project] Captured project info for conv ${conv.id}:`, updates);
          }
        }
      }

      // ── Early trigger: verified customer sent a PDF → run takeoff NOW ────────
      // This must fire before any other handler so the PDF message isn't also
      // processed as an order/AI intent. Covers stages "ordering", "invoiced",
      // and any non-plan-processing stage.
      if (
        pdfUrls.length > 0 &&
        conv.verified &&
        conv.stage !== "plan_processing" &&
        conv.stage !== "takeoff_pending" &&
        conv.stage !== "estimating" &&
        conv.stage !== "invoice_review"
      ) {
        conv = await storage.updateConversation(conv.id, { stage: "plan_processing" });
        const takeoffImages = [
          ...mediaUrls,
          ...pdfUrls.map(u => `pdf::${u}`),
        ];
        const rawPlanUrlEarly = (() => {
          const urls = extractUrls(cleanBody);
          return urls.length > 0 ? urls[0] : undefined;
        })();
        handlePlanTakeoff(conv.id, cleanPhone, takeoffImages, rawPlanUrlEarly).catch(err => {
          console.error("[Takeoff] Early trigger failed:", err);
        });
        return;
      }

      // ── Shortcut: END / DONE — customer explicitly closes the conversation ───
      const CLOSE_KEYWORDS = /^(done|bye|goodbye|end|close|that'?s? all|no more|nothing else|we'?re? good|all good|thank you that'?s? all|thanks that'?s? all|that will (be )?all)[\.!]?$/i;
      if (CLOSE_KEYWORDS.test(cleanBody.trim())) {
        await storage.updateConversation(conv.id, { status: "completed" });
        const closeMsg = `You're all set! Text us anytime if you need anything else. — Rebar Concrete Products (469) 631-7730`;
        await storage.addMessage({ conversationId: conv.id, direction: "outbound", body: closeMsg });
        try { await sendSms(cleanPhone, closeMsg); } catch {}
        return;
      }

      // ── Shortcut: LOOKS GOOD — customer confirms invoice, send payment link ───
      if (conv.stage === "invoice_review") {
        const LOOKS_GOOD = /^(looks? good|confirmed?|correct|yes|yep|yeah|ok|okay|approve[d]?|good|perfect|that'?s? (correct|right|good))[\.!]?$/i;
        const CORRECTION = /^(correction|wrong|no|change|fix|incorrect|mistake|error)s?[\.!]?$/i;

        // Safety check: only fire the LOOKS_GOOD shortcut if the last bot message
        // was actually an invoice review (contains "Invoice #" and "LOOKS GOOD").
        // If the bot's last message was a new price quote (contains "Shall I"),
        // the customer's "yes" is confirming a NEW order, not the old invoice.
        const allMsgs = await storage.getMessages(conv.id);
        const lastBotMsg = [...allMsgs].reverse().find(m => m.direction === "outbound");
        const lastBotWasInvoiceReview = lastBotMsg &&
          /Invoice #\d+ is ready/i.test(lastBotMsg.body) &&
          /LOOKS GOOD/i.test(lastBotMsg.body);

        // If the last bot message was NOT an invoice review, the customer has
        // moved on to a new order — reset stage so the flow works correctly.
        if (!lastBotWasInvoiceReview) {
          console.log(`[Stage] invoice_review but last bot msg is not a review — resetting to "ordering" (conv ${conv.id})`);
          conv = await storage.updateConversation(conv.id, { stage: "ordering", pendingImagesJson: null });
        }

        if (LOOKS_GOOD.test(cleanBody.trim()) && lastBotWasInvoiceReview) {
          // Retrieve stored payment data
          let paymentLink: string | null = null;
          let invoiceNumber = "";
          let total = 0;
          let taxAmount = 0;
          let subtotal = 0;
          let deliveryFee = 0;
          try {
            const stored = JSON.parse(conv.pendingImagesJson || "{}");
            paymentLink = stored.__paymentLink || null;
            invoiceNumber = stored.__invoiceNumber || "";
            total = stored.__total || 0;
            taxAmount = stored.__taxAmount || 0;
            subtotal = stored.__subtotal || 0;
            deliveryFee = stored.__deliveryFee || 0;
          } catch {}

          await storage.updateConversation(conv.id, { stage: "invoiced", status: "active", pendingImagesJson: null });

          const dLine = deliveryFee > 0 ? `\nDelivery: $${deliveryFee.toFixed(2)}` : "";
          const payMsg = paymentLink
            ? `Great! Here is your payment link for Invoice #${invoiceNumber}:\n\n${paymentLink}\n\nSubtotal: $${subtotal.toFixed(2)}\nTax (8.25%): $${taxAmount.toFixed(2)}${dLine}\nTotal: $${total.toFixed(2)}\n\nWe'll also email the invoice to ${conv.customerEmail}. Thank you!`
            : `Thank you for confirming! Invoice #${invoiceNumber} has been emailed to ${conv.customerEmail}. Total: $${total.toFixed(2)}. Call us at 469-631-7730 with any questions.`;

          await storage.addMessage({ conversationId: conv.id, direction: "outbound", body: payMsg });
          let smsSent = false;
          try { await sendSms(cleanPhone, payMsg); smsSent = true; } catch (e: any) {
            console.error(`[SMS] Failed to send payment link: ${e?.message}`);
          }
          if (!smsSent && paymentLink && conv.customerEmail) {
            try {
              await sendPaymentLinkEmail({
                to: conv.customerEmail,
                customerName: conv.customerName || "Valued Customer",
                invoiceNumber,
                total,
                paymentLink,
              });
            } catch {}
          }
          return;
        }

        if (CORRECTION.test(cleanBody.trim())) {
          const corrMsg = `No problem! Please describe what needs to be corrected and we'll update the invoice for you. You can also call us at 469-631-7730.`;
          await storage.updateConversation(conv.id, { stage: "ordering" });
          await storage.addMessage({ conversationId: conv.id, direction: "outbound", body: corrMsg });
          try { await sendSms(cleanPhone, corrMsg); } catch {}
          return;
        }
      }

      // ── Reset stage when a new message arrives after an invoice was finalized ──
      // Once stage reaches "invoiced" the customer is free to start a second order.
      // Any follow-up text (that isn't a trailing LOOKS GOOD retry) should be treated
      // as a fresh ordering flow so downstream guards don't short-circuit on stage.
      if (conv.stage === "invoiced") {
        const LOOKS_GOOD_RETRY = /^(looks? good|approve[d]?)[\.!]?$/i;
        if (!LOOKS_GOOD_RETRY.test(cleanBody.trim())) {
          console.log(`[Stage] Resetting stage "invoiced" → "ordering" for conv ${conv.id} (new message after finalized invoice)`);
          conv = await storage.updateConversation(conv.id, { stage: "ordering" });
        }
      }

      // ── Shortcut: APPROVE keyword from customer ────────────────────────────
      // ── awaiting_sms_verify: customer must reply with their 6-digit code ────────
      if (conv.stage === "awaiting_sms_verify") {
        const pending = pendingVerifications.get(cleanPhone);
        if (!pending) {
          await storage.updateConversation(conv.id, { stage: "ordering" });
          const expiredMsg = "Your verification code has expired. Please confirm your order again and we\'ll send a new code.";
          await storage.addMessage({ conversationId: conv.id, direction: "outbound", body: expiredMsg });
          await sendSms(cleanPhone, expiredMsg);
          return;
        }
        if (Date.now() > pending.expiresAt) {
          pendingVerifications.delete(cleanPhone);
          await storage.updateConversation(conv.id, { stage: "ordering" });
          const expiredMsg = "Your verification code expired. Please confirm your order again to receive a new one.";
          await storage.addMessage({ conversationId: conv.id, direction: "outbound", body: expiredMsg });
          await sendSms(cleanPhone, expiredMsg);
          return;
        }
        const inputCode = normalizeVerifyInput(cleanBody);
        pending.attempts++;
        if (pending.attempts > 5) {
          pendingVerifications.delete(cleanPhone);
          await storage.updateConversation(conv.id, { stage: "ordering" });
          const blockedMsg = "Too many incorrect attempts. Please confirm your order again to receive a new verification code.";
          await storage.addMessage({ conversationId: conv.id, direction: "outbound", body: blockedMsg });
          await sendSms(cleanPhone, blockedMsg);
          return;
        }
        if (inputCode !== pending.code) {
          const remaining = 6 - pending.attempts;
          const wrongMsg = `That code doesn't match. Please try again. ${remaining} attempt(s) remaining.`;
          await storage.addMessage({ conversationId: conv.id, direction: "outbound", body: wrongMsg });
          await sendSms(cleanPhone, wrongMsg);
          return;
        }
        // Code matched — proceed to invoice creation
        pendingVerifications.delete(cleanPhone);
        console.log(`[Verify] SMS code verified for ${cleanPhone} — creating invoice`);
        await handleOrderConfirmation(conv.id, cleanPhone);
        return;
      }

      if (conv.stage === "estimating" && cleanBody.trim().toUpperCase() === "APPROVE") {
        const est = await storage.getEstimateByConversation(conv.id);
        if (est && est.status !== "approved") {
          await handleEstimateApproval(est.id, conv.id, cleanPhone, est.qboEstimateNumber || "Estimate");
        } else {
          const noEst = "No pending estimate found. Call us at 469-631-7730 if you have questions.";
          await storage.addMessage({ conversationId: conv.id, direction: "outbound", body: noEst });
          await sendSms(cleanPhone, noEst);
        }
        return;
      }

      // ── Raw plan URL from customer message (for sonar-pro) ──────────────────
      // Extract the first http(s) URL from the message body before any transformation.
      const rawPlanUrl: string | undefined = (() => {
        const urls = extractUrls(cleanBody);
        return urls.length > 0 ? urls[0] : undefined;
      })();

      // ── Helper: get all stored images + PDFs for this conversation ─────────
      const allImages = (): string[] => {
        const _parsed = conv.pendingImagesJson ? JSON.parse(conv.pendingImagesJson) : [];
        const stored: string[] = Array.isArray(_parsed) ? _parsed : [];
        // merge live mediaUrls + pdfUrls (deduplicated)
        const combined = [...stored];
        for (const u of mediaUrls) { if (!combined.includes(u)) combined.push(u); }
        for (const u of pdfUrls) {
          const prefixed = `pdf::${u}`;
          if (!combined.includes(prefixed)) combined.push(prefixed);
        }
        return combined;
      };

      // ── Auto-detect plan set: 3+ images OR any PDF sent → run takeoff ───────
      // Only run if not already mid-estimate — prevents re-running on follow-up messages.
      // Note: stage "invoiced" is allowed so a customer can run a second takeoff after
      // their first invoice is complete.
      if ((mediaUrls.length >= 3 || pdfUrls.length >= 1) && conv.verified && conv.stage !== "takeoff_pending" && conv.stage !== "estimating" && conv.stage !== "invoice_review") {
        await handlePlanTakeoff(conv.id, cleanPhone, allImages(), rawPlanUrl);
        return;
      }

      // ── If stage is takeoff_pending, run takeoff with all stored images/PDFs ─
      if (conv.stage === "takeoff_pending") {
        const imgs = allImages();
        if (imgs.length >= 1) {
          await handlePlanTakeoff(conv.id, cleanPhone, imgs, rawPlanUrl);
          return;
        }
        // No files yet — remind customer to send a link
        if (!cleanBody.includes("http") && mediaUrls.length === 0 && pdfUrls.length === 0) {
          const remind = `Still waiting on your plan set. You can text your plan set directly as a PDF attachment, or share a Google Drive or Dropbox direct-download link, and I'll start the takeoff right away.`;
          await storage.addMessage({ conversationId: conv.id, direction: "outbound", body: remind });
          await sendSms(cleanPhone, remind);
          return;
        }
      }

      // Handle the message with AI (pass image URLs if any)
      const intent = await processMessage(conv, cleanBody, mediaUrls, undefined, justAutoVerified);

      // ── Handle delivery fee calculation ───────────────────────────────────────
      if (intent.type === "calc_delivery") {
        // Guard against partial addresses (e.g. "3127 Briar Ridge" with no city/state)
        // which would otherwise geocode to unrelated locations hundreds of miles away.
        if (!isAddressComplete(intent.address)) {
          const askFull = `Can you confirm the full delivery address including city and state? For example: 3127 Briar Ridge, McKinney, TX 75071`;
          await storage.addMessage({ conversationId: conv.id, direction: "outbound", body: askFull });
          await sendSms(cleanPhone, askFull);
          return;
        }
        const distResult = await calcDeliveryFee(intent.address);
        let followUp: string;
        if (distResult) {
          // Encode miles + fee into the address field for retrieval at invoice time
          await storage.updateConversation(conv.id, {
            deliveryAddress: `${intent.address}||MILES:${distResult.miles}||FEE:${distResult.fee}`,
          });

          // Determine if this order will qualify for free delivery
          // (We don't know the subtotal yet, so give them the applicable conditional rule)
          const FREE_DELIVERY_TIERS = [
            { miles: 65, minOrder: 8000 },
            { miles: 55, minOrder: 4000 },
            { miles: 40, minOrder: 2000 },
            { miles: 30, minOrder: 1000 },
          ];
          const applicableTier = FREE_DELIVERY_TIERS.find(t => distResult.miles <= t.miles);
          if (applicableTier) {
            followUp = `${intent.text ? intent.text + " " : ""}Your job site is ${distResult.miles} mi away. Delivery is FREE on orders of $${applicableTier.minOrder.toLocaleString()} or more. Otherwise the fee is $${distResult.fee.toFixed(2)}. Ready to build your order?`;
          } else {
            followUp = `${intent.text ? intent.text + " " : ""}Your job site is ${distResult.miles} mi away. Delivery fee will be $${distResult.fee.toFixed(2)}. Ready to build your order?`;
          }
        } else {
          await storage.updateConversation(conv.id, { deliveryAddress: intent.address });
          followUp = `${intent.text ? intent.text + " " : ""}Got it. Our team will confirm the exact delivery fee on your invoice. Ready to build your order?`;
        }

        await storage.addMessage({ conversationId: conv.id, direction: "outbound", body: followUp });
        await sendSms(cleanPhone, followUp);
        return;
      }

      // Save and send the AI reply (skip for lookup_orders — handler sends its own reply)
      const replyText = await fixPriceText(intent.text);
      if (replyText && intent.type !== "lookup_orders") {
        await storage.addMessage({
          conversationId: conv.id,
          direction: "outbound",
          body: replyText,
        });
        await sendSms(cleanPhone, replyText);
      } else if (!replyText && intent.type !== "lookup_orders" && intent.type !== "plan_takeoff") {
        // AI returned no text — send a fallback so the customer isn't left hanging
        const fallback = "Sorry, I wasn't able to process that. Please call us at 469-631-7730 and we'll help you out.";
        await storage.addMessage({ conversationId: conv.id, direction: "outbound", body: fallback });
        await sendSms(cleanPhone, fallback);
      }

      // Handle special intents
      if (intent.type === "info_complete") {
        // Extract and save customer info
        const msgs = await storage.getMessages(conv.id);
        const info = await extractCustomerInfo(msgs);
        await storage.updateConversation(conv.id, {
          customerName: info.name || conv.customerName,
          customerEmail: info.email || conv.customerEmail,
          customerCompany: info.company || conv.customerCompany,
          deliveryAddress: info.deliveryAddress || conv.deliveryAddress,
          stage: "ordering",
        });

        // ── Auto-trigger takeoff if a PDF was attached before verification ──
        // Customer sent a PDF with their first message — it's been sitting in
        // pendingImagesJson while we asked for name/phone. Now that they're
        // verified, kick off the takeoff without making them re-send the file.
        try {
          const refreshed = await storage.getConversationByPhone(cleanPhone);
          const pending: string[] = refreshed?.pendingImagesJson
            ? JSON.parse(refreshed.pendingImagesJson)
            : [];
          if (Array.isArray(pending) && pending.some(u => typeof u === "string" && u.startsWith("pdf::"))) {
            await handlePlanTakeoff(conv.id, cleanPhone, pending, rawPlanUrl);
            return;
          }
        } catch (e: any) {
          console.warn(`[Takeoff] Failed to check pending PDFs after verify: ${e?.message}`);
        }
      }

      if (intent.type === "confirm_order") {
        // ── Verification step before invoice creation ────────────────────────────
        // Send a 6-digit code to the customer's phone. Invoice creation is
        // deferred until they reply with the correct code.
        const smsVerifyCode = generateCode();
        pendingVerifications.set(cleanPhone, {
          code: smsVerifyCode,
          expiresAt: Date.now() + 5 * 60 * 1000,
          attempts: 0,
        });
        await storage.updateConversation(conv.id, { stage: "awaiting_sms_verify" });
        const verifyMsg = `To confirm your order, please reply with this 6-digit verification code:\n\n${smsVerifyCode}\n\nThis code expires in 5 minutes.`;
        await storage.addMessage({ conversationId: conv.id, direction: "outbound", body: verifyMsg });
        await sendSms(cleanPhone, verifyMsg);
        console.log(`[Verify] SMS verification code sent to ${cleanPhone} before invoice creation`);
        // ───────────────────────────────────────────────────────────────────────
      }

      if (intent.type === "confirm_estimate") {
        // ── Create QBO Estimate for quote/pricing requests ───────────────────────
        // No verification gate needed for estimates — they are read-only and
        // contain no payment info. Create immediately and email the link.
        console.log(`[Estimate] Creating QBO estimate for SMS customer ${cleanPhone}`);
        try {
          const msgs = await storage.getMessages(conv.id);
          const products = (await storage.getAllProducts()).filter(p => p.unitPrice !== null).slice(0, 80);
          const orderData = await extractOrderFromConversation(msgs, products);

          if (!orderData.lineItems || orderData.lineItems.length === 0) {
            const noItemsMsg = "I couldn't find any items for the estimate. Could you tell me what products you'd like quoted?";
            await storage.addMessage({ conversationId: conv.id, direction: "outbound", body: noItemsMsg });
            await sendSms(cleanPhone, noItemsMsg);
            return;
          }

          // Filter to valid items and override prices from DB
          const FAB_QBO_ID_EST = "1010000301";
          const validEstItems = orderData.lineItems.filter((item: any) => {
            const id = String(item.qboItemId || "");
            return id && id !== "null" && id !== "" && /^\d+$/.test(id);
          });
          validEstItems.forEach((item: any) => {
            if (item.qboItemId !== FAB_QBO_ID_EST) {
              const dbProduct = products.find((p: any) => String(p.qboItemId) === String(item.qboItemId));
              if (dbProduct && dbProduct.unitPrice !== null) {
                const exactPrice = parseFloat(String(dbProduct.unitPrice));
                if (!isNaN(exactPrice)) item.unitPrice = exactPrice;
              }
            }
            item.amount = item.qty * item.unitPrice;
          });

          if (validEstItems.length === 0) {
            const noValidMsg = "I wasn't able to match all items to our product catalog. Please call us at 469-631-7730 to get an estimate.";
            await storage.addMessage({ conversationId: conv.id, direction: "outbound", body: noValidMsg });
            await sendSms(cleanPhone, noValidMsg);
            return;
          }

          const subtotal = validEstItems.reduce((s: number, i: any) => s + i.amount, 0);
          const tax = +(subtotal * TAX_RATE).toFixed(2);
          const total = subtotal + tax;

          let qboCustomerId = conv.qboCustomerId;
          if (!qboCustomerId && conv.customerEmail && conv.customerName) {
            qboCustomerId = await findOrCreateCustomer({
              name: conv.customerName,
              email: conv.customerEmail,
              phone: conv.phone,
              company: conv.customerCompany || undefined,
            }).catch(() => null);
            if (qboCustomerId) await storage.updateConversation(conv.id, { qboCustomerId });
          }

          if (qboCustomerId && isQboConfigured()) {
            const estimateLineItems = validEstItems.map(addBundleDesc);
            const est = await createEstimate({
              customerId: qboCustomerId,
              customerEmail: conv.customerEmail || undefined,
              lineItems: estimateLineItems,
              customerMemo: `PRELIMINARY ESTIMATE — For bidding purposes only. Quoted via SMS. Call 469-631-7730 to place your order.`,
            });

            // Email the estimate link to the customer
            if (conv.customerEmail) {
              sendEstimateEmail({
                to: conv.customerEmail,
                customerName: conv.customerName || "Customer",
                estimateNumber: est.estimateNumber,
                total,
                estimateLink: est.estimateLink,
              }).catch(e => console.error("[Estimate] Email error:", e));
            }

            const estimateMsg = conv.customerEmail
              ? `Your estimate #${est.estimateNumber} has been created ($${total.toFixed(2)} incl. tax). We've emailed it to ${conv.customerEmail}. Ready to order? Call 469-631-7730.`
              : `Your estimate #${est.estimateNumber} has been created ($${total.toFixed(2)} incl. tax). Ready to order? Call 469-631-7730.`;
            await storage.addMessage({ conversationId: conv.id, direction: "outbound", body: estimateMsg });
            await sendSms(cleanPhone, estimateMsg);
            console.log(`[Estimate] Estimate #${est.estimateNumber} created for ${cleanPhone} — $${total.toFixed(2)}`);
          } else {
            const noQboMsg = "Your estimate has been noted. We'll email it to you shortly. Call 469-631-7730 with any questions.";
            await storage.addMessage({ conversationId: conv.id, direction: "outbound", body: noQboMsg });
            await sendSms(cleanPhone, noQboMsg);
          }
        } catch (estErr: any) {
          console.error("[Estimate] SMS estimate creation error:", estErr);
          const errMsg = "We hit a snag creating your estimate. Please call us at 469-631-7730 and we'll get one over to you right away.";
          await storage.addMessage({ conversationId: conv.id, direction: "outbound", body: errMsg });
          await sendSms(cleanPhone, errMsg);
        }
        // ─────────────────────────────────────────────────────────────────────
      }

      if (intent.type === "plan_takeoff") {
        // Customer triggered plan-to-estimate flow
        // Check for any stored images (from this or prior messages)
        const imgs = allImages();
        if (imgs.length >= 1) {
          await handlePlanTakeoff(conv.id, cleanPhone, imgs, rawPlanUrl);
        } else {
          // No images yet — AI already asked them to send pages; update stage
          await storage.updateConversation(conv.id, { stage: "takeoff_pending" });
        }
      }

      if (intent.type === "lookup_orders") {
        // Fetch real invoice history from QBO and re-run AI with that context
        let orderHistoryText = "";
        const qboId = conv.qboCustomerId;
        if (qboId && isQboConfigured()) {
          try {
            const invoices = await getCustomerInvoices(qboId, 5);
            if (invoices.length === 0) {
              orderHistoryText = "No invoices found for this customer in QuickBooks.";
            } else {
              orderHistoryText = invoices.map(inv => {
                const linesSummary = inv.lines
                  .map(l => `  - ${l.name}: qty ${l.qty} @ $${l.unitPrice.toFixed(2)} = $${l.amount.toFixed(2)}`)
                  .join("\n");
                return `Invoice #${inv.invoiceNumber} | Date: ${inv.date} | Due: ${inv.dueDate} | Total: $${inv.total.toFixed(2)} | Balance: $${inv.balance.toFixed(2)} | Status: ${inv.status}\n${linesSummary}`;
              }).join("\n\n");
            }
          } catch (err) {
            console.error("[Orders] Failed to fetch customer invoices:", err);
            orderHistoryText = "Unable to retrieve invoice history at this time.";
          }
        } else {
          orderHistoryText = "Customer QBO ID not available — cannot retrieve order history.";
        }
        // Re-run AI with the order history injected into system prompt
        const historyIntent = await processMessage(conv, cleanBody, mediaUrls, orderHistoryText);
        const historyReply = historyIntent.text || "I wasn't able to find your order history. Please call us at 469-631-7730 for help.";
        await storage.addMessage({ conversationId: conv.id, direction: "outbound", body: historyReply });
        await sendSms(cleanPhone, historyReply);
      }

      // If stage is takeoff_pending and images arrived, run the takeoff
      if (conv.stage === "takeoff_pending" && (mediaUrls.length >= 1 || pdfUrls.length >= 1) && intent.type === "message") {
        await handlePlanTakeoff(conv.id, cleanPhone, allImages(), rawPlanUrl);
      }

    } catch (err) {
      console.error("[SMS] Error processing message:", err);
      try {
        const techErr = "Sorry, we ran into a technical issue. Please try again in a moment or call us at 469-631-7730 and we'll help you out.";
        try {
          const errConv = await storage.getConversationByPhone(cleanPhone);
          if (errConv) await storage.addMessage({ conversationId: errConv.id, direction: "outbound", body: techErr });
        } catch {}
        await sendSms(cleanPhone, techErr);
      } catch (_) {}
    }
  });

  // ── Order Confirmation Handler ──────────────────────────────────────────────
  async function handleOrderConfirmation(conversationId: number, phone: string) {
    const conv = await storage.getConversation(conversationId);
    if (!conv) return;
    // Guard: prevent concurrent duplicate invoice creation only if another
    // handleOrderConfirmation is already mid-flight for this conversation.
    // Stage alone ("invoice_review" or "invoiced") must NOT short-circuit — the
    // customer is free to place additional orders in the same conversation.
    if (orderConfirmationInProgress.has(conversationId)) {
      console.log(`[Order] Skipping — order confirmation already in progress for conv ${conversationId}`);
      return;
    }
    // Reset stage to "ordering" if a previous invoice was finalized or is under
    // review — this lets the new order proceed as a fresh flow.
    if (conv.stage === "invoiced" || conv.stage === "invoice_review") {
      console.log(`[Order] Resetting stage "${conv.stage}" → "ordering" for new order (conv ${conversationId})`);
      await storage.updateConversation(conversationId, { stage: "ordering", pendingImagesJson: null });
    }
    orderConfirmationInProgress.add(conversationId);
    try {
      const msgs = await storage.getMessages(conversationId);
      const products = (await storage.getAllProducts()).filter(p => p.unitPrice !== null).slice(0, 80);
      // Extract order details
      const orderData = await extractOrderFromConversation(msgs, products);
      console.log("[Order] Extracted line items:", JSON.stringify(orderData.lineItems));

      if (!orderData.lineItems || orderData.lineItems.length === 0) {
        await sendSms(phone, "I couldn't find any items in your order. Could you tell me what you'd like to order?");
        return;
      }

      // Strip any line items with non-numeric qboItemId (e.g. "CUSTOM") OR
      // the Delivery Fee product (ID 1010000081) — delivery is added separately
      // by createInvoice via the deliveryFee parameter to avoid double-charging.
      const DELIVERY_FEE_QBO_ID = "1010000081";
      const FAB_QBO_ID = "1010000301";
      const validItems = orderData.lineItems.filter((item: any) => {
        const id = String(item.qboItemId || "");
        if (!id || id === "null" || id === "" || !/^\d+$/.test(id)) {
          console.log(`[Order] Stripped non-numeric item: ${item.name} (id=${id})`);
          return false;
        }
        if (id === DELIVERY_FEE_QBO_ID) {
          console.log("[Order] Stripped AI-added delivery fee line item (handled separately)");
          return false;
        }
        return true;
      });
      // Override unitPrice with exact DB price (AI rounds prices — never trust AI math for money)
      // Fabrication-1 is always $0.75 exactly — never override that
      const FAB_QBO_ID_ROUTE = "1010000301";
      validItems.forEach((item: any) => {
        if (item.qboItemId !== FAB_QBO_ID_ROUTE) {
          const dbProduct = products.find((p: any) => String(p.qboItemId) === String(item.qboItemId));
          if (dbProduct && dbProduct.unitPrice !== null && dbProduct.unitPrice !== undefined) {
            const exactPrice = parseFloat(String(dbProduct.unitPrice));
            if (!isNaN(exactPrice)) {
              item.unitPrice = exactPrice;
            }
          }
        }
        // Recompute amount from qty × exact unitPrice
        item.amount = item.qty * item.unitPrice;
      });
      console.log("[Order] Line items after exact-price override:", JSON.stringify(validItems.map((i: any) => ({ name: i.name, qty: i.qty, unitPrice: i.unitPrice, amount: i.amount }))));
      console.log("[Order] Valid line items after filter:", JSON.stringify(validItems));
      if (validItems.length === 0) {
        console.error("[Order] No line items with valid qboItemId — falling back to pending order");
        await sendSms(phone, `Order confirmed! Total: $${orderData.lineItems.reduce((s: number, i: any) => s + i.amount, 0).toFixed(2)}. Our team will process your invoice and send it to you. Thank you!`);
        return;
      }
      orderData.lineItems = validItems;

      // ── Concrete truck delivery / short load fee logic ───────────────────
      // Concrete QBO item IDs
      const CONCRETE_QBO_IDS = new Set(["34", "32", "33", "40", "35", "36", "31"]);
      const SHORT_LOAD_QBO_ID = "37";   // Short Load Fee - Concrete ($350)
      const CONCRETE_DELIVERY_QBO_ID = "38"; // Concrete Truck Delivery ($70)

      const concreteItems = validItems.filter((i: any) => CONCRETE_QBO_IDS.has(String(i.qboItemId)));
      const totalConcreteYards = concreteItems.reduce((sum: number, i: any) => sum + i.qty, 0);
      const hasShortLoadFee = validItems.some((i: any) => String(i.qboItemId) === SHORT_LOAD_QBO_ID);

      if (concreteItems.length > 0) {
        if (totalConcreteYards <= 5 && !hasShortLoadFee) {
          // ≤5 yards: flat $350 Short Load Fee (1 qty)
          validItems.push({
            qboItemId: SHORT_LOAD_QBO_ID,
            name: "Short Load Fee - Concrete",
            qty: 1,
            unitPrice: 350,
            amount: 350,
          });
          console.log(`[Order] Added Short Load Fee (${totalConcreteYards} yards ≤ 5)`);
        } else if (!hasShortLoadFee) {
          // 6+ yards: 1 Concrete Truck Delivery fee per 10 yards (rounded up)
          const hasConcreteDeliveryFee = validItems.some((i: any) => String(i.qboItemId) === CONCRETE_DELIVERY_QBO_ID);
          if (!hasConcreteDeliveryFee) {
            const truckQty = Math.ceil(totalConcreteYards / 10);
            validItems.push({
              qboItemId: CONCRETE_DELIVERY_QBO_ID,
              name: "Concrete Truck Delivery",
              qty: truckQty,
              unitPrice: 70,
              amount: truckQty * 70,
            });
            console.log(`[Order] Added ${truckQty}x Concrete Truck Delivery fee (${totalConcreteYards} yards → ${truckQty} trucks)`);
          }
        }
      }
      // ─────────────────────────────────────────────────────────────────────

      // Parse delivery fee from encoded address field (set during CALC_DELIVERY)
      let deliveryFee = 0;
      let deliveryMiles: number | undefined;
      let cleanDeliveryAddress = conv.deliveryAddress || orderData.deliveryAddress || "";

      if (cleanDeliveryAddress.includes("||MILES:")) {
        const [addr, milesPart, feePart] = cleanDeliveryAddress.split("||");
        cleanDeliveryAddress = addr.trim();
        deliveryMiles = parseFloat(milesPart.replace("MILES:", ""));
        deliveryFee = parseFloat(feePart.replace("FEE:", ""));
      } else if (orderData.deliveryType === "delivery" && cleanDeliveryAddress) {
        // Fallback: try to calculate now if not pre-calculated
        const dist = await calcDeliveryFee(cleanDeliveryAddress).catch(() => null);
        if (dist) { deliveryFee = dist.fee; deliveryMiles = dist.miles; }
      }

      // Calculate totals — tiered free delivery rules
      const subtotal = orderData.lineItems.reduce((sum, item) => sum + item.amount, 0);

      // Tiered free delivery: (miles threshold, min order)
      const FREE_DELIVERY_TIERS = [
        { miles: 65, minOrder: 8000 },
        { miles: 55, minOrder: 4000 },
        { miles: 40, minOrder: 2000 },
        { miles: 30, minOrder: 1000 },
      ];

      const qualifiesFreeDelivery =
        orderData.deliveryType === "delivery" &&
        deliveryMiles !== undefined &&
        FREE_DELIVERY_TIERS.some(tier => deliveryMiles! <= tier.miles && subtotal >= tier.minOrder);

      if (qualifiesFreeDelivery) {
        deliveryFee = 0; // waive the fee
        console.log(`[Order] Free delivery applied: ${deliveryMiles} mi, subtotal $${subtotal}`);
      }

      const taxAmount = +(subtotal * TAX_RATE).toFixed(2);
      const total = subtotal + taxAmount + deliveryFee;

      // Create QBO customer if needed
      let qboCustomerId = conv.qboCustomerId;
      if (!qboCustomerId && conv.customerEmail && conv.customerName) {
        qboCustomerId = await findOrCreateCustomer({
          name: conv.customerName,
          email: conv.customerEmail,
          phone: conv.phone,
          company: conv.customerCompany || undefined,
        });
        // Only persist qboCustomerId here — stage transitions to "invoice_review"
        // below after the invoice is actually created, and to "invoiced" only after
        // the customer replies LOOKS GOOD.
        await storage.updateConversation(conversationId, { qboCustomerId });
      }

      // Create invoice in QBO
      let invoiceId = "";
      let invoiceNumber = "";
      let paymentLink: string | null = null;

      // Bundle counts per bar size (20' bars)
      // addBundleDesc defined at module level — see top of registerRoutes

      if (qboCustomerId && isQboConfigured()) {
        const SMS_CONCRETE_QBO_IDS = new Set(["34", "32", "33", "40", "35", "36", "31"]);
        const SMS_CONCRETE_FEE_IDS = new Set(["37", "38"]); // Short Load Fee, Concrete Truck Delivery
        const allQboItems = (orderData.lineItems as LineItem[]).filter(i => i.qboItemId !== "CUSTOM").map(addBundleDesc);
        const customInvoiceItems = (orderData.lineItems as LineItem[]).filter(i => i.qboItemId === "CUSTOM");
        const customInvoiceNote = customInvoiceItems.length > 0
          ? ` | Unmatched items (TBD): ${customInvoiceItems.map(i => i.name).join(", ")}`
          : "";

        // Split: concrete items (+ concrete fees) vs. non-concrete materials
        const smsConcreteLineItems = allQboItems.filter(i =>
          SMS_CONCRETE_QBO_IDS.has(String(i.qboItemId)) || SMS_CONCRETE_FEE_IDS.has(String(i.qboItemId))
        );
        const smsMaterialsLineItems = allQboItems.filter(i =>
          !SMS_CONCRETE_QBO_IDS.has(String(i.qboItemId)) && !SMS_CONCRETE_FEE_IDS.has(String(i.qboItemId))
        );
        const hasMixed = smsConcreteLineItems.length > 0 && smsMaterialsLineItems.length > 0;

        if (hasMixed) {
          // Parse split delivery notes from the notes string
          const rawNotes = orderData.notes || "";
          const concreteDeliveryMatch = rawNotes.match(/CONCRETE delivery:\s*([^.]+\.?)/i);
          const materialsDeliveryMatch = rawNotes.match(/MATERIALS delivery:\s*([^.]+\.?)/i);
          const concreteDeliveryNote = concreteDeliveryMatch ? concreteDeliveryMatch[1].trim() : null;
          const materialsDeliveryNote = materialsDeliveryMatch ? materialsDeliveryMatch[1].trim() : null;
          // Fall back to full notes if no split pattern found
          const concreteMemo = [
            `CONCRETE — Delivered`,
            cleanDeliveryAddress ? `Ship to: ${cleanDeliveryAddress}` : null,
            concreteDeliveryNote ? `Delivery: ${concreteDeliveryNote}` : (rawNotes || null),
          ].filter(Boolean).join(" | ");
          const materialsMemo = [
            `MATERIALS — ${orderData.deliveryType === "delivery" ? "Delivery" : "Pickup"}`,
            materialsDeliveryNote ? `Delivery: ${materialsDeliveryNote}` : (rawNotes || null),
            customInvoiceNote || null,
          ].filter(Boolean).join(" | ");

          // ── INVOICE 1: Concrete (always delivered) ──────────────────────────
          const concreteInvoice = await createInvoice({
            customerId: qboCustomerId,
            customerEmail: conv.customerEmail!,
            lineItems: smsConcreteLineItems,
            deliveryAddress: cleanDeliveryAddress || undefined,
            deliveryNotes: concreteDeliveryNote || rawNotes || undefined,
            customerMemo: concreteMemo || undefined,
          });
          // ── INVOICE 2: Materials / Rebar (pickup or delivery) ─────────────
          const materialsInvoice = await createInvoice({
            customerId: qboCustomerId,
            customerEmail: conv.customerEmail!,
            lineItems: smsMaterialsLineItems,
            deliveryFee: deliveryFee > 0 ? deliveryFee : undefined,
            deliveryMiles,
            deliveryAddress: orderData.deliveryType === "delivery" ? (cleanDeliveryAddress || undefined) : undefined,
            deliveryNotes: materialsDeliveryNote || rawNotes || undefined,
            customerMemo: materialsMemo || undefined,
          });
          // Use Invoice 2 (materials) as the primary for the payment link SMS;
          // both invoice numbers stored for review message
          invoiceId = materialsInvoice.invoiceId;
          invoiceNumber = `${concreteInvoice.invoiceNumber} & ${materialsInvoice.invoiceNumber}`;
          paymentLink = materialsInvoice.paymentLink;
          console.log(`[Order] Split invoices — Concrete #${concreteInvoice.invoiceNumber}, Materials #${materialsInvoice.invoiceNumber}`);
          // Notify staff — bot-created order
          sendStaffOrderNotification({
            invoiceNumber,
            customerName: conv.customerName || "Customer",
            total,
            deliveryAddress: cleanDeliveryAddress || "",
            memo: rawNotes,
            lines: allQboItems.map(i => ({ name: i.name, qty: i.qty, amount: i.amount })),
            source: "sms",
          }).catch(e => console.error("[StaffNotify] Error:", e));
        } else {
          // Single-type order — create one invoice as before
          const invoice = await createInvoice({
            customerId: qboCustomerId,
            customerEmail: conv.customerEmail!,
            lineItems: allQboItems,
            deliveryFee: deliveryFee > 0 ? deliveryFee : undefined,
            deliveryMiles,
            deliveryAddress: cleanDeliveryAddress || undefined,
            deliveryNotes: orderData.notes || undefined,
            customerMemo: [
              cleanDeliveryAddress ? `Ship to: ${cleanDeliveryAddress}` : null,
              orderData.notes || null,
              customInvoiceNote || null,
            ].filter(Boolean).join(" | ") || undefined,
          });
          invoiceId = invoice.invoiceId;
          invoiceNumber = invoice.invoiceNumber;
          paymentLink = invoice.paymentLink;
          // Notify staff — bot-created order
          sendStaffOrderNotification({
            invoiceNumber,
            customerName: conv.customerName || "Customer",
            total,
            deliveryAddress: cleanDeliveryAddress || "",
            memo: orderData.notes || "",
            lines: allQboItems.map(i => ({ name: i.name, qty: i.qty, amount: i.amount })),
            source: "sms",
          }).catch(e => console.error("[StaffNotify] Error:", e));
        }
      }

      // Save order to DB
      await storage.createOrder({
        conversationId,
        qboInvoiceId: invoiceId || null,
        qboInvoiceNumber: invoiceNumber || null,
        paymentLink,
        lineItemsJson: JSON.stringify(orderData.lineItems),
        subtotal,
        deliveryFee,
        deliveryMiles: deliveryMiles ?? null,
        total,  // includes tax + delivery
        deliveryType: orderData.deliveryType,
        status: invoiceId ? "invoiced" : "pending",
      });

      // ── Send invoice review — ask customer to confirm before payment link ──────
      const freeDeliveryNote = qualifiesFreeDelivery ? " Free delivery applied!" : "";
      const deliveryLine = deliveryFee > 0 ? `\nDelivery: $${deliveryFee.toFixed(2)}` : "";

      // Build line-by-line item list
      const itemLines = orderData.lineItems
        .map((i: any) => {
          if (i.qboItemId === "1010000301" || i.name === "Fabrication-1") {
            const desc = i.description || `${Math.round(i.qty)} lbs custom fabrication`;
            return `  • ${desc}: $${i.amount.toFixed(2)}`;
          }
          return `  • ${i.qty > 1 ? i.qty + "x " : ""}${i.name}: $${i.amount.toFixed(2)}`;
        })
        .join("\n");

      const fabItem = orderData.lineItems.find((i: any) => i.qboItemId === "1010000301" || i.name === "Fabrication-1");
      const fabLbs = fabItem ? Math.round(fabItem.qty) : 0;
      const leadTimeLine = fabLbs > 0
        ? (fabLbs >= 3000
          ? `\nFabrication lead time: 7–13 business days (call 469-631-7730 for updates).`
          : `\nFabrication lead time: 4–6 business days (call 469-631-7730 — may be ready sooner).`)
        : null;

      const displayInvoiceNumber = invoiceNumber || invoiceId || "pending";
      const reviewMsg = [
        `Invoice #${displayInvoiceNumber} is ready.${freeDeliveryNote}`,
        ``,
        itemLines,
        ``,
        `Subtotal: $${subtotal.toFixed(2)}`,
        `Tax (8.25%): $${taxAmount.toFixed(2)}`,
        deliveryFee > 0 ? `Delivery: $${deliveryFee.toFixed(2)}` : null,
        `Total: $${total.toFixed(2)}`,
        leadTimeLine,
        ``,
        `Reply LOOKS GOOD to receive your payment link, or CORRECTION if anything needs to be changed.`,
      ].filter(l => l !== null).join("\n");

      // Store payment link in conversation for retrieval after customer confirms
      await storage.updateConversation(conversationId, {
        stage: "invoice_review",
        pendingImagesJson: JSON.stringify({ __paymentLink: paymentLink, __invoiceNumber: invoiceNumber, __total: total, __taxAmount: taxAmount, __subtotal: subtotal, __deliveryFee: deliveryFee }),
      });

      await storage.addMessage({ conversationId, direction: "outbound", body: reviewMsg });
      try { await sendSms(phone, reviewMsg); } catch (e: any) {
        console.error(`[SMS] Failed to send invoice review: ${e?.message}`);
      }

    } catch (err) {
      console.error("[Order] Failed to create invoice:", err);
      const orderErrMsg = `We had trouble creating your invoice. Please try again in a moment or call us at 469-631-7730 and we'll get it sorted out.`;
      await storage.addMessage({ conversationId, direction: "outbound", body: orderErrMsg });
      try { await sendSms(phone, orderErrMsg); } catch {}
    } finally {
      orderConfirmationInProgress.delete(conversationId);
    }
  }

  // ── Plan Takeoff Handler ──────────────────────────────────────────────────
  // planSourceUrl: raw Dropbox/Drive URL from the customer's message, forwarded to sonar-pro when available.
  async function handlePlanTakeoff(conversationId: number, phone: string, imageUrls: string[], planSourceUrl?: string) {
    console.log(`[Takeoff] handlePlanTakeoff ENTER — conv=${conversationId}, phone=${phone}, imageUrls.length=${imageUrls.length}, planSourceUrl=${planSourceUrl ?? "none"}`);
    const conv = await storage.getConversation(conversationId);
    if (!conv) {
      console.error(`[Takeoff] handlePlanTakeoff — conversation ${conversationId} not found, aborting`);
      return;
    }

    const ackMsg = `Got it! I'm analyzing your plan set now. This takes about 30–60 seconds — I'll send your estimate as soon as it's ready.`;
    await storage.addMessage({ conversationId, direction: "outbound", body: ackMsg });
    try { await sendSms(phone, ackMsg); } catch (smsErr: any) {
      console.warn(`[Takeoff] Ack SMS failed: ${smsErr?.message}`);
    }

    const products = await storage.getAllProducts();
    console.log(`[Takeoff] Loaded ${products.length} products — calling performTakeoff()`);

    try {
      const takeoffResult = await performTakeoff(imageUrls, products, planSourceUrl);
      console.log(`[Takeoff] performTakeoff returned — lineItems=${takeoffResult?.lineItems?.length ?? 0}, fabItems=${takeoffResult?.fabItems?.length ?? 0}, project="${takeoffResult?.projectName ?? ""}"`);

      if (!takeoffResult.lineItems || takeoffResult.lineItems.length === 0) {
        const hasPdf = imageUrls.some(u => u.startsWith("pdf::"));
        const errMsg = hasPdf
          ? `I wasn't able to read enough detail from that PDF to build an estimate. For best results, share a Dropbox or Google Drive link instead of attaching the file directly — larger plan sets come through much clearer that way. Or call us at 469-631-7730 and we'll quote it manually.`
          : `I couldn't extract materials from those images. Make sure all pages are clear and in focus. Try resending or call us at 469-631-7730 for a manual quote.`;
        console.error(`[Takeoff] Zero line items — imageUrls: ${JSON.stringify(imageUrls.map(u => u.substring(0,80)))}`);
        await storage.addMessage({ conversationId, direction: "outbound", body: errMsg });
        await sendSms(phone, errMsg);
        // Clear pendingImagesJson so stale PDFs don't bleed into the next takeoff
        await storage.updateConversation(conversationId, { stage: "ordering", pendingImagesJson: null });
        return;
      }

      const subtotal = takeoffResult.lineItems.reduce((s, i) => s + i.amount, 0);

      // Plan takeoffs always go to the special "BOT" QBO customer — not the
      // conversation's own customer record. This keeps bid/preliminary estimates
      // separate from the customer's actual order history.
      let qboCustomerId: string | null = null;
      if (isQboConfigured()) {
        try {
          qboCustomerId = await getOrCreateBotCustomer();
        } catch (err) {
          console.error("[Takeoff] Failed to get BOT customer — falling back to conversation customer:", err);
          qboCustomerId = conv.qboCustomerId || null;
        }
      }

      let estimateId = "";
      let estimateNumber = "";
      let estimateLink: string | null = null;

      if (qboCustomerId && isQboConfigured()) {
        // Separate matched QBO items from unmatched (CUSTOM) items
        const qboLineItems = takeoffResult.lineItems.filter(i => i.qboItemId !== "CUSTOM");
        // Recompute amount to avoid floating-point mismatches QBO rejects
        qboLineItems.forEach(item => {
          item.amount = Math.round(item.qty * item.unitPrice * 100) / 100;
        });
        const customItems = takeoffResult.lineItems.filter(i => i.qboItemId === "CUSTOM");
        if (customItems.length > 0) {
          console.log(`[Takeoff] ${customItems.length} unmatched item(s) moved to memo:`, customItems.map(i => i.name).join(", "));
        }
        // Append unmatched items as a note in the memo so nothing is lost
        const customNote = customItems.length > 0
          ? `\n\nUnmatched items (price TBD):\n${customItems.map(i => `- ${i.name}${i.description ? ": " + i.description : ""}`).join("\n")}`
          : "";
        const projectName = conv.projectName || takeoffResult.projectName;
        const projectAddress = conv.projectAddress || "";
        const shipMemo = projectAddress
          ? `${projectName}\n${projectAddress}`
          : projectName;
        const est = await createEstimate({
          customerId: qboCustomerId,
          customerEmail: conv.customerEmail || OFFICE_EMAIL,
          lineItems: qboLineItems as LineItem[],
          customerMemo: `Preliminary estimate — bidding purposes only. +/-5% contingency included.\nProject: ${projectName}${projectAddress ? `\nAddress: ${projectAddress}` : ""}${customNote}`,
          deliveryAddress: shipMemo,
        });
        estimateId = est.estimateId;
        estimateNumber = est.estimateNumber;
        estimateLink = est.estimateLink;
      }

      const savedEstimate = await storage.createEstimate({
        conversationId,
        qboEstimateId: estimateId || null,
        qboEstimateNumber: estimateNumber || null,
        qboEstimateLink: estimateLink || null,
        lineItemsJson: JSON.stringify(takeoffResult.lineItems),
        fabricationJson: JSON.stringify(takeoffResult.fabItems),
        planPagesJson: JSON.stringify(imageUrls),
        takeoffNotesJson: JSON.stringify(takeoffResult.takeoffNotes),
        subtotal,
        status: estimateId ? "sent" : "pending",
      });

      // Build + email branded bid/estimate PDF to customer AND office.
      // Fire-and-forget: SMS estimate still goes out even if PDF/email fails.
      try {
        const bidProjectName = conv.projectName || takeoffResult.projectName;
        const bidEstimateNumber = estimateNumber || String(savedEstimate.id);
        const bidPdfPath = await generateBidPdf({
          lineItems: takeoffResult.lineItems.map(i => ({
            name: i.name,
            description: i.description,
            qty: i.qty,
            unitPrice: i.unitPrice,
            amount: i.amount,
          })),
          fabItems: takeoffResult.fabItems,
          projectInfo: {
            projectName: bidProjectName,
            projectAddress: conv.projectAddress || "",
            customerName: conv.customerName || conv.phone,
            estimateNumber: bidEstimateNumber,
          },
          taxRate: TAX_RATE,
        });
        await emailBidPdf({
          pdfPath: bidPdfPath,
          projectName: bidProjectName,
          customerName: conv.customerName || conv.phone,
          customerEmail: conv.customerEmail || undefined,
          estimateNumber: bidEstimateNumber,
        });
      } catch (pdfErr) {
        console.error("[Takeoff] Branded bid PDF generation/email failed:", pdfErr);
      }

      const items = takeoffResult.lineItems;
      // Split into priced items (amount > 0) and unpriced (qty/length TBD)
      const pricedItems = items.filter(i => i.amount > 0);
      const unpricedItems = items.filter(i => i.amount === 0);

      // If nothing could be priced, tell customer and ask them to call
      if (pricedItems.length === 0) {
        const noPrice = `We were able to identify the materials in your plan set but couldn't determine quantities automatically. Please call us at 469-631-7730 and we'll put together a manual quote for you.\n\nItems identified:\n${unpricedItems.map(i => `- ${i.name}`).join("\n")}`;
        await storage.addMessage({ conversationId, direction: "outbound", body: noPrice });
        await sendSms(phone, noPrice);
        await storage.updateConversation(conversationId, { stage: "ordering", pendingImagesJson: null });
        return;
      }
      const top5 = pricedItems.map(i => `${i.qty > 1 ? i.qty + "x " : ""}${i.name}: $${i.amount.toFixed(2)}`).join("\n");
      const moreCount = "";
      const fabCount = takeoffResult.fabItems.filter(f => !f.bendDescription.includes("stock length")).length;
      const fabNote = fabCount > 0 ? `\n${fabCount} custom fab item(s) @ $0.75/lb included.` : "";
      const tbdNote = unpricedItems.length > 0
        ? `\n\nCould not determine qty from plans (call 469-631-7730 to add):\n${unpricedItems.map(i => `- ${i.name}`).join("\n")}`
        : "";

      const estimateTax = subtotal * TAX_RATE;
      const estimateTotal = subtotal + estimateTax;
      const taxLine = `\nTax (8.25%): $${estimateTax.toFixed(2)}\nEstimated Total: $${estimateTotal.toFixed(2)}`;

      const cutSheetNote = conv.customerEmail
        ? `\n\nYour branded preliminary estimate PDF has been emailed to ${conv.customerEmail} and our office.`
        : `\n\nYour preliminary estimate PDF has been sent to our office at ${OFFICE_EMAIL}.`;

      let replyText: string;
      if (estimateLink) {
        replyText = `Takeoff complete for ${takeoffResult.projectName}!\n\n${top5}${moreCount}${fabNote}${tbdNote}\n\nSubtotal: $${subtotal.toFixed(2)}${taxLine}${cutSheetNote}\n\nView & approve your estimate:\n${estimateLink}\n\nOnce you approve, we\'ll process your fabrication order.`;
      } else if (estimateNumber) {
        replyText = `Takeoff complete for ${takeoffResult.projectName}!\n\n${top5}${moreCount}${fabNote}${tbdNote}\n\nSubtotal: $${subtotal.toFixed(2)}${taxLine}${cutSheetNote}\n\nEstimate #${estimateNumber} emailed to ${conv.customerEmail}. Reply APPROVE to confirm.`;
      } else {
        replyText = `Takeoff complete for ${takeoffResult.projectName}!\n\n${top5}${moreCount}${fabNote}${tbdNote}\n\nSubtotal: $${subtotal.toFixed(2)}${taxLine}${cutSheetNote}\n\nReply APPROVE to confirm this estimate, or call 469-631-7730 with questions.`;
      }

      await storage.addMessage({ conversationId, direction: "outbound", body: replyText });
      await sendSms(phone, replyText);
      // Clear pendingImagesJson — these PDFs have been processed and must not
      // be re-used on any future message in this conversation.
      await storage.updateConversation(conversationId, { stage: "estimating", pendingImagesJson: null });

      if (estimateId) {
        pollEstimateApproval(savedEstimate.id, estimateId, conversationId, phone, takeoffResult.projectName);
      }

    } catch (err) {
      console.error("[Takeoff] Error:", err);
      const errMsg = `Something went wrong while reading your plan set. Please call us at 469-631-7730 and we\'ll get you a quote right away — usually within the hour.`;
      await storage.addMessage({ conversationId, direction: "outbound", body: errMsg });
      await sendSms(phone, errMsg);
      // Also clear pendingImagesJson on error so a retry doesn't pick up stale data
      await storage.updateConversation(conversationId, { stage: "ordering", pendingImagesJson: null });
    }
  }

  // ── QBO Estimate Approval Polling ───────────────────────────────────────────
  function pollEstimateApproval(
    estimateDbId: number,
    qboEstimateId: string,
    conversationId: number,
    phone: string,
    projectName: string,
    attempt = 0
  ) {
    const MAX_ATTEMPTS = 288;
    const INTERVAL_MS = 5 * 60 * 1000;
    const check = async () => {
      try {
        const status = await getEstimateStatus(qboEstimateId);
        if (status === "Accepted") {
          await handleEstimateApproval(estimateDbId, conversationId, phone, projectName);
          return;
        }
        if (status === "Rejected") {
          await storage.updateEstimate(estimateDbId, { status: "declined" });
          return;
        }
      } catch (err) {
        console.warn(`[Estimate] Poll check failed (attempt ${attempt}):`, err);
      }
      if (attempt < MAX_ATTEMPTS) {
        setTimeout(() => pollEstimateApproval(estimateDbId, qboEstimateId, conversationId, phone, projectName, attempt + 1), INTERVAL_MS);
      }
    };
    setTimeout(check, attempt === 0 ? 30_000 : INTERVAL_MS);
  }

  // ── Handle approved estimate: convert to invoice, email cut sheet, send payment link ──
  async function handleEstimateApproval(
    estimateDbId: number,
    conversationId: number,
    phone: string,
    projectName: string
  ) {
    const conv = await storage.getConversation(conversationId);
    const est = await storage.getEstimate(estimateDbId);
    if (!conv || !est || est.status === "approved") return;

    try {
      const fabItems = JSON.parse(est.fabricationJson || "[]");
      const estimateNumber = est.qboEstimateNumber || String(estimateDbId);
      const customerName = conv.customerName || conv.phone;
      const customerEmail = conv.customerEmail || "";

      // 1. Convert QBO estimate → invoice
      let invoiceNumber = estimateNumber;
      let paymentLink: string | null = null;
      if (est.qboEstimateId && isQboConfigured()) {
        try {
          const converted = await convertEstimateToInvoice(est.qboEstimateId, customerEmail);
          invoiceNumber = converted.invoiceNumber;
          paymentLink = converted.paymentLink;
          console.log(`[Estimate] Converted estimate ${estimateNumber} → invoice ${invoiceNumber}`);
        } catch (convErr) {
          console.error("[Estimate] Failed to convert estimate to invoice:", convErr);
          // Notify customer so they aren't left waiting
          const convErrMsg = `Your estimate has been approved. We had a technical issue creating the invoice automatically — our team will follow up shortly, or call us at 469-631-7730.`;
          await storage.addMessage({ conversationId, direction: "outbound", body: convErrMsg });
          await sendSms(phone, convErrMsg);
        }
      }

      // 2. Generate + email fabrication cut sheet (if there are fab items)
      if (fabItems.length > 0) {
        try {
          const pdfPath = generateCutSheetPdf({
            projectName,
            customerName,
            estimateNumber: invoiceNumber,
            fabItems,
          });
          await emailCutSheet({
            pdfPath,
            projectName,
            customerName,
            estimateNumber: invoiceNumber,
            ownerEmail: OWNER_EMAIL,
          });
        } catch (pdfErr) {
          console.error("[Estimate] Cut sheet generation/email failed:", pdfErr);
        }
      }

      await storage.updateEstimate(estimateDbId, {
        status: "approved",
        cutSheetEmailedAt: new Date(),
      });

      // 3. Send customer confirmation + payment link
      let confirmMsg: string;
      if (paymentLink) {
        confirmMsg = `Estimate approved! Invoice #${invoiceNumber} has been created.\n\nPay here:\n${paymentLink}\n\nWe'll also email the invoice to ${customerEmail}. Thank you for choosing Rebar Concrete Products!`;
      } else {
        confirmMsg = `Estimate approved! Invoice #${invoiceNumber} has been created and emailed to ${customerEmail}. Our team will begin processing your order. Thank you!`;
      }

      await storage.addMessage({ conversationId, direction: "outbound", body: confirmMsg });
      const smsSent = await sendSms(phone, confirmMsg);

      // Email fallback if SMS fails
      if (!smsSent && paymentLink && customerEmail) {
        try {
          await sendPaymentLinkEmail({
            to: customerEmail,
            customerName,
            invoiceNumber,
            paymentLink,
            total: 0,
          });
        } catch (_) {}
      }

      await storage.updateConversation(conversationId, { stage: "invoiced", status: "active" });
    } catch (err) {
      console.error("[Estimate] Approval handler failed:", err);
      try {
        const errMsg = "There was an issue processing your approval. Please call us at 469-631-7730 and we'll take care of you.";
        await storage.addMessage({ conversationId, direction: "outbound", body: errMsg });
        await sendSms(phone, errMsg);
      } catch (_) {}
    }
  }

  // ── Serve temp files (MMS PDFs downloaded from Twilio) ─────────────────────
  app.get("/api/tmp/:filename", async (req, res) => {
    const filename = path.basename(req.params.filename); // prevent path traversal
    const tmpPath = path.join(os.tmpdir(), filename);
    if (!fs.existsSync(tmpPath)) {
      return res.status(404).send("Not found");
    }
    const ext = path.extname(filename).toLowerCase();
    const mime = ext === ".pdf" ? "application/pdf" : "application/octet-stream";
    res.set("Content-Type", mime);
    res.sendFile(tmpPath);
  });

  // ── Admin API ───────────────────────────────────────────────────────────────
  // Get all conversations with messages
  app.get("/api/conversations", async (_req, res) => {
    const convs = await storage.getAllConversations();
    res.json(convs);
  });

  // Get single conversation
  app.get("/api/conversations/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    const conv = await storage.getConversation(id);
    if (!conv) return res.status(404).json({ error: "Not found" });
    const msgs = await storage.getMessages(id);
    const orders = await storage.getOrderByConversation(id);
    res.json({ ...conv, messages: msgs, order: orders });
  });

  // Send manual reply from dashboard
  app.post("/api/conversations/:id/reply", async (req, res) => {
    const id = parseInt(req.params.id);
    const conv = await storage.getConversation(id);
    if (!conv) return res.status(404).json({ error: "Not found" });

    const { message } = req.body;
    if (!message) return res.status(400).json({ error: "message required" });

    await sendSms(conv.phone, message);
    await storage.addMessage({ conversationId: id, direction: "outbound", body: message });
    res.json({ ok: true });
  });

  // Get all orders (enriched with customer name + phone from conversation)
  app.get("/api/orders", async (_req, res) => {
    const allOrders = await storage.getAllOrders();
    const enriched = await Promise.all(allOrders.map(async order => {
      const conv = await storage.getConversation(order.conversationId);
      return {
        ...order,
        customerName: conv?.customerName ?? null,
        customerPhone: conv?.phone ?? null,
      };
    }));
    res.json(enriched);
  });

  // Get all estimates
  app.get("/api/estimates", async (_req, res) => {
    const allEstimates = await storage.getAllEstimates();
    const enriched = await Promise.all(allEstimates.map(async est => {
      const conv = await storage.getConversation(est.conversationId);
      return {
        ...est,
        customerName: conv?.customerName ?? null,
        customerPhone: conv?.phone ?? null,
        customerEmail: conv?.customerEmail ?? null,
      };
    }));
    res.json(enriched);
  });

  // Manually approve an estimate (admin action)
  app.post("/api/estimates/:id/approve", async (req, res) => {
    const id = parseInt(req.params.id);
    const est = await storage.getEstimate(id);
    if (!est) return res.status(404).json({ error: "Not found" });
    const conv = await storage.getConversation(est.conversationId);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });
    try {
      await handleEstimateApproval(id, est.conversationId, conv.phone, est.qboEstimateNumber || "Estimate");
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get all products (from QBO cache)
  app.get("/api/products", async (_req, res) => {
    res.json(await storage.getAllProducts());
  });

  // Manually trigger a QBO product sync
  app.post("/api/products/sync", async (_req, res) => {
    try {
      await syncProducts();
      const prods = await storage.getAllProducts();
      res.json({ ok: true, count: prods.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Setup status (used by Setup page)
  app.get("/api/setup/status", async (_req, res) => {
    const products = await storage.getAllProducts();
    const realmId = process.env.QBO_REALM_ID;
    res.json({
      twilio: isTwilioConfigured(),
      openai: isAiConfigured(),
      qbo: isQboConfigured(),
      qboRealmId: realmId || null,
      productCount: products.length,
    });
  });

  // System status
  // ── Email diagnostic ────────────────────────────────────────────────────────────────
  app.get("/api/admin/email-test", async (req, res) => {
    const to = (req.query.to as string) || "Brian@RebarConcreteProducts.com";
    const gmailUser = process.env.GMAIL_USER;
    const gmailPass = process.env.GMAIL_APP_PASSWORD;
    if (!gmailUser || !gmailPass) {
      return res.json({ ok: false, error: "GMAIL_USER or GMAIL_APP_PASSWORD not set in Railway env vars", gmailUser: gmailUser || "(not set)", gmailPass: gmailPass ? "(set)" : "(not set)" });
    }
    try {
      const nodemailer = await import("nodemailer");
      const transporter = nodemailer.default.createTransport({ service: "gmail", auth: { user: gmailUser, pass: gmailPass } });
      await transporter.verify();
      const info = await transporter.sendMail({
        from: `"Rebar Concrete Products" <${gmailUser}>`,
        to,
        subject: "RCP SMS Bot — Email Test",
        text: "This is a test email from the RCP SMS Bot to confirm email delivery is working correctly.",
      });
      return res.json({ ok: true, messageId: info.messageId, response: info.response, gmailUser });
    } catch (err: any) {
      return res.json({ ok: false, error: err.message, code: err.code, gmailUser });
    }
  });

  app.get("/api/status", async (_req, res) => {
    res.json({
      twilio: isTwilioConfigured(),
      qbo: isQboConfigured(),
      openai: isAiConfigured(),
      products: (await storage.getAllProducts()).length,
      conversations: (await storage.getAllConversations()).length,
    });
  });

  // ── QBO OAuth Flow (one-time setup) ─────────────────────────────────────────
  app.get("/api/qbo/connect", async (_req, res) => {
    try {
      const clientId = process.env.QBO_CLIENT_ID;
      if (!clientId) return res.status(400).send("QBO_CLIENT_ID not set");
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: `${(process.env.APP_URL || "http://localhost:5000").replace(/^(?!https?:\/\/)/, "https://")}/api/qbo/callback`,
        response_type: "code",
        scope: "com.intuit.quickbooks.accounting",
        state: Math.random().toString(36).slice(2),
      });
      const authUrl = `https://appcenter.intuit.com/connect/oauth2?${params.toString()}`;
      // Use HTML meta-refresh redirect instead of 302 to avoid Railway proxy issues
      res.send(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=${authUrl}"><title>Connecting to QuickBooks...</title></head><body><p>Redirecting to QuickBooks... <a href="${authUrl}">Click here if not redirected</a></p></body></html>`);
    } catch (err) {
      console.error("[QBO connect error]", err);
      res.status(500).send("Failed to build QBO auth URL");
    }
  });

  // ── Inbound Voice Call (IVR Auto-Attendant) ────────────────────────────────
  // Point Twilio voice webhook to: POST /api/voice/inbound
  app.post("/api/voice/inbound", async (req, res) => {
    const appUrl = process.env.APP_URL || "http://localhost:5000";
    res.set("Content-Type", "text/xml");
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather action="${appUrl}/api/voice/menu" method="POST" numDigits="1" timeout="8">
    <Say voice="Polly.Joanna">
      Thank you for calling Rebar Concrete Products in McKinney, Texas.
      For the fastest service, you can text this number anytime to place orders, get quotes, or ask construction questions.
      To connect to our office, press 1.
      To leave a voicemail, press 2.
      To hear our hours and location, press 3.
    </Say>
  </Gather>
  <Say voice="Polly.Joanna">We didn't receive your selection. Please call back or text us anytime. Goodbye.</Say>
</Response>`);
  });

  // ── IVR Menu Handler ────────────────────────────────────────────────────────
  app.post("/api/voice/menu", async (req, res) => {
    const digit = req.body.Digits || "";
    const appUrl = process.env.APP_URL || "http://localhost:5000";
    const forwardNumber = process.env.FORWARD_PHONE || "4696317730";
    res.set("Content-Type", "text/xml");

    if (digit === "1") {
      // Forward to real office number
      res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Connecting you now. Please hold.</Say>
  <Dial timeout="20" action="${appUrl}/api/voice/no-answer" method="POST">
    <Number>${forwardNumber}</Number>
  </Dial>
</Response>`);
    } else if (digit === "2") {
      // Voicemail
      res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Please leave your name, phone number, and message after the tone. Press pound when finished.</Say>
  <Record action="${appUrl}/api/voice/voicemail" method="POST" maxLength="120" finishOnKey="#" transcribe="true" transcribeCallback="${appUrl}/api/voice/transcription" playBeep="true"/>
  <Say voice="Polly.Joanna">We did not receive a recording. Goodbye.</Say>
</Response>`);
    } else if (digit === "3") {
      // Hours and location
      res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">
    Rebar Concrete Products is located at 2112 North Custer Road, McKinney, Texas 75071.
    Our phone number is 469-631-7730.
    You can also text this number 24 hours a day, 7 days a week to place orders or get quotes.
    Thank you for calling. Goodbye.
  </Say>
</Response>`);
    } else {
      res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">That was not a valid selection.</Say>
  <Redirect method="POST">${appUrl}/api/voice/inbound</Redirect>
</Response>`);
    }
  });

  // ── No Answer Fallback (forward didn't connect) ─────────────────────────────
  app.post("/api/voice/no-answer", async (req, res) => {
    const appUrl = process.env.APP_URL || "http://localhost:5000";
    const dialStatus = req.body.DialCallStatus || "no-answer";
    res.set("Content-Type", "text/xml");
    if (dialStatus === "completed") {
      res.send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
    } else {
      // Didn't connect — offer voicemail
      res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">We're sorry, no one is available right now. Please leave a message after the tone and we'll call you back shortly.</Say>
  <Record action="${appUrl}/api/voice/voicemail" method="POST" maxLength="120" finishOnKey="#" transcribe="true" transcribeCallback="${appUrl}/api/voice/transcription" playBeep="true"/>
</Response>`);
    }
  });

  // ── Voicemail Recording Handler ─────────────────────────────────────────────
  app.post("/api/voice/voicemail", async (req, res) => {
    res.set("Content-Type", "text/xml");
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Thank you. Your message has been recorded. We'll get back to you shortly. Goodbye.</Say>
</Response>`);

    // Notify owner via SMS that a voicemail was left
    const recordingUrl = req.body.RecordingUrl;
    const callerPhone = req.body.From || "Unknown";
    const ownerPhone = process.env.OWNER_PHONE || process.env.TWILIO_PHONE_NUMBER;

    if (recordingUrl && ownerPhone) {
      try {
        const msg = `📞 New voicemail from ${callerPhone}\nListen: ${recordingUrl}.mp3\n(Transcription will follow if available)`;
        await sendSms(ownerPhone, msg);
      } catch (err) {
        console.error("[Voice] Failed to notify owner of voicemail:", err);
      }
    }
  });

  // ── Transcription Callback (Twilio calls this after transcribing) ───────────
  app.post("/api/voice/transcription", async (req, res) => {
    res.sendStatus(200);

    const transcript = req.body.TranscriptionText || "";
    const callerPhone = req.body.From || "Unknown";
    const recordingUrl = req.body.RecordingUrl || "";
    const ownerPhone = process.env.OWNER_PHONE || process.env.TWILIO_PHONE_NUMBER;

    if (transcript && ownerPhone) {
      try {
        const msg = `📞 Voicemail transcript from ${callerPhone}:\n"${transcript}"\n${recordingUrl ? "Recording: " + recordingUrl + ".mp3" : ""}`;
        await sendSms(ownerPhone, msg);
      } catch (err) {
        console.error("[Voice] Failed to send transcription:", err);
      }
    }
  });

  // ── QBO token exchange (called from static qbo-callback.html page) ──────────
  app.post("/api/qbo/exchange", async (req, res) => {
    try {
      const { code, realmId } = req.body as { code: string; realmId: string };
      if (!code || !realmId) return res.status(400).json({ ok: false, error: "Missing code or realmId" });

      const clientId = process.env.QBO_CLIENT_ID!;
      const clientSecret = process.env.QBO_CLIENT_SECRET!;
      const redirectUri = `${(process.env.APP_URL || "http://localhost:5000").replace(/^(?!https?:\/\/)/, "https://")}/qbo-callback.html`;

      const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
      const tokenRes = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
        method: "POST",
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
        }),
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        console.error(`[QBO EXCHANGE] Token endpoint returned ${tokenRes.status}: ${errText}`);
        return res.status(500).json({ ok: false, error: `Intuit token exchange failed: ${tokenRes.status} ${errText}` });
      }

      const tokens = await tokenRes.json();

      console.log("[QBO EXCHANGE SUCCESS]");
      console.log(`QBO_REALM_ID=${realmId}`);
      console.log(`QBO_REFRESH_TOKEN=${tokens.refresh_token}`);

      // Set immediately in process env so app works without restart
      process.env.QBO_REALM_ID = realmId;
      if (tokens.refresh_token) {
        process.env.QBO_REFRESH_TOKEN = tokens.refresh_token;
        setLiveRefreshToken(tokens.refresh_token);
        try {
          console.log('[QBO] Saving refresh token to DB:', tokens.refresh_token.substring(0, 20));
          await storage.setSetting("qbo_refresh_token", tokens.refresh_token);
          const verify = await storage.getSetting("qbo_refresh_token");
          console.log('[QBO] DB verify after save — stored token prefix:', verify ? verify.substring(0, 20) : '(null)');
        } catch (dbErr: any) {
          console.error('[QBO] FAILED to persist refresh token to DB:', dbErr?.message, dbErr?.stack);
        }
        updateRailwayEnvVar("QBO_REFRESH_TOKEN", tokens.refresh_token).catch(console.error);
        updateRailwayEnvVar("QBO_REALM_ID", realmId).catch(console.error);

        // Trigger a product sync now that we have a valid token
        syncProducts()
          .then(() => console.log('[QBO] Post-auth product sync complete'))
          .catch(err => console.error('[QBO] Post-auth product sync failed:', err?.message));
      } else {
        console.error('[QBO EXCHANGE] No refresh_token in Intuit response:', JSON.stringify(tokens));
      }

      return res.json({ ok: true, realmId, refreshToken: tokens.refresh_token });
    } catch (err: any) {
      console.error("[QBO EXCHANGE ERROR]", err?.stack || err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

    app.get("/api/qbo/callback", async (req, res) => {
    try {
      const { code, realmId } = req.query as Record<string, string>;
      if (!code || !realmId) return res.status(400).send("Missing code or realmId");

      const clientId = process.env.QBO_CLIENT_ID!;
      const clientSecret = process.env.QBO_CLIENT_SECRET!;
      const redirectUri = `${(process.env.APP_URL || "http://localhost:5000").replace(/^(?!https?:\/\/)/, "https://")}/api/qbo/callback`;

      const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
      const tokenRes = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
        method: "POST",
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
        }),
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        console.error(`[QBO CALLBACK] Token endpoint returned ${tokenRes.status}: ${errText}`);
        return res.status(500).send(`<h2>Token exchange failed</h2><pre>${tokenRes.status} ${errText}</pre>`);
      }

      const tokens = await tokenRes.json();

      // Always log to Railway console so we can retrieve values even if page fails
      console.log("[QBO CALLBACK SUCCESS]");
      console.log(`QBO_REALM_ID=${realmId}`);
      console.log(`QBO_REFRESH_TOKEN=${tokens.refresh_token}`);

      // Set in process.env immediately so app works without restart
      process.env.QBO_REALM_ID = realmId;
      if (tokens.refresh_token) {
        process.env.QBO_REFRESH_TOKEN = tokens.refresh_token;
        setLiveRefreshToken(tokens.refresh_token);
        try {
          console.log('[QBO] Saving refresh token to DB:', tokens.refresh_token.substring(0, 20));
          await storage.setSetting("qbo_refresh_token", tokens.refresh_token);
          const verify = await storage.getSetting("qbo_refresh_token");
          console.log('[QBO] DB verify after save — stored token prefix:', verify ? verify.substring(0, 20) : '(null)');
        } catch (dbErr: any) {
          console.error('[QBO] FAILED to persist refresh token to DB:', dbErr?.message, dbErr?.stack);
        }
        updateRailwayEnvVar("QBO_REFRESH_TOKEN", tokens.refresh_token).catch(console.error);
        updateRailwayEnvVar("QBO_REALM_ID", realmId).catch(console.error);

        // Trigger a product sync now that we have a valid token
        syncProducts()
          .then(() => console.log('[QBO] Post-auth product sync complete'))
          .catch(err => console.error('[QBO] Post-auth product sync failed:', err?.message));
      } else {
        console.error('[QBO CALLBACK] No refresh_token in Intuit response:', JSON.stringify(tokens));
      }

      res.send(`<!DOCTYPE html><html><head><title>QuickBooks Connected</title>
        <style>body{font-family:sans-serif;max-width:600px;margin:60px auto;padding:20px;}
        pre{background:#f4f4f4;padding:16px;border-radius:8px;word-break:break-all;white-space:pre-wrap;}
        .success{color:#2e7d32;font-size:24px;font-weight:bold;}
        </style></head><body>
        <p class="success">✅ QuickBooks Connected!</p>
        <p>RCP TextBot is now connected to <strong>Rebar Concrete Products</strong>.</p>
        <p>Copy these two values into your Railway environment variables:</p>
        <pre>QBO_REALM_ID=${realmId}
QBO_REFRESH_TOKEN=${tokens.refresh_token}</pre>
        <p>Then redeploy Railway and the bot will be fully live.</p>
        </body></html>`);
    } catch (err: any) {
      console.error("[QBO CALLBACK ERROR]", err);
      res.status(500).send(`<h2>Callback Error</h2><pre>${err.message}</pre><p>Check Railway logs for QBO_REALM_ID and QBO_REFRESH_TOKEN values.</p>`);
    }
  });

  // ── WEB CHAT ORDER ───────────────────────────────────────────────────────────────────
  // Creates a QBO customer + invoice from a structured web chat order
  // Called by the EstimatingBot website after customer confirms their order in chat
  // Body: { customerName, customerEmail, customerPhone, customerCompany, deliveryAddress, items: [{name, qboItemId, qty, unitPrice}] }
  app.post("/api/web-order", express.json(), async (req, res) => {
    try {
      const { customerName, customerEmail, customerPhone, customerCompany, deliveryAddress, deliveryNotes, deliveryMilesFallback, deliveryFeeFallback, items, verifiedPhone } = req.body;

      if (!customerName || !customerPhone || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: "customerName, customerPhone, and items are required" });
      }

      // ── Verification gate ─────────────────────────────────────────────────
      // /api/confirm-verification must have been called successfully for this phone
      // within the last 10 minutes before /api/web-order is accepted.
      const rawPhone = verifiedPhone || customerPhone || "";
      const phoneDigits = rawPhone.replace(/\D/g, "");
      const e164Phone = phoneDigits.length === 10 ? `+1${phoneDigits}` : `+${phoneDigits}`;
      const grantedAt = verifiedWebPhones.get(e164Phone);
      if (!grantedAt || Date.now() - grantedAt > 10 * 60 * 1000) {
        return res.status(403).json({
          error: "verification_required",
          message: "Order verification required. Please enter the code sent to your phone.",
        });
      }
      verifiedWebPhones.delete(e164Phone); // one-time use
      console.log(`[Verify] Web-order authorized for ${e164Phone}`);
      // ─────────────────────────────────────────────────────────────────────────────

      // Look up existing QBO customer by name + phone — no new customers created via web (fraud prevention)
      const customerId = await findExistingCustomer({
        name: customerName,
        phone: customerPhone || "",
        email: customerEmail || undefined,
      });

      if (!customerId) {
        return res.status(403).json({
          error: "customer_not_found",
          message: `We weren’t able to verify an account for “${customerName}” with that phone number. Please call us at 469-631-7730 or stop by 2112 N Custer Rd, McKinney, TX 75071 to get set up.`,
        });
      }

      // Build line items with exact DB prices
      const products = await getQboItems();
      const lineItems: LineItem[] = items.map((item: any) => {
        // Look up exact unit price from QBO if item has a qboItemId
        const product = item.qboItemId
          ? products.find((p: any) => p.id === item.qboItemId)
          : null;
        const exactPrice = product ? product.unitPrice : item.unitPrice;
        const qty = Number(item.qty);
        return {
          qboItemId: item.qboItemId || "",
          name: item.name,
          description: item.description || "",
          qty,
          unitPrice: exactPrice,
          amount: Math.round(qty * exactPrice * 100) / 100,
        };
      });

      // Enrich rebar line items with bundle breakdown for warehouse
      lineItems.forEach((item, i) => { lineItems[i] = addBundleDesc(item); });

      const subtotal = lineItems.reduce((s, l) => s + l.amount, 0);

      // Tiered free delivery — look up real distance via Google Maps
      const FREE_DELIVERY_TIERS_WEB = [
        { miles: 65, minOrder: 8000 },
        { miles: 55, minOrder: 4000 },
        { miles: 40, minOrder: 2000 },
        { miles: 30, minOrder: 1000 },
      ];
      let deliveryFee = 0;
      let deliveryMilesWeb: number | undefined;
      if (deliveryAddress && deliveryAddress.trim()) {
        console.log(`[WEB-ORDER] Calculating delivery fee for: "${deliveryAddress}"`);
        const dist = await calcDeliveryFee(deliveryAddress).catch(e => {
          console.error("[WEB-ORDER] calcDeliveryFee error:", e);
          return null;
        });
        if (dist) {
          deliveryMilesWeb = dist.miles;
          const qualifies = FREE_DELIVERY_TIERS_WEB.some(
            t => dist.miles <= t.miles && subtotal >= t.minOrder
          );
          deliveryFee = qualifies ? 0 : dist.fee;
          console.log(`[WEB-ORDER] Distance: ${dist.miles} mi, fee: $${deliveryFee}, subtotal: $${subtotal}, qualifiesFree: ${qualifies}`);
        } else if (deliveryFeeFallback && deliveryFeeFallback > 0) {
          // Maps lookup failed — use the fee the client already calculated via /api/calc-delivery
          deliveryMilesWeb = deliveryMilesFallback;
          deliveryFee = deliveryFeeFallback;
          console.log(`[WEB-ORDER] Using client fallback: ${deliveryMilesWeb} mi, fee: $${deliveryFee}`);
        } else {
          console.warn(`[WEB-ORDER] Could not calculate delivery distance — fee set to 0`);
        }
      }

      const preTax = subtotal + deliveryFee;
      const tax = Math.round(preTax * TAX_RATE * 100) / 100;
      const total = Math.round((preTax + tax) * 100) / 100;

      // ── Split concrete vs. materials into separate invoices when mixed ────
      const WEB_CONCRETE_QBO_IDS = new Set(["34", "32", "33", "40", "35", "36", "31"]);
      const WEB_CONCRETE_FEE_IDS = new Set(["37", "38"]); // Short Load Fee, Concrete Truck Delivery

      // Inject concrete fees into lineItems if not already present
      const webConcreteItems = lineItems.filter(i => WEB_CONCRETE_QBO_IDS.has(String(i.qboItemId)));
      const webTotalConcreteYards = webConcreteItems.reduce((sum, i) => sum + i.qty, 0);
      const webHasShortLoadFee = lineItems.some(i => String(i.qboItemId) === "37");
      const webHasConcreteDeliveryFee = lineItems.some(i => String(i.qboItemId) === "38");
      if (webConcreteItems.length > 0) {
        if (webTotalConcreteYards <= 5 && !webHasShortLoadFee) {
          // ≤5 yards: flat $350 Short Load Fee (1 qty)
          lineItems.push({ qboItemId: "37", name: "Short Load Fee - Concrete", description: "", qty: 1, unitPrice: 350, amount: 350 });
        } else if (!webHasShortLoadFee && !webHasConcreteDeliveryFee) {
          // 6+ yards: 1 Concrete Truck Delivery fee per 10 yards (rounded up)
          const webTruckQty = Math.ceil(webTotalConcreteYards / 10);
          lineItems.push({ qboItemId: "38", name: "Concrete Truck Delivery", description: "", qty: webTruckQty, unitPrice: 70, amount: webTruckQty * 70 });
        }
      }

      const webConcreteLineItems = lineItems.filter(i =>
        WEB_CONCRETE_QBO_IDS.has(String(i.qboItemId)) || WEB_CONCRETE_FEE_IDS.has(String(i.qboItemId))
      );
      const webMaterialsLineItems = lineItems.filter(i =>
        !WEB_CONCRETE_QBO_IDS.has(String(i.qboItemId)) && !WEB_CONCRETE_FEE_IDS.has(String(i.qboItemId))
      );
      const webHasMixed = webConcreteLineItems.length > 0 && webMaterialsLineItems.length > 0;

      let invoiceId: string;
      let invoiceNumber: string;
      let paymentLink: string | null;

      if (webHasMixed) {
        // Parse split delivery notes
        const rawWebNotes = deliveryNotes || "";
        const webConcreteDeliveryMatch = rawWebNotes.match(/CONCRETE delivery:\s*([^.]+\.?)/i);
        const webMaterialsDeliveryMatch = rawWebNotes.match(/MATERIALS delivery:\s*([^.]+\.?)/i);
        const webConcreteDeliveryNote = webConcreteDeliveryMatch ? webConcreteDeliveryMatch[1].trim() : null;
        const webMaterialsDeliveryNote = webMaterialsDeliveryMatch ? webMaterialsDeliveryMatch[1].trim() : null;

        // ── INVOICE 1: Concrete (always delivered) ──────────────────────────
        const concreteSubtotal = webConcreteLineItems.reduce((s, i) => s + i.amount, 0);
        const concreteInv = await createInvoice({
          customerId,
          customerEmail,
          lineItems: webConcreteLineItems,
          deliveryAddress: deliveryAddress || "",
          deliveryNotes: webConcreteDeliveryNote || rawWebNotes || undefined,
          customerMemo: [
            `CONCRETE — Delivered | Web order via ai.rebarconcreteproducts.com`,
            deliveryAddress ? `Ship to: ${deliveryAddress}` : null,
            webConcreteDeliveryNote ? `Delivery: ${webConcreteDeliveryNote}` : (rawWebNotes || null),
          ].filter(Boolean).join(" | "),
        });
        // ── INVOICE 2: Materials / Rebar (pickup or delivery) ─────────────
        const materialsSubtotal = webMaterialsLineItems.reduce((s, i) => s + i.amount, 0);
        const materialsInv = await createInvoice({
          customerId,
          customerEmail,
          lineItems: webMaterialsLineItems,
          deliveryFee: deliveryFee > 0 ? deliveryFee : undefined,
          deliveryMiles: deliveryMilesWeb,
          deliveryAddress: deliveryAddress || "",
          deliveryNotes: webMaterialsDeliveryNote || rawWebNotes || undefined,
          customerMemo: [
            `MATERIALS — Pickup | Web order via ai.rebarconcreteproducts.com`,
            webMaterialsDeliveryNote ? `Delivery: ${webMaterialsDeliveryNote}` : (rawWebNotes || null),
          ].filter(Boolean).join(" | "),
        });
        invoiceId = materialsInv.invoiceId;
        invoiceNumber = `${concreteInv.invoiceNumber} & ${materialsInv.invoiceNumber}`;
        paymentLink = materialsInv.paymentLink;
        console.log(`[WEB-ORDER] Split invoices — Concrete #${concreteInv.invoiceNumber} ($${concreteSubtotal.toFixed(2)}), Materials #${materialsInv.invoiceNumber} ($${materialsSubtotal.toFixed(2)}) for ${customerName}`);

        // Notify staff — web-chat-created order
        sendStaffOrderNotification({
          invoiceNumber,
          customerName,
          total,
          deliveryAddress: deliveryAddress || "",
          memo: deliveryNotes || "",
          lines: lineItems.map(i => ({ name: i.name, qty: i.qty, amount: i.amount })),
          source: "web",
        }).catch(e => console.error("[StaffNotify] Web-order error:", e));

        // Email both invoice numbers to customer
        if (customerEmail) {
          try {
            await sendPaymentLinkEmail({
              to: customerEmail,
              customerName,
              invoiceNumber,
              total,
              paymentLink: materialsInv.paymentLink,
            });
          } catch (emailErr) {
            console.warn("[WEB-ORDER] Email send failed:", emailErr);
          }
        }
      } else {
        // Single-type order — create one invoice as before
        const singleInvoice = await createInvoice({
          customerId,
          customerEmail,
          lineItems,
          deliveryFee: deliveryFee > 0 ? deliveryFee : undefined,
          deliveryMiles: deliveryMilesWeb,
          deliveryAddress: deliveryAddress || "",
          deliveryNotes: deliveryNotes || undefined,
          customerMemo: `Web order via ai.rebarconcreteproducts.com`,
        });
        invoiceId = singleInvoice.invoiceId;
        invoiceNumber = singleInvoice.invoiceNumber;
        paymentLink = singleInvoice.paymentLink;

        // Notify staff — web-chat-created order
        sendStaffOrderNotification({
          invoiceNumber,
          customerName,
          total,
          deliveryAddress: deliveryAddress || "",
          memo: deliveryNotes || "",
          lines: lineItems.map(i => ({ name: i.name, qty: i.qty, amount: i.amount })),
          source: "web",
        }).catch(e => console.error("[StaffNotify] Web-order error:", e));

        // Email invoice link to customer
        if (customerEmail) {
          try {
            await sendPaymentLinkEmail({
              to: customerEmail,
              customerName,
              invoiceNumber,
              total,
              paymentLink,
            });
          } catch (emailErr) {
            console.warn("[WEB-ORDER] Email send failed:", emailErr);
          }
        }
      }

      console.log(`[WEB-ORDER] Invoice(s) #${invoiceNumber} created for ${customerName} via web chat — $${total}`);

      res.json({
        success: true,
        invoiceNumber,
        invoiceId,
        paymentLink,
        subtotal,
        tax,
        total,
        deliveryFee,
      });
    } catch (err: any) {
      console.error("[WEB-ORDER ERROR]", err);
      res.status(500).json({ error: err.message || "Failed to create order" });
    }
  });

  // ── Web Estimate endpoint — creates a QBO Estimate from web chat quote requests ──
  // Called by chat-proxy when [CONFIRM_ESTIMATE] tag is detected in AI response.
  // Does NOT require SMS verification (estimates are read-only / non-payment).
  app.post("/api/web-estimate", express.json(), async (req, res) => {
    try {
      const { customerName, customerEmail, customerPhone, customerCompany, deliveryAddress, deliveryNotes, items } = req.body;

      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: "items are required" });
      }

      // Try to find an existing account — if not found, fall back to the generic EST customer
      let customerId: string | null = null;
      let usingEstCustomer = false;

      if (customerName && customerPhone) {
        customerId = await findExistingCustomer({
          name: customerName,
          phone: customerPhone,
          email: customerEmail || undefined,
        });
      }

      if (!customerId) {
        customerId = await getOrCreateEstCustomer();
        usingEstCustomer = true;
      }

      // Build line items with exact DB prices
      const products = await getQboItems();
      const lineItems: LineItem[] = items.map((item: any) => {
        const product = item.qboItemId
          ? products.find((p: any) => p.id === item.qboItemId)
          : null;
        const exactPrice = product ? product.unitPrice : item.unitPrice;
        const qty = Number(item.qty);
        return {
          qboItemId: item.qboItemId || "",
          name: item.name,
          description: item.description || "",
          qty,
          unitPrice: exactPrice,
          amount: Math.round(qty * exactPrice * 100) / 100,
        };
      });

      // Enrich rebar line items with bundle breakdown
      lineItems.forEach((item, i) => { lineItems[i] = addBundleDesc(item); });

      const subtotal = lineItems.reduce((s, l) => s + l.amount, 0);
      const tax = Math.round(subtotal * TAX_RATE * 100) / 100;
      const total = Math.round((subtotal + tax) * 100) / 100;

      const est = await createEstimate({
        customerId,
        customerEmail: customerEmail || undefined,
        lineItems,
        // For EST (non-account) customers, put name + phone in ship-to so Brian knows who it's for
        shipToName: usingEstCustomer && customerName ? customerName : undefined,
        shipToPhone: usingEstCustomer && customerPhone ? customerPhone : undefined,
        deliveryAddress: deliveryAddress || undefined,
        customerMemo: [
          `PRELIMINARY ESTIMATE — For bidding purposes only.`,
          `Quoted via ai.rebarconcreteproducts.com`,
          usingEstCustomer && customerName ? `Customer: ${customerName}${customerPhone ? ` / ${customerPhone}` : ""}` : null,
          deliveryAddress ? `Delivery address: ${deliveryAddress}` : null,
          deliveryNotes ? deliveryNotes : null,
        ].filter(Boolean).join(" | "),
      });

      // Email the estimate link to the customer
      if (customerEmail) {
        sendEstimateEmail({
          to: customerEmail,
          customerName: customerName || "Customer",
          estimateNumber: est.estimateNumber,
          total,
          estimateLink: est.estimateLink,
        }).catch(e => console.warn("[WEB-ESTIMATE] Email error:", e));
      }

      const label = usingEstCustomer ? `${customerName || "anonymous"} (EST customer)` : customerName;
      console.log(`[WEB-ESTIMATE] Estimate #${est.estimateNumber} created for ${label} via web chat — $${total}`);

      res.json({
        success: true,
        estimateNumber: est.estimateNumber,
        estimateId: est.estimateId,
        estimateLink: est.estimateLink,
        subtotal,
        tax,
        total,
      });
    } catch (err: any) {
      console.error("[WEB-ESTIMATE ERROR]", err);
      res.status(500).json({ error: err.message || "Failed to create estimate" });
    }
  });

  // ── Send payment link SMS from web chat (no existing invoice yet) ──────────────
  // Body: { phone: "+15551234567" }
  // Sends a simple confirmation SMS so the customer knows their order was received
  // and that a real payment link is coming once the invoice is created manually.
  app.post("/api/send-payment-link-sms", express.json(), async (req, res) => {
    try {
      const { phone } = req.body;
      if (!phone) return res.status(400).json({ error: "phone is required" });
      if (!isTwilioConfigured()) return res.status(503).json({ error: "SMS not configured" });
      const cleaned = phone.replace(/\D/g, "");
      const e164 = cleaned.startsWith("1") ? "+" + cleaned : "+1" + cleaned;
      if (cleaned.length < 10) return res.status(400).json({ error: "Invalid phone number" });
      await sendSms(
        e164,
        "Rebar Concrete Products: Your order request has been received. " +
        "We will create your invoice and send you a payment link shortly. " +
        "Call 469-631-7730 with any questions."
      );
      console.log(`[send-payment-link-sms] Sent confirmation to ${e164}`);
      res.json({ success: true });
    } catch (err: any) {
      console.error("[send-payment-link-sms] Error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Delivery distance + fee lookup (used by EstimatingBot chat) ──────────────
  // GET /api/calc-delivery?address=<encoded address>
  // Returns { miles, fee, free, freeThreshold } or { error }
  app.get("/api/calc-delivery", async (req, res) => {
    const address = req.query.address as string;
    if (!address) return res.status(400).json({ error: "address is required" });
    try {
      const result = await calcDeliveryFee(address);
      if (!result) return res.status(422).json({ error: "Could not calculate distance — check the address and try again." });
      // Determine which free delivery tier applies at this distance
      const FREE_DELIVERY_TIERS = [
        { miles: 30, minOrder: 1000 },
        { miles: 40, minOrder: 2000 },
        { miles: 55, minOrder: 4000 },
        { miles: 65, minOrder: 8000 },
      ];
      const tier = FREE_DELIVERY_TIERS.find(t => result.miles <= t.miles);
      res.json({
        miles: result.miles,
        fee: result.fee,
        freeThreshold: tier ? tier.minOrder : null,  // min order for free delivery at this distance
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Distance lookup failed" });
    }
  });

  // ── /chat — proxy for ai.rebarconcreteproducts.com with postMessage listener injected ──
  // Fetches the estimatingbot HTML and injects our chip→chatbot postMessage script
  // so the Shopify homepage chips can inject prompts cross-origin.
  app.get("/chat", async (_req, res) => {
    try {
      const upstream = await fetch("https://ai.rebarconcreteproducts.com");
      let html = await upstream.text();

      const LISTENER_SCRIPT = `<script>
    // ── Prevent this iframe from scrolling the parent page ──
    (function() {
      var origFocus = HTMLElement.prototype.focus;
      HTMLElement.prototype.focus = function(opts) {
        origFocus.call(this, { preventScroll: true });
      };
      var origScrollIntoView = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function(opts) {
        origScrollIntoView.call(this, opts);
        try { window.parent.postMessage({ type: 'rcp-no-scroll' }, '*'); } catch(e) {}
      };
      document.addEventListener('focus', function(e) {
        if (e.target && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT')) {
          var x = window.scrollX, y = window.scrollY;
          setTimeout(function() { window.scrollTo(x, y); }, 0);
        }
      }, true);
    })();

    // ── postMessage listener — allows parent page chips to inject prompts ──
    window.addEventListener('message', function(e) {
      if (!e.data || e.data.type !== 'rcp-prompt') return;
      var prompt = e.data.text;
      if (!prompt) return;
      function tryInject(attempts) {
        var ta = document.querySelector('textarea');
        if (!ta && attempts > 0) {
          setTimeout(function(){ tryInject(attempts - 1); }, 200);
          return;
        }
        if (!ta) return;
        // Set value via React's native setter so state updates
        var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        nativeInputValueSetter.call(ta, prompt);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
        ta.focus({ preventScroll: true });
        // Submit via Enter key — the chat app listens for keydown Enter on the textarea
        setTimeout(function() {
          ta.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13,
            which: 13, bubbles: true, cancelable: true
          }));
          ta.dispatchEvent(new KeyboardEvent('keypress', {
            key: 'Enter', code: 'Enter', keyCode: 13,
            which: 13, bubbles: true, cancelable: true
          }));
          ta.dispatchEvent(new KeyboardEvent('keyup', {
            key: 'Enter', code: 'Enter', keyCode: 13,
            which: 13, bubbles: true, cancelable: true
          }));
          // Fallback: also try clicking the last button (send button)
          setTimeout(function() {
            if (ta.value && ta.value.trim()) {
              var btns = document.querySelectorAll('button');
              var lastBtn = btns[btns.length - 1];
              if (lastBtn) lastBtn.click();
            }
          }, 200);
        }, 300);
      }
      tryInject(20);
    });
  <\/script>`;

      // Keep asset URLs as relative ./assets/ — they will be served by /chat-assets/* below
      // (no rewriting needed — relative paths resolve correctly from /chat)

      // Inject our listener script just before </body>
      html = html.replace('</body>', LISTENER_SCRIPT + '\n</body>');

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('X-Frame-Options', 'ALLOWALL');
      res.setHeader('Content-Security-Policy', '');
      res.send(html);
    } catch (err: any) {
      res.status(502).send('Chat unavailable: ' + err.message);
    }
  });

  // ── /rcpchat — standalone RCP AI chat (new path, bypasses CDN cache) ──
  app.get(["/rcpchat", "/rcpchat/"], (_req, res) => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>RCP AI Assistant</title>
  <link rel="preconnect" href="https://api.fontshare.com" />
  <link href="https://api.fontshare.com/v2/css?f[]=general-sans@400,500,600&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; background: #0f0f0f; color: #e8e8e8; font-family: 'General Sans', system-ui, sans-serif; font-size: 14px; overflow: hidden; }
    #chat-root { display: flex; flex-direction: column; height: 100%; max-height: 100vh; }
    #chat-header { display: flex; align-items: center; gap: 10px; padding: 10px 14px; background: #1a1a1a; border-bottom: 1px solid #2a2a2a; flex-shrink: 0; }
    #chat-header .dot { width: 8px; height: 8px; border-radius: 50%; background: #C8D400; flex-shrink: 0; }
    #chat-header span { font-size: 12px; font-weight: 600; letter-spacing: 0.04em; color: #C8D400; text-transform: uppercase; }
    #messages { flex: 1; overflow-y: auto; padding: 16px 14px; display: flex; flex-direction: column; gap: 12px; scroll-behavior: smooth; }
    #messages::-webkit-scrollbar { width: 4px; }
    #messages::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
    .msg { display: flex; flex-direction: column; max-width: 88%; }
    .msg.user { align-self: flex-end; align-items: flex-end; }
    .msg.bot { align-self: flex-start; align-items: flex-start; }
    .bubble { padding: 9px 13px; border-radius: 14px; line-height: 1.5; font-size: 13.5px; white-space: pre-wrap; word-break: break-word; }
    .msg.user .bubble { background: #C8D400; color: #16161d; border-bottom-right-radius: 4px; font-weight: 500; }
    .msg.bot .bubble { background: #1e1e1e; color: #e0e0e0; border: 1px solid #2e2e2e; border-bottom-left-radius: 4px; }
    .typing-dot { display: inline-block; width: 6px; height: 6px; background: #666; border-radius: 50%; margin: 0 2px; animation: blink 1.2s infinite; }
    .typing-dot:nth-child(2) { animation-delay: 0.2s; }
    .typing-dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes blink { 0%, 80%, 100% { opacity: 0.2; transform: scale(0.85); } 40% { opacity: 1; transform: scale(1); } }
    #input-area { display: flex; align-items: flex-end; gap: 8px; padding: 10px 12px; background: #1a1a1a; border-top: 1px solid #2a2a2a; flex-shrink: 0; }
    #user-input { flex: 1; background: #111; border: 1px solid #333; border-radius: 10px; color: #e8e8e8; font-family: inherit; font-size: 13.5px; line-height: 1.4; padding: 8px 12px; resize: none; max-height: 120px; outline: none; transition: border-color 0.2s; }
    #user-input:focus { border-color: #C8D400; }
    #user-input::placeholder { color: #555; }
    #send-btn { flex-shrink: 0; width: 36px; height: 36px; border-radius: 10px; border: none; background: #C8D400; color: #16161d; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background 0.15s, transform 0.1s; }
    #send-btn:hover { background: #d4e000; }
    #send-btn:active { transform: scale(0.93); }
    #send-btn:disabled { background: #333; color: #555; cursor: not-allowed; transform: none; }
    #send-btn svg { width: 16px; height: 16px; stroke: #16161d !important; }
  </style>
</head>
<body>
  <div id="chat-root">
    <div id="chat-header">
      <div class="dot"></div>
      <span>RCP AI Assistant</span>
    </div>
    <div id="messages">
      <div class="msg bot">
        <div class="bubble">Hi! I'm the RCP AI assistant. Ask me anything about rebar pricing, delivery, estimating, or to get a takeoff started.</div>
      </div>
    </div>
    <div id="input-area">
      <textarea id="user-input" rows="1" placeholder="Ask about pricing, delivery, estimating…" maxlength="2000"></textarea>
      <button id="send-btn" title="Send">
        <svg viewBox="0 0 24 24" fill="none" stroke="#16161d" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="22" y1="2" x2="11" y2="13"></line>
          <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
        </svg>
      </button>
    </div>
  </div>
  <script>
    const API = '/api/chat-proxy';
    const messagesEl = document.getElementById('messages');
    const inputEl = document.getElementById('user-input');
    const sendBtn = document.getElementById('send-btn');
    let history = [];
    let busy = false;
    function scrollBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }
    function addBubble(role, text) {
      const wrap = document.createElement('div'); wrap.className = 'msg ' + role;
      const bubble = document.createElement('div'); bubble.className = 'bubble'; bubble.textContent = text;
      wrap.appendChild(bubble); messagesEl.appendChild(wrap); scrollBottom(); return bubble;
    }
    function showTyping() {
      const wrap = document.createElement('div'); wrap.className = 'msg bot'; wrap.id = 'typing-indicator';
      const bubble = document.createElement('div'); bubble.className = 'bubble';
      bubble.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
      wrap.appendChild(bubble); messagesEl.appendChild(wrap); scrollBottom();
    }
    function removeTyping() { const el = document.getElementById('typing-indicator'); if (el) el.remove(); }
    async function sendMessage() {
      if (busy) return;
      const text = inputEl.value.trim(); if (!text) return;
      inputEl.value = ''; inputEl.style.height = 'auto';
      busy = true; sendBtn.disabled = true;
      addBubble('user', text); history.push({ role: 'user', content: text }); showTyping();
      try {
        const resp = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: history, imageBase64: null, imageMediaType: null }) });
        removeTyping();
        if (!resp.ok) { addBubble('bot', 'Sorry, something went wrong (' + resp.status + '). Please try again.'); }
        else {
          const data = await resp.json();
          const reply = (data && (data.reply || data.message || data.content || data.text)) || 'No response received.';
          addBubble('bot', reply); history.push({ role: 'assistant', content: reply });
        }
      } catch (err) { removeTyping(); addBubble('bot', 'Connection error — please check your network and try again.'); }
      busy = false; sendBtn.disabled = false; inputEl.focus();
    }
    inputEl.addEventListener('input', function() { this.style.height = 'auto'; this.style.height = Math.min(this.scrollHeight, 120) + 'px'; });
    inputEl.addEventListener('keydown', function(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
    sendBtn.addEventListener('click', sendMessage);
    window.addEventListener('message', function(e) { if (!e.data || e.data.type !== 'rcp-prompt') return; if (e.data.text) { inputEl.value = e.data.text; inputEl.dispatchEvent(new Event('input')); sendMessage(); } });
    // Auto-fill from ?prompt= URL param
    (function() {
      var p = new URLSearchParams(window.location.search).get('prompt');
      if (p) { inputEl.value = p; inputEl.dispatchEvent(new Event('input')); setTimeout(sendMessage, 400); }
    })();
    inputEl.focus();
  <\/script>
</body>
</html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Content-Security-Policy', '');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(html);
  });

  // ── /api/chat-proxy — forward chat requests to ai.rebarconcreteproducts.com ──
  // Used by the /chat-widget iframe so the fetch stays same-origin (Railway)
  // which already has CORS configured for the Shopify storefront.
  // Also strips internal control tags ([CONFIRM_ORDER], etc.) so they never
  // reach the customer's screen, and optionally triggers SMS payment links.
  app.post("/api/chat-proxy", express.json(), async (req, res) => {
    try {
      const upstream = await fetch("https://ai.rebarconcreteproducts.com/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body),
      });
      const data = await upstream.json();
      res.setHeader("Access-Control-Allow-Origin", "*");

      // ── Strip internal control tags + order/estimate code fences from reply ──
      const INTERNAL_TAGS = /\[(CONFIRM_ORDER|CONFIRM_ESTIMATE|INFO_COMPLETE|PLAN_TAKEOFF:[^\]]*|CALC_DELIVERY:[^\]]*|LOOKUP_CUSTOMER:[^\]]*|ESTIMATE_READY)\]/g;
      const ORDER_FENCE = /```order\s*([\s\S]*?)```/i;
      const replyField = data.reply ?? data.message ?? data.content ?? data.text;
      let confirmOrderTriggered = false;
      let confirmEstimateTriggered = false;
      let extractedOrderJson: any = null;
      if (typeof replyField === "string") {
        let cleaned = replyField;
        // Extract order JSON from code fence before stripping it
        const fenceMatch = cleaned.match(ORDER_FENCE);
        if (fenceMatch) {
          // Determine if this is an invoice or estimate based on readyToInvoice flag
          try {
            const parsedJson = JSON.parse(fenceMatch[1].trim());
            extractedOrderJson = parsedJson;
            if (parsedJson.readyToEstimate === true) {
              confirmEstimateTriggered = true;
            } else {
              confirmOrderTriggered = true;
            }
          } catch {
            confirmOrderTriggered = true; // default to invoice if parse fails
          }
          cleaned = cleaned.replace(ORDER_FENCE, "").replace(/\n{3,}/g, "\n\n").trim();
        }
        // Strip [CONFIRM_ORDER] / [CONFIRM_ESTIMATE] and other internal tags
        if (cleaned.includes("[CONFIRM_ORDER]")) confirmOrderTriggered = true;
        if (cleaned.includes("[CONFIRM_ESTIMATE]")) confirmEstimateTriggered = true;
        cleaned = cleaned.replace(INTERNAL_TAGS, "").replace(/  +/g, " ").trim();
        if (data.reply !== undefined)   data.reply   = cleaned;
        if (data.message !== undefined) data.message = cleaned;
        if (data.content !== undefined) data.content = cleaned;
        if (data.text !== undefined)    data.text    = cleaned;
      }

      // ── If order was confirmed, send verification code then create invoice ──
      if (confirmOrderTriggered && extractedOrderJson) {
        try {
          // Merge customer identity fields from req.body into the AI-generated order payload
          // (the AI's order JSON doesn't include customerEmail — we inject it here)
          const orderPayload = {
            ...extractedOrderJson,
            customerName: extractedOrderJson.customerName || req.body?.customerName || "",
            customerPhone: extractedOrderJson.customerPhone || req.body?.customerPhone || "",
            customerEmail: extractedOrderJson.customerEmail || req.body?.customerEmail || "",
          };
          const rawPhone: string = orderPayload.customerPhone || "";
          const cleanedPhone = rawPhone.replace(/\D/g, "");
          const e164 = cleanedPhone.startsWith("1") ? "+" + cleanedPhone : "+1" + cleanedPhone;

          // ── Verification gate for web chat ─────────────────────────────────────────
          // Check if this request includes a verified code from the widget
          const submittedCode: string = req.body?.verificationCode || "";
          const alreadyVerified = verifiedWebPhones.get(e164) && (Date.now() - verifiedWebPhones.get(e164)!) <= 10 * 60 * 1000;

          if (!submittedCode && !alreadyVerified) {
            // No code yet — send verification code and ask widget to collect it
            const code = generateCode();
            pendingVerifications.set(e164, { code, expiresAt: Date.now() + 5 * 60 * 1000, payload: orderPayload, attempts: 0 });
            try { await sendVerificationCode(e164, code); } catch (smsErr) {
              console.error("[chat-proxy] Failed to send verification SMS:", smsErr);
            }
            console.log(`[chat-proxy] Verification code sent to ${e164} — awaiting customer reply`);
            const verifyPrompt = "To confirm your order, please enter the 6-digit verification code we just texted to your phone.";
            if (data.reply !== undefined)   data.reply   = verifyPrompt;
            if (data.message !== undefined) data.message = verifyPrompt;
            if (data.content !== undefined) data.content = verifyPrompt;
            if (data.text !== undefined)    data.text    = verifyPrompt;
            data.verificationRequired = true;
            res.json(data);
            return;
          }

          if (submittedCode && !alreadyVerified) {
            // Customer submitted a code — validate it
            const normalized = normalizeVerifyInput(submittedCode);
            const pending = pendingVerifications.get(e164);
            if (!pending || Date.now() > pending.expiresAt) {
              pendingVerifications.delete(e164);
              const expiredMsg = "Your verification code has expired. Please start your order again.";
              if (data.reply !== undefined)   data.reply   = expiredMsg;
              if (data.message !== undefined) data.message = expiredMsg;
              if (data.content !== undefined) data.content = expiredMsg;
              if (data.text !== undefined)    data.text    = expiredMsg;
              data.verificationFailed = true;
              res.json(data);
              return;
            }
            pending.attempts++;
            if (pending.attempts > 5 || normalized !== pending.code) {
              if (pending.attempts > 5) pendingVerifications.delete(e164);
              const remaining = Math.max(0, 6 - pending.attempts);
              const wrongMsg = pending.attempts > 5
                ? "Too many incorrect attempts. Please start your order again."
                : `Incorrect code. ${remaining} attempt(s) remaining.`;
              if (data.reply !== undefined)   data.reply   = wrongMsg;
              if (data.message !== undefined) data.message = wrongMsg;
              if (data.content !== undefined) data.content = wrongMsg;
              if (data.text !== undefined)    data.text    = wrongMsg;
              data.verificationFailed = true;
              res.json(data);
              return;
            }
            // Code matched — grant token
            pendingVerifications.delete(e164);
            verifiedWebPhones.set(e164, Date.now());
            console.log(`[chat-proxy] Verification code confirmed for ${e164}`);
          }
          // ────────────────────────────────────────────────────────────────────────────

          // POST to our own /api/web-order to create QBO invoice (await so we can inject error into reply)
          const origin = `${req.protocol}://${req.get('host')}`;
          const orderResp = await fetch(`${origin}/api/web-order`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // Include verifiedPhone so the /api/web-order verification gate passes
            body: JSON.stringify({ ...orderPayload, verifiedPhone: e164 }),
          });
          const orderData = await orderResp.json();

          if (orderData.error === "customer_not_found") {
            // Inject error message directly into the chat reply so the widget shows it
            const errorMsg = "I wasn't able to locate an account matching your name and phone number in our system. To place orders online, you'll need an account on file — please stop by our store at 2112 N Custer Rd, McKinney, TX or call us at 469-631-7730 to get set up. It only takes a few minutes!";
            if (data.reply !== undefined)   data.reply   = errorMsg;
            if (data.message !== undefined) data.message = errorMsg;
            if (data.content !== undefined) data.content = errorMsg;
            if (data.text !== undefined)    data.text    = errorMsg;
            console.warn(`[chat-proxy] customer_not_found for: ${orderPayload.customerName} / ${orderPayload.customerPhone}`);
          } else if (orderData.paymentLink) {
            // Invoice created — SMS the payment link
            data.confirmOrderTriggered = true;
            data.invoiceNumber = orderData.invoiceNumber;
            data.paymentLink = orderData.paymentLink;
            data.total = orderData.total;
            if (cleanedPhone.length >= 10 && isTwilioConfigured()) {
              sendSms(
                e164,
                `Rebar Concrete Products: Your invoice #${orderData.invoiceNumber} is ready. ` +
                `Total: $${Number(orderData.total).toFixed(2)}. ` +
                `Pay here: ${orderData.paymentLink}`
              ).catch(e => console.error("[chat-proxy] SMS error:", e));
              console.log(`[chat-proxy] Payment link SMS sent to ${e164} for invoice #${orderData.invoiceNumber}`);
            }
          } else {
            data.confirmOrderTriggered = true;
            if (cleanedPhone.length >= 10 && isTwilioConfigured()) {
              sendSms(
                e164,
                "Rebar Concrete Products: Your order was received. " +
                "We're preparing your invoice and will send a payment link shortly. " +
                "Questions? Call 469-631-7730."
              ).catch(e => console.error("[chat-proxy] SMS error:", e));
            }
          }
        } catch (bgErr) {
          console.error("[chat-proxy] Invoice creation error:", bgErr);
          data.confirmOrderTriggered = true; // still flag it so widget doesn't retry
        }
      } else if (confirmOrderTriggered) {
        // [CONFIRM_ORDER] tag only (no order JSON) — send basic acknowledgement SMS if phone present
        const rawPhone: string = req.body?.customerPhone || "";
        const cleanedPhone = rawPhone.replace(/\D/g, "");
        if (cleanedPhone.length >= 10 && isTwilioConfigured()) {
          const e164 = cleanedPhone.startsWith("1") ? "+" + cleanedPhone : "+1" + cleanedPhone;
          sendSms(
            e164,
            "Rebar Concrete Products: Your order request was received. " +
            "We will prepare your invoice and text you a payment link shortly. " +
            "Call 469-631-7730 with any questions."
          ).catch(err => console.warn("[chat-proxy] SMS fallback failed:", err));
        }
        data.confirmOrderTriggered = true;
      } else if (confirmEstimateTriggered && extractedOrderJson) {
        // ── [CONFIRM_ESTIMATE] with order JSON — create QBO Estimate (no verification gate) ──
        try {
          const estimatePayload = {
            ...extractedOrderJson,
            customerName: extractedOrderJson.customerName || req.body?.customerName || "",
            customerPhone: extractedOrderJson.customerPhone || req.body?.customerPhone || "",
            customerEmail: extractedOrderJson.customerEmail || req.body?.customerEmail || "",
          };
          const origin = `${req.protocol}://${req.get('host')}`;
          const estResp = await fetch(`${origin}/api/web-estimate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              customerName: estimatePayload.customerName,
              customerEmail: estimatePayload.customerEmail,
              customerPhone: estimatePayload.customerPhone,
              customerCompany: estimatePayload.customerCompany || "",
              deliveryAddress: estimatePayload.deliveryAddress || "",
              deliveryNotes: estimatePayload.deliveryNotes || "",
              items: estimatePayload.items || [],
            }),
          });
          const estData = await estResp.json();

          if (estData.estimateNumber) {
            data.confirmEstimateTriggered = true;
            data.estimateNumber = estData.estimateNumber;
            data.estimateLink = estData.estimateLink;
            data.total = estData.total;
            // Send SMS confirmation if phone available
            const rawEstPhone: string = estimatePayload.customerPhone || "";
            const cleanEstPhone = rawEstPhone.replace(/\D/g, "");
            if (cleanEstPhone.length >= 10 && isTwilioConfigured()) {
              const estE164 = cleanEstPhone.startsWith("1") ? "+" + cleanEstPhone : "+1" + cleanEstPhone;
              const estimateEmail = estimatePayload.customerEmail;
              sendSms(
                estE164,
                estimateEmail
                  ? `Rebar Concrete Products: Your estimate #${estData.estimateNumber} is ready ($${Number(estData.total).toFixed(2)}). Check your email at ${estimateEmail} for the full estimate. Call 469-631-7730 to place your order.`
                  : `Rebar Concrete Products: Your estimate #${estData.estimateNumber} is ready ($${Number(estData.total).toFixed(2)}). Call 469-631-7730 to review it or place your order.`
              ).catch(e => console.error("[chat-proxy] Estimate SMS error:", e));
            }
          } else {
            data.confirmEstimateTriggered = true;
          }
        } catch (estBgErr) {
          console.error("[chat-proxy] Estimate creation error:", estBgErr);
          data.confirmEstimateTriggered = true;
        }
      } else if (confirmEstimateTriggered) {
        // [CONFIRM_ESTIMATE] tag only (no order JSON) — basic SMS acknowledgement
        const rawPhone: string = req.body?.customerPhone || "";
        const cleanedPhone = rawPhone.replace(/\D/g, "");
        if (cleanedPhone.length >= 10 && isTwilioConfigured()) {
          const e164 = cleanedPhone.startsWith("1") ? "+" + cleanedPhone : "+1" + cleanedPhone;
          sendSms(
            e164,
            "Rebar Concrete Products: Your estimate request was received. " +
            "We will email your estimate shortly. " +
            "Call 469-631-7730 with any questions."
          ).catch(err => console.warn("[chat-proxy] Estimate SMS fallback failed:", err));
        }
        data.confirmEstimateTriggered = true;
      }

      res.json(data);
    } catch (err: any) {
      res.status(502).json({ error: "Chat proxy error: " + err.message });
    }
  });

  // ── /chat-widget — standalone RCP AI chat panel (no proxy, no external page) ──
  app.get("/chat-widget", (_req, res) => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>RCP AI Assistant</title>
  <link rel="preconnect" href="https://api.fontshare.com" />
  <link href="https://api.fontshare.com/v2/css?f[]=general-sans@400,500,600&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      height: 100%;
      background: #0f0f0f;
      color: #e8e8e8;
      font-family: 'General Sans', system-ui, sans-serif;
      font-size: 14px;
      overflow: hidden;
    }
    #chat-root {
      display: flex;
      flex-direction: column;
      height: 100%;
      max-height: 100vh;
    }
    /* ── Header bar ── */
    #chat-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      background: #1a1a1a;
      border-bottom: 1px solid #2a2a2a;
      flex-shrink: 0;
    }
    #chat-header .dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: #C8D400;
      flex-shrink: 0;
    }
    #chat-header span {
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.04em;
      color: #C8D400;
      text-transform: uppercase;
    }
    /* ── Message list ── */
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px 14px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      scroll-behavior: smooth;
    }
    #messages::-webkit-scrollbar { width: 4px; }
    #messages::-webkit-scrollbar-track { background: transparent; }
    #messages::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
    .msg {
      display: flex;
      flex-direction: column;
      max-width: 88%;
    }
    .msg.user { align-self: flex-end; align-items: flex-end; }
    .msg.bot  { align-self: flex-start; align-items: flex-start; }
    .bubble {
      padding: 9px 13px;
      border-radius: 14px;
      line-height: 1.5;
      font-size: 13.5px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .msg.user .bubble {
      background: #C8D400;
      color: #16161d;
      border-bottom-right-radius: 4px;
      font-weight: 500;
    }
    .msg.bot .bubble {
      background: #1e1e1e;
      color: #e0e0e0;
      border: 1px solid #2e2e2e;
      border-bottom-left-radius: 4px;
    }
    .typing-dot {
      display: inline-block;
      width: 6px; height: 6px;
      background: #666;
      border-radius: 50%;
      margin: 0 2px;
      animation: blink 1.2s infinite;
    }
    .typing-dot:nth-child(2) { animation-delay: 0.2s; }
    .typing-dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes blink {
      0%, 80%, 100% { opacity: 0.2; transform: scale(0.85); }
      40% { opacity: 1; transform: scale(1); }
    }
    /* ── Input area ── */
    #input-area {
      display: flex;
      align-items: flex-end;
      gap: 8px;
      padding: 10px 12px;
      background: #1a1a1a;
      border-top: 1px solid #2a2a2a;
      flex-shrink: 0;
    }
    #user-input {
      flex: 1;
      background: #111;
      border: 1px solid #333;
      border-radius: 10px;
      color: #e8e8e8;
      font-family: inherit;
      font-size: 13.5px;
      line-height: 1.4;
      padding: 8px 12px;
      resize: none;
      max-height: 120px;
      outline: none;
      transition: border-color 0.2s;
    }
    #user-input:focus { border-color: #C8D400; }
    #user-input::placeholder { color: #555; }
    #send-btn {
      flex-shrink: 0;
      width: 36px; height: 36px;
      border-radius: 10px;
      border: none;
      background: #C8D400;
      color: #16161d;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s, transform 0.1s;
    }
    #send-btn:hover { background: #d4e000; }
    #send-btn:active { transform: scale(0.93); }
    #send-btn:disabled { background: #333; color: #555; cursor: not-allowed; transform: none; }
    #send-btn svg { width: 16px; height: 16px; stroke: #16161d !important; }
  </style>
</head>
<body>
  <div id="chat-root">
    <div id="chat-header">
      <div class="dot"></div>
      <span>RCP AI Assistant</span>
    </div>
    <div id="messages">
      <div class="msg bot">
        <div class="bubble">Hi! I'm the RCP AI assistant. Ask me anything about rebar pricing, delivery, estimating, or to get a takeoff started.</div>
      </div>
    </div>
    <div id="input-area">
      <textarea id="user-input" rows="1" placeholder="Ask about pricing, delivery, estimating…" maxlength="2000"></textarea>
      <button id="send-btn" title="Send">
        <svg viewBox="0 0 24 24" fill="none" stroke="#16161d" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="22" y1="2" x2="11" y2="13"></line>
          <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
        </svg>
      </button>
    </div>
  </div>

  <script>
    const API = '/api/chat-proxy';
    const messagesEl = document.getElementById('messages');
    const inputEl    = document.getElementById('user-input');
    const sendBtn    = document.getElementById('send-btn');
    let history = [];
    let busy = false;

    function scrollBottom() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function addBubble(role, text) {
      const wrap = document.createElement('div');
      wrap.className = 'msg ' + role;
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = text;
      wrap.appendChild(bubble);
      messagesEl.appendChild(wrap);
      scrollBottom();
      return bubble;
    }

    function showTyping() {
      const wrap = document.createElement('div');
      wrap.className = 'msg bot';
      wrap.id = 'typing-indicator';
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
      wrap.appendChild(bubble);
      messagesEl.appendChild(wrap);
      scrollBottom();
    }

    function removeTyping() {
      const el = document.getElementById('typing-indicator');
      if (el) el.remove();
    }

    async function sendMessage() {
      if (busy) return;
      const text = inputEl.value.trim();
      if (!text) return;

      inputEl.value = '';
      inputEl.style.height = 'auto';
      busy = true;
      sendBtn.disabled = true;

      addBubble('user', text);
      history.push({ role: 'user', content: text });
      showTyping();

      try {
        const resp = await fetch(API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: history, imageBase64: null, imageMediaType: null })
        });

        removeTyping();

        if (!resp.ok) {
          addBubble('bot', 'Sorry, something went wrong (' + resp.status + '). Please try again.');
        } else {
          const data = await resp.json();
          const reply = (data && (data.reply || data.message || data.content || data.text)) || 'No response received.';
          addBubble('bot', reply);
          history.push({ role: 'assistant', content: reply });
        }
      } catch (err) {
        removeTyping();
        addBubble('bot', 'Connection error — please check your network and try again.');
      }

      busy = false;
      sendBtn.disabled = false;
      inputEl.focus();
    }

    inputEl.addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    });

    inputEl.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    sendBtn.addEventListener('click', sendMessage);

    window.addEventListener('message', function(e) {
      if (!e.data || e.data.type !== 'rcp-prompt') return;
      if (e.data.text) {
        inputEl.value = e.data.text;
        inputEl.dispatchEvent(new Event('input'));
        sendMessage();
      }
    });

    // Auto-fill from ?prompt= URL param
    (function() {
      var p = new URLSearchParams(window.location.search).get('prompt');
      if (p) { inputEl.value = p; inputEl.dispatchEvent(new Event('input')); setTimeout(sendMessage, 400); }
    })();

    inputEl.focus();
  <\/script>
</body>
</html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Content-Security-Policy', '');
    res.send(html);
  });

  // ── /api/admin/digest — trigger daily digest manually or via cron ──────────
  app.post("/api/admin/digest", async (_req, res) => {
    try {
      const result = await sendDailyDigest();
      res.json(result);
    } catch (err: any) {
      console.error("[Digest] Error sending digest:", err);
      res.status(500).json({ sent: false, error: err.message });
    }
  });
}

