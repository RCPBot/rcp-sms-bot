import type { Express } from "express";
import type { Server } from "http";
import express from "express";
import { storage } from "./storage";
import { sendSms, isTwilioConfigured, sendPaymentLinkEmail } from "./sms";
import { processMessage, extractOrderFromConversation, extractCustomerInfo, isAiConfigured } from "./ai";
import { syncProducts, findOrCreateCustomer, createInvoice, createEstimate, getEstimateStatus, lookupCustomerByPhone, calcDeliveryFee, isQboConfigured, getCustomerInvoices, convertEstimateToInvoice, updateRailwayEnvVar, setLiveRefreshToken } from "./qbo";
import { performTakeoff } from "./takeoff";
import { resolveLinksFromText, extractUrls } from "./link-resolver";
import { generateCutSheetPdf, emailCutSheet } from "./cutsheet";
import type { LineItem } from "@shared/schema";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const OWNER_EMAIL = "maddoxconstruction1987@gmail.com";
const TAX_RATE = 0.0825; // McKinney, TX: 8.25% combined sales tax

const orderConfirmationInProgress = new Set<number>();

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
      let conv = storage.getOrCreateConversation(cleanPhone);

      // ── FRAUD GATE: existing customers only ──────────────────────────────────
      if (conv.stage === "greeting" && !conv.verified && isQboConfigured()) {
        const found = await lookupCustomerByPhone(cleanPhone);
        if (found) {
          conv = storage.updateConversation(conv.id, {
            verified: true,
            qboCustomerId: found.id,
            customerName: found.name,
            customerEmail: found.email,
            customerCompany: found.company || null,
            stage: "ordering",
          });
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
        conv = storage.updateConversation(conv.id, { pendingImagesJson: JSON.stringify(merged) });
        console.log(`[Images] Stored ${mediaUrls.length} image(s) + ${pdfUrls.length} PDF(s) — total pending: ${merged.length}`);
      }

      // Save inbound message — always preserve the original text/link.
      // Only replace body with image note when it's a pure MMS with no text.
      const bodyWithMedia = (numMedia > 0 && !cleanBody)
        ? `[📷 ${numMedia} image(s) attached]`
        : cleanBody; // original URL/text always shown as-is
      storage.addMessage({
        conversationId: conv.id,
        direction: "inbound",
        body: bodyWithMedia,
      });

      // ── Shortcut: END / DONE — customer explicitly closes the conversation ───
      const CLOSE_KEYWORDS = /^(done|bye|goodbye|end|close|that'?s? all|no more|nothing else|we'?re? good|all good|thank you that'?s? all|thanks that'?s? all|that will (be )?all)[\.!]?$/i;
      if (CLOSE_KEYWORDS.test(cleanBody.trim())) {
        storage.updateConversation(conv.id, { status: "completed" });
        const closeMsg = `You're all set! Text us anytime if you need anything else. — Rebar Concrete Products (469) 631-7730`;
        storage.addMessage({ conversationId: conv.id, direction: "outbound", body: closeMsg });
        try { await sendSms(cleanPhone, closeMsg); } catch {}
        return;
      }

      // ── Shortcut: LOOKS GOOD — customer confirms invoice, send payment link ───
      if (conv.stage === "invoice_review") {
        const LOOKS_GOOD = /^(looks? good|confirmed?|correct|yes|yep|yeah|ok|okay|approve[d]?|good|perfect|that'?s? (correct|right|good))[\.!]?$/i;
        const CORRECTION = /^(correction|wrong|no|change|fix|incorrect|mistake|error)s?[\.!]?$/i;

        if (LOOKS_GOOD.test(cleanBody.trim())) {
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

          storage.updateConversation(conv.id, { stage: "invoiced", status: "completed", pendingImagesJson: null });

          const dLine = deliveryFee > 0 ? `\nDelivery: $${deliveryFee.toFixed(2)}` : "";
          const payMsg = paymentLink
            ? `Great! Here is your payment link for Invoice #${invoiceNumber}:\n\n${paymentLink}\n\nSubtotal: $${subtotal.toFixed(2)}\nTax (8.25%): $${taxAmount.toFixed(2)}${dLine}\nTotal: $${total.toFixed(2)}\n\nWe'll also email the invoice to ${conv.customerEmail}. Thank you!`
            : `Thank you for confirming! Invoice #${invoiceNumber} has been emailed to ${conv.customerEmail}. Total: $${total.toFixed(2)}. Call us at 469-631-7730 with any questions.`;

          storage.addMessage({ conversationId: conv.id, direction: "outbound", body: payMsg });
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
          storage.updateConversation(conv.id, { stage: "ordering" });
          storage.addMessage({ conversationId: conv.id, direction: "outbound", body: corrMsg });
          try { await sendSms(cleanPhone, corrMsg); } catch {}
          return;
        }
      }

      // ── Shortcut: APPROVE keyword from customer ────────────────────────────
      if (conv.stage === "estimating" && cleanBody.trim().toUpperCase() === "APPROVE") {
        const est = storage.getEstimateByConversation(conv.id);
        if (est && est.status !== "approved") {
          await handleEstimateApproval(est.id, conv.id, cleanPhone, est.qboEstimateNumber || "Estimate");
        } else {
          const noEst = "No pending estimate found. Call us at 469-631-7730 if you have questions.";
          storage.addMessage({ conversationId: conv.id, direction: "outbound", body: noEst });
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
      // Only run if not already mid-estimate or invoiced — prevents re-running on follow-up messages
      if ((mediaUrls.length >= 3 || pdfUrls.length >= 1) && conv.verified && conv.stage !== "takeoff_pending" && conv.stage !== "estimating" && conv.stage !== "invoice_review" && conv.stage !== "invoiced") {
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
          const remind = `Still waiting on your plan set. Please share a Dropbox or Google Drive link and I'll start the takeoff right away. Attaching a PDF file directly over text may not come through.`;
          storage.addMessage({ conversationId: conv.id, direction: "outbound", body: remind });
          await sendSms(cleanPhone, remind);
          return;
        }
      }

      // Handle the message with AI (pass image URLs if any)
      const intent = await processMessage(conv, cleanBody, mediaUrls);

      // ── Handle delivery fee calculation ───────────────────────────────────────
      if (intent.type === "calc_delivery") {
        const distResult = await calcDeliveryFee(intent.address);
        let followUp: string;
        if (distResult) {
          // Encode miles + fee into the address field for retrieval at invoice time
          storage.updateConversation(conv.id, {
            deliveryAddress: `${intent.address}||MILES:${distResult.miles}||FEE:${distResult.fee}`,
          });

          // Determine if this order will qualify for free delivery
          // (We don't know the subtotal yet, so give them the conditional rule)
          const FREE_DELIVERY_MILES = 30;
          const FREE_DELIVERY_MIN = 1000;
          if (distResult.miles <= FREE_DELIVERY_MILES) {
            followUp = `${intent.text ? intent.text + " " : ""}Your job site is ${distResult.miles} mi away. Delivery is FREE on orders over $${FREE_DELIVERY_MIN.toLocaleString()} within ${FREE_DELIVERY_MILES} miles. Otherwise the fee is $${distResult.fee.toFixed(2)}. Ready to build your order?`;
          } else {
            followUp = `${intent.text ? intent.text + " " : ""}Your job site is ${distResult.miles} mi away. Delivery fee will be $${distResult.fee.toFixed(2)}. Ready to build your order?`;
          }
        } else {
          storage.updateConversation(conv.id, { deliveryAddress: intent.address });
          followUp = `${intent.text ? intent.text + " " : ""}Got it. Our team will confirm the exact delivery fee on your invoice. Ready to build your order?`;
        }

        storage.addMessage({ conversationId: conv.id, direction: "outbound", body: followUp });
        await sendSms(cleanPhone, followUp);
        return;
      }

      // Save and send the AI reply (skip for lookup_orders — handler sends its own reply)
      const replyText = intent.text;
      if (replyText && intent.type !== "lookup_orders") {
        storage.addMessage({
          conversationId: conv.id,
          direction: "outbound",
          body: replyText,
        });
        await sendSms(cleanPhone, replyText);
      } else if (!replyText && intent.type !== "lookup_orders" && intent.type !== "plan_takeoff") {
        // AI returned no text — send a fallback so the customer isn't left hanging
        const fallback = "Sorry, I wasn't able to process that. Please call us at 469-631-7730 and we'll help you out.";
        storage.addMessage({ conversationId: conv.id, direction: "outbound", body: fallback });
        await sendSms(cleanPhone, fallback);
      }

      // Handle special intents
      if (intent.type === "info_complete") {
        // Extract and save customer info
        const msgs = storage.getMessages(conv.id);
        const info = await extractCustomerInfo(msgs);
        storage.updateConversation(conv.id, {
          customerName: info.name || conv.customerName,
          customerEmail: info.email || conv.customerEmail,
          customerCompany: info.company || conv.customerCompany,
          deliveryAddress: info.deliveryAddress || conv.deliveryAddress,
          stage: "ordering",
        });
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
          storage.updateConversation(conv.id, { stage: "takeoff_pending" });
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
        storage.addMessage({ conversationId: conv.id, direction: "outbound", body: historyReply });
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
          const errConv = storage.getConversationByPhone(cleanPhone);
          if (errConv) storage.addMessage({ conversationId: errConv.id, direction: "outbound", body: techErr });
        } catch {}
        await sendSms(cleanPhone, techErr);
      } catch (_) {}
    }
  });

  // ── Order Confirmation Handler ──────────────────────────────────────────────
  async function handleOrderConfirmation(conversationId: number, phone: string) {
    const conv = storage.getConversation(conversationId);
    if (!conv) return;
    // Guard: prevent duplicate invoice creation if already processing or done
    if (conv.stage === "invoice_review" || conv.stage === "invoiced") {
      console.log(`[Order] Skipping handleOrderConfirmation — already in stage: ${conv.stage}`);
      return;
    }
    if (orderConfirmationInProgress.has(conversationId)) {
      console.log(`[Order] Skipping — order confirmation already in progress for conv ${conversationId}`);
      return;
    }
    orderConfirmationInProgress.add(conversationId);
    try {

    const msgs = storage.getMessages(conversationId);
    const products = storage.getAllProducts().filter(p => p.unitPrice !== null).slice(0, 80);

    try {
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
      const validItems = orderData.lineItems.filter((item: any) => {
        const id = String(item.qboItemId || "");
        if (!id || id === "null" || id === "" || !/^\d+$/.test(id)) return false;
        if (id === DELIVERY_FEE_QBO_ID) {
          console.log("[Order] Stripped AI-added delivery fee line item (handled separately)");
          return false;
        }
        return true;
      });
      // Recompute amount from qty × unitPrice to avoid floating-point mismatch QBO rejects
      validItems.forEach((item: any) => {
        item.amount = Math.round(item.qty * item.unitPrice * 100) / 100;
      });
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

      // Calculate totals — apply free delivery rule: $1,000+ order within 30 miles = free
      const FREE_DELIVERY_MILES = 30;
      const FREE_DELIVERY_MIN_ORDER = 1000;
      const subtotal = orderData.lineItems.reduce((sum, item) => sum + item.amount, 0);

      const qualifiesFreeDelivery =
        orderData.deliveryType === "delivery" &&
        deliveryMiles !== undefined &&
        deliveryMiles <= FREE_DELIVERY_MILES &&
        subtotal >= FREE_DELIVERY_MIN_ORDER;

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
        storage.updateConversation(conversationId, { qboCustomerId, stage: "invoiced" });
      }

      // Create invoice in QBO
      let invoiceId = "";
      let invoiceNumber = "";
      let paymentLink: string | null = null;

      if (qboCustomerId && isQboConfigured()) {
        const qboInvoiceItems = (orderData.lineItems as LineItem[]).filter(i => i.qboItemId !== "CUSTOM");
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
          customerMemo: [
            cleanDeliveryAddress ? `Ship to: ${cleanDeliveryAddress}` : null,
            orderData.notes || null,
          ].filter(Boolean).join(" | ") + customInvoiceNote || undefined,
        });
        invoiceId = invoice.invoiceId;
        invoiceNumber = invoice.invoiceNumber;
        paymentLink = invoice.paymentLink;
      }

      // Save order to DB
      storage.createOrder({
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
        .map(i => `  • ${i.qty > 1 ? i.qty + "x " : ""}${i.name}: $${i.amount.toFixed(2)}`)
        .join("\n");

      const reviewMsg = [
        `Invoice #${invoiceNumber} is ready.${freeDeliveryNote}`,
        ``,
        itemLines,
        ``,
        `Subtotal: $${subtotal.toFixed(2)}`,
        `Tax (8.25%): $${taxAmount.toFixed(2)}`,
        deliveryFee > 0 ? `Delivery: $${deliveryFee.toFixed(2)}` : null,
        `Total: $${total.toFixed(2)}`,
        ``,
        `Reply LOOKS GOOD to receive your payment link, or CORRECTION if anything needs to be changed.`,
      ].filter(l => l !== null).join("\n");

      // Store payment link in conversation for retrieval after customer confirms
      storage.updateConversation(conversationId, {
        stage: "invoice_review",
        pendingImagesJson: JSON.stringify({ __paymentLink: paymentLink, __invoiceNumber: invoiceNumber, __total: total, __taxAmount: taxAmount, __subtotal: subtotal, __deliveryFee: deliveryFee }),
      });

      try { await sendSms(phone, reviewMsg); } catch (e: any) {
        console.error(`[SMS] Failed to send invoice review: ${e?.message}`);
      }

    } catch (err) {
      console.error("[Order] Failed to create invoice:", err);
      const orderErrMsg = `We had trouble creating your invoice. Please try again in a moment or call us at 469-631-7730 and we'll get it sorted out.`;
      storage.addMessage({ conversationId, direction: "outbound", body: orderErrMsg });
      try { await sendSms(phone, orderErrMsg); } catch {}
    }
    } finally {
      orderConfirmationInProgress.delete(conversationId);
    }
  }

  // ── Plan Takeoff Handler ──────────────────────────────────────────────────
  // planSourceUrl: raw Dropbox/Drive URL from the customer's message, forwarded to sonar-pro when available.
  async function handlePlanTakeoff(conversationId: number, phone: string, imageUrls: string[], planSourceUrl?: string) {
    const conv = storage.getConversation(conversationId);
    if (!conv) return;

    const ackMsg = `Got it! I'm analyzing your plan set now. This takes about 30–60 seconds — I'll send your estimate as soon as it's ready.`;
    storage.addMessage({ conversationId, direction: "outbound", body: ackMsg });
    await sendSms(phone, ackMsg);

    const products = storage.getAllProducts();

    try {
      const takeoffResult = await performTakeoff(imageUrls, products, planSourceUrl);

      if (!takeoffResult.lineItems || takeoffResult.lineItems.length === 0) {
        const hasPdf = imageUrls.some(u => u.startsWith("pdf::"));
        const errMsg = hasPdf
          ? `I wasn't able to read enough detail from that PDF to build an estimate. For best results, share a Dropbox or Google Drive link instead of attaching the file directly — larger plan sets come through much clearer that way. Or call us at 469-631-7730 and we'll quote it manually.`
          : `I couldn't extract materials from those images. Make sure all pages are clear and in focus. Try resending or call us at 469-631-7730 for a manual quote.`;
        console.error(`[Takeoff] Zero line items — imageUrls: ${JSON.stringify(imageUrls.map(u => u.substring(0,80)))}`);
        storage.addMessage({ conversationId, direction: "outbound", body: errMsg });
        await sendSms(phone, errMsg);
        storage.updateConversation(conversationId, { stage: "ordering" });
        return;
      }

      const subtotal = takeoffResult.lineItems.reduce((s, i) => s + i.amount, 0);

      let qboCustomerId = conv.qboCustomerId;
      if (!qboCustomerId && conv.customerEmail && conv.customerName) {
        qboCustomerId = await findOrCreateCustomer({
          name: conv.customerName!,
          email: conv.customerEmail!,
          phone: conv.phone,
          company: conv.customerCompany || undefined,
        });
        storage.updateConversation(conversationId, { qboCustomerId });
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
        const est = await createEstimate({
          customerId: qboCustomerId,
          customerEmail: conv.customerEmail!,
          lineItems: qboLineItems as LineItem[],
          customerMemo: `Plan takeoff — ${takeoffResult.projectName}. Auto-generated by RCP SMS Bot.${customNote}`,
        });
        estimateId = est.estimateId;
        estimateNumber = est.estimateNumber;
        estimateLink = est.estimateLink;
      }

      const savedEstimate = storage.createEstimate({
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

      const items = takeoffResult.lineItems;
      // Split into priced items (amount > 0) and unpriced (qty/length TBD)
      const pricedItems = items.filter(i => i.amount > 0);
      const unpricedItems = items.filter(i => i.amount === 0);

      // If nothing could be priced, tell customer and ask them to call
      if (pricedItems.length === 0) {
        const noPrice = `We were able to identify the materials in your plan set but couldn't determine quantities automatically. Please call us at 469-631-7730 and we'll put together a manual quote for you.\n\nItems identified:\n${unpricedItems.map(i => `- ${i.name}`).join("\n")}`;
        storage.addMessage({ conversationId, direction: "outbound", body: noPrice });
        await sendSms(phone, noPrice);
        storage.updateConversation(conversationId, { stage: "ordering" });
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

      let replyText: string;
      if (estimateLink) {
        replyText = `Takeoff complete for ${takeoffResult.projectName}!\n\n${top5}${moreCount}${fabNote}${tbdNote}\n\nSubtotal: $${subtotal.toFixed(2)}${taxLine}\n\nView & approve your estimate:\n${estimateLink}\n\nOnce you approve, we\'ll process your fabrication order.`;
      } else if (estimateNumber) {
        replyText = `Takeoff complete for ${takeoffResult.projectName}!\n\n${top5}${moreCount}${fabNote}${tbdNote}\n\nSubtotal: $${subtotal.toFixed(2)}${taxLine}\n\nEstimate #${estimateNumber} emailed to ${conv.customerEmail}. Reply APPROVE to confirm.`;
      } else {
        replyText = `Takeoff complete for ${takeoffResult.projectName}!\n\n${top5}${moreCount}${fabNote}${tbdNote}\n\nSubtotal: $${subtotal.toFixed(2)}${taxLine}\n\nReply APPROVE to confirm this estimate, or call 469-631-7730 with questions.`;
      }

      storage.addMessage({ conversationId, direction: "outbound", body: replyText });
      await sendSms(phone, replyText);
      storage.updateConversation(conversationId, { stage: "estimating" });

      if (estimateId) {
        pollEstimateApproval(savedEstimate.id, estimateId, conversationId, phone, takeoffResult.projectName);
      }

    } catch (err) {
      console.error("[Takeoff] Error:", err);
      const errMsg = `Something went wrong while reading your plan set. Please call us at 469-631-7730 and we\'ll get you a quote right away — usually within the hour.`;
      storage.addMessage({ conversationId, direction: "outbound", body: errMsg });
      await sendSms(phone, errMsg);
      storage.updateConversation(conversationId, { stage: "ordering" });
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
          storage.updateEstimate(estimateDbId, { status: "declined" });
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
    const conv = storage.getConversation(conversationId);
    const est = storage.getEstimate(estimateDbId);
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
          storage.addMessage({ conversationId, direction: "outbound", body: convErrMsg });
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

      storage.updateEstimate(estimateDbId, {
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

      storage.addMessage({ conversationId, direction: "outbound", body: confirmMsg });
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

      storage.updateConversation(conversationId, { stage: "invoiced", status: "completed" });
    } catch (err) {
      console.error("[Estimate] Approval handler failed:", err);
      try {
        const errMsg = "There was an issue processing your approval. Please call us at 469-631-7730 and we'll take care of you.";
        storage.addMessage({ conversationId, direction: "outbound", body: errMsg });
        await sendSms(phone, errMsg);
      } catch (_) {}
    }
  }

  // ── Serve temp files (MMS PDFs downloaded from Twilio) ─────────────────────
  app.get("/api/tmp/:filename", (req, res) => {
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
  app.get("/api/conversations", (_req, res) => {
    const convs = storage.getAllConversations();
    res.json(convs);
  });

  // Get single conversation
  app.get("/api/conversations/:id", (req, res) => {
    const id = parseInt(req.params.id);
    const conv = storage.getConversation(id);
    if (!conv) return res.status(404).json({ error: "Not found" });
    const msgs = storage.getMessages(id);
    const orders = storage.getOrderByConversation(id);
    res.json({ ...conv, messages: msgs, order: orders });
  });

  // Send manual reply from dashboard
  app.post("/api/conversations/:id/reply", async (req, res) => {
    const id = parseInt(req.params.id);
    const conv = storage.getConversation(id);
    if (!conv) return res.status(404).json({ error: "Not found" });

    const { message } = req.body;
    if (!message) return res.status(400).json({ error: "message required" });

    await sendSms(conv.phone, message);
    storage.addMessage({ conversationId: id, direction: "outbound", body: message });
    res.json({ ok: true });
  });

  // Get all orders (enriched with customer name + phone from conversation)
  app.get("/api/orders", (_req, res) => {
    const allOrders = storage.getAllOrders();
    const enriched = allOrders.map(order => {
      const conv = storage.getConversation(order.conversationId);
      return {
        ...order,
        customerName: conv?.customerName ?? null,
        customerPhone: conv?.phone ?? null,
      };
    });
    res.json(enriched);
  });

  // Get all estimates
  app.get("/api/estimates", (_req, res) => {
    const allEstimates = storage.getAllEstimates();
    const enriched = allEstimates.map(est => {
      const conv = storage.getConversation(est.conversationId);
      return {
        ...est,
        customerName: conv?.customerName ?? null,
        customerPhone: conv?.phone ?? null,
        customerEmail: conv?.customerEmail ?? null,
      };
    });
    res.json(enriched);
  });

  // Manually approve an estimate (admin action)
  app.post("/api/estimates/:id/approve", async (req, res) => {
    const id = parseInt(req.params.id);
    const est = storage.getEstimate(id);
    if (!est) return res.status(404).json({ error: "Not found" });
    const conv = storage.getConversation(est.conversationId);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });
    try {
      await handleEstimateApproval(id, est.conversationId, conv.phone, est.qboEstimateNumber || "Estimate");
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get all products (from QBO cache)
  app.get("/api/products", (_req, res) => {
    res.json(storage.getAllProducts());
  });

  // Manually trigger a QBO product sync
  app.post("/api/products/sync", async (_req, res) => {
    try {
      await syncProducts();
      res.json({ ok: true, count: storage.getAllProducts().length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Setup status (used by Setup page)
  app.get("/api/setup/status", (_req, res) => {
    const products = storage.getAllProducts();
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
  app.get("/api/status", (_req, res) => {
    res.json({
      twilio: isTwilioConfigured(),
      qbo: isQboConfigured(),
      openai: isAiConfigured(),
      products: storage.getAllProducts().length,
      conversations: storage.getAllConversations().length,
    });
  });

  // ── QBO OAuth Flow (one-time setup) ─────────────────────────────────────────
  app.get("/api/qbo/connect", (_req, res) => {
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
  app.post("/api/voice/inbound", (req, res) => {
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
  app.post("/api/voice/menu", (req, res) => {
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
  app.post("/api/voice/no-answer", (req, res) => {
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
          console.log('[QBO] Saving refresh token to SQLite:', tokens.refresh_token.substring(0, 20));
          storage.setSetting("qbo_refresh_token", tokens.refresh_token);
          const verify = storage.getSetting("qbo_refresh_token");
          console.log('[QBO] SQLite verify after save — stored token prefix:', verify ? verify.substring(0, 20) : '(null)');
        } catch (dbErr: any) {
          console.error('[QBO] FAILED to persist refresh token to SQLite:', dbErr?.message, dbErr?.stack);
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
          console.log('[QBO] Saving refresh token to SQLite:', tokens.refresh_token.substring(0, 20));
          storage.setSetting("qbo_refresh_token", tokens.refresh_token);
          const verify = storage.getSetting("qbo_refresh_token");
          console.log('[QBO] SQLite verify after save — stored token prefix:', verify ? verify.substring(0, 20) : '(null)');
        } catch (dbErr: any) {
          console.error('[QBO] FAILED to persist refresh token to SQLite:', dbErr?.message, dbErr?.stack);
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
}
