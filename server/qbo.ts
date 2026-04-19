/**
 * QuickBooks Online integration
 * Uses the Intuit OAuth2 + v3 REST API directly
 */
import { storage } from "./storage";
import type { LineItem } from "@shared/schema";

const QB_BASE = "https://quickbooks.api.intuit.com/v3/company";
const DISCOVERY_URL = "https://developer.api.intuit.com/.well-known/openid_configuration";

let _accessToken: string | null = null;
let _tokenExpiry: number = 0;

function cfg() {
  return {
    clientId: process.env.QBO_CLIENT_ID!,
    clientSecret: process.env.QBO_CLIENT_SECRET!,
    refreshToken: process.env.QBO_REFRESH_TOKEN!,
    realmId: process.env.QBO_REALM_ID!,
  };
}

async function getAccessToken(): Promise<string> {
  if (_accessToken && Date.now() < _tokenExpiry - 60_000) return _accessToken;

  const { clientId, clientSecret, refreshToken } = cfg();
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`QBO token refresh failed: ${err}`);
  }

  const data = await res.json();
  _accessToken = data.access_token;
  _tokenExpiry = Date.now() + data.expires_in * 1000;

  // Persist the new refresh token if rotated
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    process.env.QBO_REFRESH_TOKEN = data.refresh_token;
    console.log("[QBO] Refresh token rotated — update QBO_REFRESH_TOKEN in your .env");
  }

  return _accessToken!;
}

async function qboGet(path: string) {
  const { realmId } = cfg();
  const token = await getAccessToken();
  const res = await fetch(`${QB_BASE}/${realmId}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`QBO GET ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

async function qboPost(path: string, body: object) {
  const { realmId } = cfg();
  const token = await getAccessToken();
  const res = await fetch(`${QB_BASE}/${realmId}${path}?minorversion=75`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`QBO POST ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

// Post with automatic DocNumber retry on duplicate (QBO error code 6140)
async function qboPostWithDocRetry(path: string, body: Record<string, any>): Promise<any> {
  const MAX_RETRIES = 20;
  let attempt = 0;
  let currentDoc: string = body.DocNumber || "";

  while (attempt < MAX_RETRIES) {
    try {
      return await qboPost(path, { ...body, ...(currentDoc ? { DocNumber: currentDoc } : {}) });
    } catch (err: any) {
      const isDupe = err?.message?.includes("6140") || err?.message?.includes("Duplicate Document Number");
      if (isDupe && currentDoc) {
        // Increment the DocNumber and retry
        const match = currentDoc.match(/(\d+)$/);
        if (match) {
          const next = parseInt(match[1], 10) + 1;
          const prefix = currentDoc.slice(0, currentDoc.length - match[1].length);
          currentDoc = `${prefix}${next}`;
          console.warn(`[QBO] Duplicate DocNumber, retrying with ${currentDoc}`);
          attempt++;
          continue;
        }
      }
      throw err;
    }
  }
  throw new Error(`[QBO] Could not find unique DocNumber after ${MAX_RETRIES} retries`);
}

// ── Sync products/services from QBO ──────────────────────────────────────────
export async function syncProducts(): Promise<void> {
  try {
    const data = await qboGet(
      "/query?query=SELECT%20*%20FROM%20Item%20WHERE%20Active%3Dtrue%20MAXRESULTS%20500"
    );
    const items = data.QueryResponse?.Item || [];
    for (const item of items) {
      if (item.Type === "Service" || item.Type === "Inventory" || item.Type === "NonInventory") {
        storage.upsertProduct({
          qboItemId: item.Id,
          name: item.Name,
          description: item.Description || null,
          unitPrice: item.UnitPrice || null,
          unitOfMeasure: item.PurchaseTaxIncluded ? "each" : null,
          active: item.Active !== false,
          syncedAt: new Date(),
        });
      }
    }
    console.log(`[QBO] Synced ${items.length} products`);
  } catch (err) {
    console.error("[QBO] Product sync failed:", err);
  }
}

// ── Look up existing QBO customer by phone (for fraud gate) ─────────────────
export async function lookupCustomerByPhone(phone: string): Promise<{
  id: string;
  name: string;
  email: string;
  company?: string;
} | null> {
  try {
    // Normalize: strip everything except digits, take last 10
    const digits = phone.replace(/\D/g, "").slice(-10);
    if (digits.length < 7) return null;

    // QBO stores phone in various formats — search by partial match using LIKE
    const partial = digits.slice(-7); // last 7 digits are unique enough
    const encoded = encodeURIComponent(`SELECT * FROM Customer WHERE Active = true MAXRESULTS 500`);
    const data = await qboGet(`/query?query=${encoded}`);
    const customers = data.QueryResponse?.Customer || [];

    for (const c of customers) {
      const raw = (c.PrimaryPhone?.FreeFormNumber || c.Mobile?.FreeFormNumber || "").replace(/\D/g, "");
      if (raw.endsWith(digits) || raw.endsWith(partial)) {
        return {
          id: c.Id,
          name: c.DisplayName || c.FullyQualifiedName || "",
          email: c.PrimaryEmailAddr?.Address || "",
          company: c.CompanyName || undefined,
        };
      }
    }
    return null;
  } catch (err) {
    console.error("[QBO] lookupCustomerByPhone failed:", err);
    return null;
  }
}

// ── Calculate delivery distance and fee via Google Maps ──────────────────────
// Returns { miles, fee } or null if the address can't be resolved
export async function calcDeliveryFee(destinationAddress: string): Promise<{
  miles: number;
  fee: number;
} | null> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  const origin = encodeURIComponent("2112 N Custer Rd, McKinney, TX 75071");
  const dest = encodeURIComponent(destinationAddress);

  // If no Google Maps key, fall back to a flat estimate
  if (!apiKey) {
    console.warn("[Maps] GOOGLE_MAPS_API_KEY not set — delivery fee will be manual");
    return null;
  }

  try {
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origin}&destinations=${dest}&units=imperial&key=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();

    const element = data.rows?.[0]?.elements?.[0];
    if (!element || element.status !== "OK") return null;

    // Distance in meters → miles
    const meters = element.distance.value;
    const miles = Math.ceil(meters / 1609.34 * 10) / 10; // round up to 1 decimal
    const fee = Math.round(miles * 3 * 100) / 100; // $3/mile, 2 decimal places
    return { miles, fee };
  } catch (err) {
    console.error("[Maps] Distance lookup failed:", err);
    return null;
  }
}

// ── Find or create a QBO customer ────────────────────────────────────────────
export async function findOrCreateCustomer(params: {
  name: string;
  email: string;
  phone: string;
  company?: string;
}): Promise<string> {
  // Search by email first
  try {
    const encoded = encodeURIComponent(`SELECT * FROM Customer WHERE PrimaryEmailAddr = '${params.email}'`);
    const data = await qboGet(`/query?query=${encoded}`);
    const customers = data.QueryResponse?.Customer || [];
    if (customers.length > 0) return customers[0].Id;
  } catch (_) {}

  // Create new customer
  const body: Record<string, any> = {
    DisplayName: params.company ? `${params.name} - ${params.company}` : params.name,
    GivenName: params.name.split(" ")[0],
    FamilyName: params.name.split(" ").slice(1).join(" ") || "",
    PrimaryEmailAddr: { Address: params.email },
    PrimaryPhone: { FreeFormNumber: params.phone },
  };
  if (params.company) body.CompanyName = params.company;

  const data = await qboPost("/customer", body);
  return data.Customer.Id;
}

// ── Create invoice in QBO ─────────────────────────────────────────────────────
export async function createInvoice(params: {
  customerId: string;
  customerEmail: string;
  lineItems: LineItem[];
  deliveryFee?: number;
  deliveryMiles?: number;
  deliveryAddress?: string;
  customerMemo?: string;
}): Promise<{ invoiceId: string; invoiceNumber: string; paymentLink: string | null }> {
  const lines: any[] = params.lineItems.map((item, idx) => ({
    LineNum: idx + 1,
    Amount: item.amount,
    ...(item.description ? { Description: item.description } : {}),
    DetailType: "SalesItemLineDetail",
    SalesItemLineDetail: {
      ItemRef: { value: item.qboItemId, name: item.name },
      Qty: item.qty,
      UnitPrice: item.unitPrice,
    },
  }));

  // Add delivery fee using the QBO "Delivery Fee" product (ID 1010000081)
  if (params.deliveryFee && params.deliveryFee > 0) {
    const milesNote = params.deliveryMiles ? ` (${params.deliveryMiles} mi @ $3/mi)` : "";
    lines.push({
      LineNum: lines.length + 1,
      Amount: params.deliveryFee,
      Description: `Delivery Fee${milesNote}`,
      DetailType: "SalesItemLineDetail",
      SalesItemLineDetail: {
        ItemRef: { value: "1010000081", name: "Delivery Fee" },
        Qty: 1,
        UnitPrice: params.deliveryFee,
      },
    });
  }

  const docNumber = await getNextDocNumber("Invoice");

  const invoiceBody: Record<string, any> = {
    ...(docNumber ? { DocNumber: docNumber } : {}),
    CustomerRef: { value: params.customerId },
    BillEmail: { Address: params.customerEmail },
    EmailStatus: "NeedToSend",
    Line: lines,
    DueDate: new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0],
  };

  if (params.customerMemo) {
    invoiceBody.CustomerMemo = { value: params.customerMemo };
  }
  if (params.deliveryAddress) {
    invoiceBody.ShipAddr = { Line1: params.deliveryAddress };
  }

  const data = await qboPostWithDocRetry("/invoice", invoiceBody);
  const invoice = data.Invoice;

  // Get the InvoiceLink (QBO Payments pay link)
  let paymentLink: string | null = null;
  try {
    const linkData = await qboGet(`/invoice/${invoice.Id}/onlineinvoice`);
    console.log("[QBO] onlineinvoice response:", JSON.stringify(linkData));
    paymentLink = linkData?.InvoiceLink || null;
  } catch (err) {
    console.warn("[QBO] Could not get payment link:", err);
  }

  // Fallback: build a direct QBO invoice view link
  if (!paymentLink) {
    const { realmId } = cfg();
    paymentLink = `https://app.qbo.intuit.com/app/invoice?txnId=${invoice.Id}`;
    console.log("[QBO] Using fallback invoice link:", paymentLink);
  }

  return {
    invoiceId: invoice.Id,
    invoiceNumber: invoice.DocNumber,
    paymentLink,
  };
}

// ── Create estimate in QBO ───────────────────────────────────────────────────
export async function createEstimate(params: {
  customerId: string;
  customerEmail: string;
  lineItems: import("@shared/schema").LineItem[];
  customerMemo?: string;
  deliveryAddress?: string;
}): Promise<{ estimateId: string; estimateNumber: string; estimateLink: string | null }> {
  const lines: any[] = params.lineItems.map((item, idx) => ({
    LineNum: idx + 1,
    Amount: item.amount,
    ...(item.description ? { Description: item.description } : {}),
    DetailType: "SalesItemLineDetail",
    SalesItemLineDetail: {
      ItemRef: { value: item.qboItemId, name: item.name },
      Qty: item.qty,
      UnitPrice: item.unitPrice,
    },
  }));

  const docNumber = await getNextDocNumber("Estimate");

  const estimateBody: Record<string, any> = {
    ...(docNumber ? { DocNumber: docNumber } : {}),
    CustomerRef: { value: params.customerId },
    BillEmail: { Address: params.customerEmail },
    EmailStatus: "NeedToSend",
    TxnStatus: "Pending",
    Line: lines,
    ExpirationDate: new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0],
  };

  if (params.customerMemo) estimateBody.CustomerMemo = { value: params.customerMemo };
  if (params.deliveryAddress) estimateBody.ShipAddr = { Line1: params.deliveryAddress };

  const data = await qboPostWithDocRetry("/estimate", estimateBody);
  const estimate = data.Estimate;

  // Try to get the shareable estimate link
  let estimateLink: string | null = null;
  try {
    const linkData = await qboGet(`/estimate/${estimate.Id}/onlineinvoice`);
    estimateLink = linkData?.InvoiceLink || null;
  } catch (_) {
    console.warn("[QBO] Could not get estimate link");
  }
  // Fallback: direct QBO estimate URL (works even without QBO Payments activated)
  if (!estimateLink) {
    estimateLink = `https://app.qbo.intuit.com/app/estimate?txnId=${estimate.Id}`;
  }

  return {
    estimateId: estimate.Id,
    estimateNumber: estimate.DocNumber,
    estimateLink,
  };
}

// ── Check estimate approval status ───────────────────────────────────────────
export async function getEstimateStatus(estimateId: string): Promise<string> {
  try {
    const data = await qboGet(`/estimate/${estimateId}`);
    return data?.Estimate?.TxnStatus || "Pending";
  } catch {
    return "Unknown";
  }
}

// ── Convert an approved estimate to an invoice ───────────────────────────────
export async function convertEstimateToInvoice(qboEstimateId: string, customerEmail: string): Promise<{
  invoiceId: string;
  invoiceNumber: string;
  paymentLink: string | null;
}> {
  // QBO v3 API: POST /estimate/{id}?operation=convert to create an invoice from an estimate
  const { realmId } = cfg();
  const token = await getAccessToken();
  const res = await fetch(
    `${QB_BASE}/${realmId}/estimate/${qboEstimateId}?operation=convert&minorversion=75`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({}),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`QBO estimate convert failed: ${res.status} ${errText}`);
  }

  const data = await res.json();
  const invoice = data.Invoice;

  // Stamp the next sequential DocNumber
  const docNumber = await getNextDocNumber("Invoice");
  if (docNumber) {
    // Update the invoice DocNumber (QBO created it without one on convert)
    try {
      await qboPost(`/invoice?minorversion=75`, {
        ...invoice,
        DocNumber: docNumber,
        sparse: true,
      });
    } catch (_) {
      // Non-fatal — invoice exists, just might not have the number
    }
  }

  // Send invoice email
  try {
    await qboPost(`/invoice/${invoice.Id}/send?sendTo=${encodeURIComponent(customerEmail)}`, {});
  } catch (_) {
    console.warn("[QBO] Could not send invoice email after convert");
  }

  // Get payment link
  let paymentLink: string | null = null;
  try {
    const linkData = await qboGet(`/invoice/${invoice.Id}/onlineinvoice`);
    paymentLink = linkData?.InvoiceLink || null;
  } catch (_) {}
  if (!paymentLink) {
    paymentLink = `https://app.qbo.intuit.com/app/invoice?txnId=${invoice.Id}`;
  }

  return {
    invoiceId: invoice.Id,
    invoiceNumber: docNumber || invoice.DocNumber || invoice.Id,
    paymentLink,
  };
}

// ── Get next sequential DocNumber for invoices or estimates ────────────────────
async function getNextDocNumber(type: "Invoice" | "Estimate"): Promise<string> {
  try {
    const encoded = encodeURIComponent(
      `SELECT DocNumber FROM ${type} ORDERBY DocNumber DESC MAXRESULTS 1`
    );
    const data = await qboGet(`/query?query=${encoded}`);
    const items: any[] = data.QueryResponse?.[type] || [];
    if (items.length === 0) return type === "Invoice" ? "1001" : "5001";
    const last = items[0].DocNumber || "";
    // Extract trailing numeric portion and increment
    const match = last.match(/(\d+)$/);
    if (!match) return type === "Invoice" ? "1001" : "5001";
    const next = parseInt(match[1], 10) + 1;
    // Preserve any non-numeric prefix (e.g. "INV-" → "INV-1002")
    const prefix = last.slice(0, last.length - match[1].length);
    return `${prefix}${next}`;
  } catch (err) {
    console.error(`[QBO] getNextDocNumber(${type}) failed:`, err);
    return "";
  }
}

// ── Get recent invoices for a customer ──────────────────────────────────────
export async function getCustomerInvoices(customerId: string, limit = 5): Promise<Array<{
  invoiceNumber: string;
  date: string;
  dueDate: string;
  total: number;
  balance: number;
  status: string;
  lines: Array<{ name: string; qty: number; unitPrice: number; amount: number }>;
}>> {
  try {
    const encoded = encodeURIComponent(
      `SELECT * FROM Invoice WHERE CustomerRef = '${customerId}' ORDERBY TxnDate DESC MAXRESULTS ${limit}`
    );
    const data = await qboGet(`/query?query=${encoded}`);
    const invoices = data.QueryResponse?.Invoice || [];
    return invoices.map((inv: any) => {
      const lines = (inv.Line || [])
        .filter((l: any) => l.DetailType === "SalesItemLineDetail")
        .map((l: any) => ({
          name: l.SalesItemLineDetail?.ItemRef?.name || l.Description || "Item",
          qty: l.SalesItemLineDetail?.Qty || 1,
          unitPrice: l.SalesItemLineDetail?.UnitPrice || 0,
          amount: l.Amount || 0,
        }));
      const balance = inv.Balance ?? inv.TotalAmt ?? 0;
      const total = inv.TotalAmt ?? 0;
      let status = "Open";
      if (inv.Balance === 0) status = "Paid";
      else if (inv.Balance < inv.TotalAmt) status = "Partial";
      return {
        invoiceNumber: inv.DocNumber || inv.Id,
        date: inv.TxnDate || "",
        dueDate: inv.DueDate || "",
        total,
        balance,
        status,
        lines,
      };
    });
  } catch (err) {
    console.error("[QBO] getCustomerInvoices failed:", err);
    return [];
  }
}

// ── Check if QBO is configured ────────────────────────────────────────────────
export function isQboConfigured(): boolean {
  const { clientId, clientSecret, refreshToken, realmId } = cfg();
  return !!(clientId && clientSecret && refreshToken && realmId);
}
