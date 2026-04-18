import type { Express } from "express";
import type { Server } from "http";
import express from "express";
import { storage } from "./storage";
import { sendSms, isTwilioConfigured } from "./sms";
import { processMessage, extractOrderFromConversation, extractCustomerInfo, isAiConfigured } from "./ai";
import { syncProducts, findOrCreateCustomer, createInvoice, createEstimate, getEstimateStatus, lookupCustomerByPhone, calcDeliveryFee, isQboConfigured } from "./qbo";
import { performTakeoff } from "./takeoff";
import { generateCutSheetPdf, emailCutSheet } from "./cutsheet";
import type { LineItem } from "@shared/schema";

const OWNER_EMAIL = "maddoxconstruction1987@gmail.com";

// Sync QBO products on startup, then every 30 minutes
async function startProductSync() {
  if (isQboConfigured()) {
    await syncProducts().catch(console.error);
    setInterval(() => syncProducts().catch(console.error), 30 * 60 * 1000);
  }
}

export function registerRoutes(httpServer: Server, app: Express) {
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

    // Collect any MMS image URLs Twilio sends (MediaUrl0, MediaUrl1, ...)
    const mediaUrls: string[] = [];
    const numMedia = parseInt(NumMedia || "0", 10);
    for (let i = 0; i < numMedia; i++) {
      const url = req.body[`MediaUrl${i}`];
      const type = (req.body[`MediaContentType${i}`] || "").toLowerCase();
      if (url && type.startsWith("image/")) mediaUrls.push(url);
    }

    // Require at least a body or an image
    if (!cleanBody && mediaUrls.length === 0) return;

    try {
      // Get or create conversation
      let conv = storage.getOrCreateConversation(cleanPhone);

      // ── FRAUD GATE: existing customers only ──────────────────────────────────
      // On the very first message (greeting stage, not yet verified),
      // attempt auto-verification by matching the inbound phone against QBO.
      if (conv.stage === "greeting" && !conv.verified && isQboConfigured()) {
        const found = await lookupCustomerByPhone(cleanPhone);
        if (found) {
          // Auto-verified — pre-fill their info from QBO
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
          // Phone not in QBO — mark unverified, AI will handle the messaging
          console.log(`[Verify] ${cleanPhone} not found in QBO customer list`);
        }
      }

      // Save inbound message (append image note if MMS)
      const bodyWithMedia = mediaUrls.length > 0
        ? (cleanBody ? `${cleanBody} [📷 ${mediaUrls.length} image(s) attached]` : `[📷 ${mediaUrls.length} image(s) attached]`)
        : cleanBody;
      storage.addMessage({
        conversationId: conv.id,
        direction: "inbound",
        body: bodyWithMedia,
      });

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

      // ── Auto-detect plan set: 3+ images sent at once → run takeoff ──────────
      if (mediaUrls.length >= 3 && conv.verified && conv.stage !== "takeoff_pending") {
        await handlePlanTakeoff(conv.id, cleanPhone, mediaUrls);
        return;
      }

      // ── If stage is takeoff_pending and images arrived, run the takeoff ─────
      if (conv.stage === "takeoff_pending" && mediaUrls.length >= 1) {
        await handlePlanTakeoff(conv.id, cleanPhone, mediaUrls);
        return;
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

      // Save and send the AI reply
      const replyText = intent.text;
      if (replyText) {
        storage.addMessage({
          conversationId: conv.id,
          direction: "outbound",
          body: replyText,
        });
        await sendSms(cleanPhone, replyText);
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
        // If they already sent images this message, run takeoff immediately
        // Otherwise store stage and wait for images
        if (mediaUrls.length >= 1) {
          // Images arrived with the takeoff trigger — run it now
          await handlePlanTakeoff(conv.id, cleanPhone, mediaUrls);
        } else {
          // No images yet — AI already asked them to send pages; update stage
          storage.updateConversation(conv.id, { stage: "takeoff_pending" });
        }
      }

      // If stage is takeoff_pending and images arrived, run the takeoff
      if (conv.stage === "takeoff_pending" && mediaUrls.length >= 1 && intent.type === "message") {
        await handlePlanTakeoff(conv.id, cleanPhone, mediaUrls);
      }

    } catch (err) {
      console.error("[SMS] Error processing message:", err);
      try {
        await sendSms(cleanPhone, "Sorry, we hit a technical issue. Please call us at 469-631-7730 or try again in a moment.");
      } catch (_) {}
    }
  });

  // ── Order Confirmation Handler ──────────────────────────────────────────────
  async function handleOrderConfirmation(conversationId: number, phone: string) {
    const conv = storage.getConversation(conversationId);
    if (!conv) return;

    const msgs = storage.getMessages(conversationId);
    const products = storage.getAllProducts();

    try {
      // Extract order details
      const orderData = await extractOrderFromConversation(msgs, products);

      if (!orderData.lineItems || orderData.lineItems.length === 0) {
        await sendSms(phone, "I couldn't find any items in your order. Could you tell me what you'd like to order?");
        return;
      }

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

      const total = subtotal + deliveryFee;

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
        const invoice = await createInvoice({
          customerId: qboCustomerId,
          customerEmail: conv.customerEmail!,
          lineItems: orderData.lineItems as LineItem[],
          deliveryFee: deliveryFee > 0 ? deliveryFee : undefined,
          deliveryMiles,
          deliveryAddress: cleanDeliveryAddress || undefined,
          customerMemo: orderData.notes,
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
        total,
        deliveryType: orderData.deliveryType,
        status: invoiceId ? "invoiced" : "pending",
      });

      // Format and send confirmation
      const itemList = orderData.lineItems
        .map(i => `${i.qty}x ${i.name} = $${i.amount.toFixed(2)}`)
        .join(", ");

      const freeDeliveryNote = qualifiesFreeDelivery ? " Free delivery applied!" : "";

      if (paymentLink) {
        await sendSms(
          phone,
          `Invoice #${invoiceNumber} created!${freeDeliveryNote} Total: $${total.toFixed(2)}\n\nPay here: ${paymentLink}\n\nWe'll also email the invoice to ${conv.customerEmail}.`
        );
      } else if (invoiceId) {
        await sendSms(
          phone,
          `Invoice #${invoiceNumber} created for $${total.toFixed(2)}.${freeDeliveryNote} We emailed it to ${conv.customerEmail} with the payment link. Thank you!`
        );
      } else {
        await sendSms(
          phone,
          `Order confirmed.${freeDeliveryNote} Total: $${total.toFixed(2)}. Our team will follow up shortly with your invoice. Thank you!`
        );
      }

      storage.updateConversation(conversationId, { status: "completed", stage: "invoiced" });

    } catch (err) {
      console.error("[Order] Failed to create invoice:", err);
      await sendSms(
        phone,
        `Your order is confirmed! Our team is processing it now and will send your invoice shortly. Questions? Call 469-631-7730.`
      );
    }
  }

  // ── Plan Takeoff Handler ──────────────────────────────────────────────────
  async function handlePlanTakeoff(conversationId: number, phone: string, imageUrls: string[]) {
    const conv = storage.getConversation(conversationId);
    if (!conv) return;

    const ackMsg = `Got it! I'm analyzing your plan set now. This takes about 30 seconds — I'll send your estimate as soon as it's ready.`;
    storage.addMessage({ conversationId, direction: "outbound", body: ackMsg });
    await sendSms(phone, ackMsg);

    const products = storage.getAllProducts();

    try {
      const takeoffResult = await performTakeoff(imageUrls, products);

      if (!takeoffResult.lineItems || takeoffResult.lineItems.length === 0) {
        const errMsg = `I couldn't extract materials from those images. Make sure all pages are clear and in focus. Try resending or call us at 469-631-7730 for a manual quote.`;
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
        const est = await createEstimate({
          customerId: qboCustomerId,
          customerEmail: conv.customerEmail!,
          lineItems: takeoffResult.lineItems as LineItem[],
          customerMemo: `Plan takeoff — ${takeoffResult.projectName}. Auto-generated by RCP SMS Bot.`,
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
      const top5 = items.slice(0, 5).map(i => `${i.qty > 1 ? i.qty + "x " : ""}${i.name}: $${i.amount.toFixed(2)}`).join("\n");
      const moreCount = items.length > 5 ? `\n+ ${items.length - 5} more items` : "";
      const fabCount = takeoffResult.fabItems.filter(f => !f.bendDescription.includes("stock length")).length;
      const fabNote = fabCount > 0 ? `\n${fabCount} custom fab item(s) @ $0.75/lb included.` : "";

      let replyText: string;
      if (estimateLink) {
        replyText = `Takeoff complete for ${takeoffResult.projectName}!\n\n${top5}${moreCount}${fabNote}\n\nSubtotal: $${subtotal.toFixed(2)}\n\nView & approve your estimate:\n${estimateLink}\n\nOnce you approve, we\'ll process your fabrication order.`;
      } else if (estimateNumber) {
        replyText = `Takeoff complete for ${takeoffResult.projectName}!\n\n${top5}${moreCount}${fabNote}\n\nSubtotal: $${subtotal.toFixed(2)}\n\nEstimate #${estimateNumber} emailed to ${conv.customerEmail}. Reply APPROVE to confirm.`;
      } else {
        replyText = `Takeoff complete for ${takeoffResult.projectName}!\n\n${top5}${moreCount}${fabNote}\n\nSubtotal: $${subtotal.toFixed(2)}\n\nReply APPROVE to confirm this estimate, or call 469-631-7730 with questions.`;
      }

      storage.addMessage({ conversationId, direction: "outbound", body: replyText });
      await sendSms(phone, replyText);
      storage.updateConversation(conversationId, { stage: "estimating" });

      if (estimateId) {
        pollEstimateApproval(savedEstimate.id, estimateId, conversationId, phone, takeoffResult.projectName);
      }

    } catch (err) {
      console.error("[Takeoff] Error:", err);
      const errMsg = `Something went wrong processing your plans. Please call us at 469-631-7730 and we\'ll get you a quote right away.`;
      storage.addMessage({ conversationId, direction: "outbound", body: errMsg });
      await sendSms(phone, errMsg);
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

  // ── Handle approved estimate: generate + email cut sheet ────────────────────
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

      const pdfPath = generateCutSheetPdf({
        projectName,
        customerName,
        estimateNumber,
        fabItems,
      });

      const emailed = await emailCutSheet({
        pdfPath,
        projectName,
        customerName,
        estimateNumber,
        ownerEmail: OWNER_EMAIL,
      });

      storage.updateEstimate(estimateDbId, {
        status: "approved",
        cutSheetEmailedAt: emailed ? new Date() : undefined,
      });

      const confirmMsg = `Your estimate has been approved! Our team has your fabrication cut sheet and will begin processing your order shortly. Thank you for choosing Rebar Concrete Products!`;
      storage.addMessage({ conversationId, direction: "outbound", body: confirmMsg });
      await sendSms(phone, confirmMsg);
      storage.updateConversation(conversationId, { stage: "invoiced", status: "completed" });
    } catch (err) {
      console.error("[Estimate] Approval handler failed:", err);
    }
  }

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
        redirect_uri: `${process.env.APP_URL || "http://localhost:5000"}/api/qbo/callback`,
        response_type: "code",
        scope: "com.intuit.quickbooks.accounting",
        state: Math.random().toString(36).slice(2),
      });
      const authUrl = `https://appcenter.intuit.com/connect/oauth2?${params.toString()}`;
      res.redirect(authUrl);
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

    app.get("/api/qbo/callback", async (req, res) => {
    const { code, realmId } = req.query as Record<string, string>;
    if (!code || !realmId) return res.status(400).send("Missing code or realmId");

    const clientId = process.env.QBO_CLIENT_ID!;
    const clientSecret = process.env.QBO_CLIENT_SECRET!;
    const redirectUri = `${process.env.APP_URL || "http://localhost:5000"}/api/qbo/callback`;

    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const tokenRes = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    });

    const tokens = await tokenRes.json();
    res.send(`
      <h2>QuickBooks Connected!</h2>
      <p>Add these to your .env file:</p>
      <pre>
QBO_REALM_ID=${realmId}
QBO_REFRESH_TOKEN=${tokens.refresh_token}
      </pre>
      <p>Then restart the server.</p>
    `);
  });
}
