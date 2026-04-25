import type { Express } from "express";
import type { Server } from "http";
import express from "express";
import { storage } from "./storage";
import { sendSms, isTwilioConfigured, sendPaymentLinkEmail } from "./sms";
import { processMessage, extractOrderFromConversation, extractCustomerInfo, isAiConfigured } from "./ai";
import { syncProducts, findOrCreateCustomer, findExistingCustomer, createInvoice, createEstimate, getEstimateStatus, lookupCustomerByPhone, calcDeliveryFee, isQboConfigured, getCustomerInvoices, convertEstimateToInvoice, updateRailwayEnvVar, setLiveRefreshToken, getOrCreateBotCustomer, getQboItems } from "./qbo";
import { performTakeoff } from "./takeoff";
import { resolveLinksFromText, extractUrls } from "./link-resolver";
import { generateCutSheetPdf, emailCutSheet, emailCutSheetToCustomer, generatePlacementDrawingPdf, forwardPlansToOffice, generateBidPdf, emailBidPdf, OFFICE_EMAIL } from "./cutsheet";
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

export function registerRoutes(httpServer: Server, app: Express) {
  // Register the token-export endpoint FIRST to guarantee no catch-all/static
  // middleware can intercept it. Returns JSON of current QBO refresh token state.

  // GET /api/qbo/items — returns all active QBO items with live pricing
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
        // Extract order, create QBO invoice, send payment link
        await handleOrderConfirmation(conv.id, cleanPhone);
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
      const BUNDLE_SIZES: Record<string, number> = {
        "#3": 266, "#4": 150, "#5": 96, "#6": 68,
        "#7": 50, "#8": 38, "#9": 30, "#10": 24, "#11": 18, "#14": 10, "#18": 6
      };

      // Enrich line item descriptions with bundle + piece breakdown for warehouse
      function addBundleDesc(item: LineItem): LineItem {
        // Skip fabrication, delivery, custom items
        if (item.qboItemId === "1010000301" || item.qboItemId === "CUSTOM") return item;
        // Parse bar size from name (e.g. "Rebar #4 20'" → "#4")
        const sizeMatch = item.name.match(/(#\d+)/);
        if (!sizeMatch) return item;
        const barSize = sizeMatch[1];
        const bundleSize = BUNDLE_SIZES[barSize];
        if (!bundleSize) return item;
        const pcs = Math.round(item.qty);
        const fullBundles = Math.floor(pcs / bundleSize);
        const remainder = pcs % bundleSize;
        let bundleDesc = "";
        if (fullBundles > 0 && remainder > 0) {
          bundleDesc = `${fullBundles} full bundle${fullBundles > 1 ? "s" : ""} (${fullBundles * bundleSize} pcs) + ${remainder} individual pcs — ${pcs} pcs total`;
        } else if (fullBundles > 0) {
          bundleDesc = `${fullBundles} full bundle${fullBundles > 1 ? "s" : ""} — ${pcs} pcs total`;
        } else {
          bundleDesc = `${pcs} individual pcs (no full bundles)`;
        }
        const existingDesc = item.description ? `${item.description} | ` : "";
        return { ...item, description: `${existingDesc}${bundleDesc}` };
      }

      if (qboCustomerId && isQboConfigured()) {
        const qboInvoiceItems = (orderData.lineItems as LineItem[]).filter(i => i.qboItemId !== "CUSTOM").map(addBundleDesc);
        const customInvoiceItems = (orderData.lineItems as LineItem[]).filter(i => i.qboItemId === "CUSTOM");
        const customInvoiceNote = customInvoiceItems.length > 0
          ? ` | Unmatched items (TBD): ${customInvoiceItems.map(i => i.name).join(", ")}`
          : "";
        const invoice = await createInvoice({
          customerId: qboCustomerId,
          customerEmail: conv.customerEmail!,
          lineItems: qboInvoiceItems,
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
      const { customerName, customerEmail, customerPhone, customerCompany, deliveryAddress, deliveryNotes, deliveryMilesFallback, deliveryFeeFallback, items } = req.body;

      if (!customerName || !customerPhone || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: "customerName, customerPhone, and items are required" });
      }

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

      const { invoiceId, invoiceNumber, paymentLink } = await createInvoice({
        customerId,
        customerEmail,
        lineItems,
        deliveryFee: deliveryFee > 0 ? deliveryFee : undefined,
        deliveryMiles: deliveryMilesWeb,
        deliveryAddress: deliveryAddress || "",
        deliveryNotes: deliveryNotes || undefined,
        customerMemo: `Web order via ai.rebarconcreteproducts.com`,
      });

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

      console.log(`[WEB-ORDER] Invoice #${invoiceNumber} created for ${customerName} via web chat — $${total}`);

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
}
