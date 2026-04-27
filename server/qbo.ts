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
let liveRefreshToken: string | null = null;

export function setLiveRefreshToken(token: string) {
  liveRefreshToken = token;
  _accessToken = null;
  _tokenExpiry = 0;
}

// Called at startup after DB migrations — loads persisted token into memory
export async function initQboToken(): Promise<void> {
  try {
    const stored = await storage.getSetting("qbo_refresh_token");
    if (stored) {
      liveRefreshToken = stored;
      console.log("[QBO] Loaded refresh token from DB:", stored.substring(0, 20));
    } else {
      console.log("[QBO] No persisted token found — will use env var QBO_REFRESH_TOKEN");
    }
  } catch (err: any) {
    console.error("[QBO] Failed to load token from DB:", err?.message);
  }
}

export async function updateRailwayEnvVar(key: string, value: string): Promise<void> {
  try {
    const railwayToken = process.env.RAILWAY_TOKEN;
    const serviceId = process.env.RAILWAY_SERVICE_ID;
    const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
    if (!railwayToken || !serviceId || !environmentId) {
      console.log('[QBO] Railway env vars not configured for auto-update, skipping');
      return;
    }
    const mutation = `
      mutation variableUpsert($input: VariableUpsertInput!) {
        variableUpsert(input: $input)
      }
    `;
    const resp = await fetch('https://backboard.railway.app/graphql/v2', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${railwayToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: mutation,
        variables: { input: { serviceId, environmentId, name: key, value } },
      }),
    });
    const data = await resp.json();
    console.log('[QBO] Railway env var update result:', JSON.stringify(data));
  } catch (err: any) {
    console.error('[QBO] Failed to update Railway env var:', err?.message);
  }
}

function getCurrentRefreshToken(): string {
  // liveRefreshToken is loaded from DB at startup via initQboToken()
  // and rotated in-memory whenever a new token is issued
  if (liveRefreshToken) return liveRefreshToken;
  return process.env.QBO_REFRESH_TOKEN || "";
}

function cfg() {
  return {
    clientId: process.env.QBO_CLIENT_ID!,
    clientSecret: process.env.QBO_CLIENT_SECRET!,
    refreshToken: getCurrentRefreshToken(),
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

  // Persist the new refresh token if rotated — survives within the deployment
  // so subsequent refreshes use the latest token, not the stale env seed.
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    liveRefreshToken = data.refresh_token;
    storage.setSetting("qbo_refresh_token", data.refresh_token);
    console.log("[QBO] Refresh token rotated — persisted to DB settings table");
    updateRailwayEnvVar("QBO_REFRESH_TOKEN", data.refresh_token).catch(console.error);
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

// Fetch shareable invoice/estimate link via include=invoiceLink (works without QBO Payments)
async function getShareableLink(type: "invoice" | "estimate", id: string): Promise<string | null> {
  try {
    const { realmId } = cfg();
    const token = await getAccessToken();
    const res = await fetch(
      `${QB_BASE}/${realmId}/${type}/${id}?include=invoiceLink&minorversion=75`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const obj = type === "invoice" ? data?.Invoice : data?.Estimate;
    return obj?.InvoiceLink || null;
  } catch {
    return null;
  }
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
  const MAX_RETRIES = 100;
  let attempt = 0;
  let currentDoc: string = body.DocNumber || "";

  while (attempt < 100) {
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
// Returns all active QBO items with live pricing — used by /api/qbo/items
export async function qboQuery(sql: string): Promise<any> {
  const encoded = encodeURIComponent(sql);
  return qboGet(`/query?query=${encoded}&minorversion=75`);
}

export async function getQboItems(): Promise<Array<{
  id: string; name: string; description: string | null;
  unitPrice: number | null; type: string; active: boolean;
}>> {
  const data = await qboGet(
    "/query?query=SELECT%20*%20FROM%20Item%20WHERE%20Active%3Dtrue%20MAXRESULTS%20500"
  );
  return (data.QueryResponse?.Item || []).map((item: any) => ({
    id: item.Id,
    name: item.Name,
    description: item.Description || null,
    unitPrice: item.UnitPrice ?? null,
    type: item.Type,
    active: item.Active !== false,
  }));
}

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
    console.log(`[QBO] lookupCustomerByPhone: checked ${customers.length} customers for ${phone}, no match found. Sample phones: ${customers.slice(0,3).map((c: any) => c.PrimaryPhone?.FreeFormNumber || 'none').join(', ')}`);
    return null;
  } catch (err: any) {
    console.error(`[QBO] lookupCustomerByPhone failed for ${phone}:`, err?.message || err, err?.response?.data || '');
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

// ── Find existing QBO customer only (no create) ─────────────────────────────
// Used for web orders — only existing customers can invoice to prevent fraud.
// Pass 1: match by phone alone (most reliable).
// Pass 2: fuzzy name match on the phone-matched record (tolerates typos).
// Pass 3: fuzzy name across all customers when phone not on file.
export async function findExistingCustomer(params: {
  name: string;
  phone: string;
  email?: string;
}): Promise<string | null> {
  const normalizePhone = (p: string) => p.replace(/\D/g, "");
  const inputPhone = normalizePhone(params.phone);

  // Simple Levenshtein for fuzzy name comparison
  function levenshtein(a: string, b: string): number {
    const m = a.length, n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
      Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
    );
    for (let i = 1; i <= m; i++)
      for (let j = 1; j <= n; j++)
        dp[i][j] = a[i-1] === b[j-1]
          ? dp[i-1][j-1]
          : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    return dp[m][n];
  }

  // Normalize a name for comparison: lowercase, strip punctuation/extra spaces
  function normName(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  }

  // Returns true if names are close enough: exact, or edit distance ≤ 2
  // AND the shorter name is at least 4 chars (avoids false positives on short names)
  function nameMatches(input: string, qbo: string): boolean {
    const a = normName(input);
    const b = normName(qbo);
    if (a === b) return true;
    // Also check if input is contained in the QBO name or vice versa (handles company suffixes)
    if (b.includes(a) || a.includes(b)) return true;
    const dist = levenshtein(a, b);
    const minLen = Math.min(a.length, b.length);
    // Allow 1 edit per ~6 chars, capped at 3 edits total
    const threshold = Math.min(3, Math.floor(minLen / 6) + 1);
    return dist <= threshold;
  }

  try {
    // Fetch all active customers once
    const encoded = encodeURIComponent(`SELECT * FROM Customer WHERE Active = true MAXRESULTS 500`);
    const data = await qboGet(`/query?query=${encoded}`);
    const customers: any[] = data.QueryResponse?.Customer || [];

    // ── Pass 1: phone match + fuzzy name ────────────────────────────────────
    if (inputPhone.length >= 7) {
      for (const c of customers) {
        const qboPhone = normalizePhone(c.PrimaryPhone?.FreeFormNumber || c.Mobile?.FreeFormNumber || "");
        if (!qboPhone) continue;
        const phoneMatch = qboPhone.slice(-10) === inputPhone.slice(-10);
        if (!phoneMatch) continue;
        // Phone matched — accept even if name has a small typo
        const qboName = c.DisplayName || c.FullyQualifiedName || "";
        if (nameMatches(params.name, qboName)) {
          console.log(`[QBO] findExistingCustomer: phone+fuzzyName match → "${qboName}" for input "${params.name}"`);
          if (params.email && !c.PrimaryEmailAddr?.Address) {
            try {
              await qboPost("/customer", {
                Id: c.Id, SyncToken: c.SyncToken, sparse: true,
                PrimaryEmailAddr: { Address: params.email },
              });
            } catch (_) {}
          }
          return c.Id;
        }
        // Phone matched but name is very different — still allow if within 3 edits
        // (covers cases where customer used their company name vs personal name)
        const dist = levenshtein(normName(params.name), normName(qboName));
        if (dist <= 3) {
          console.log(`[QBO] findExistingCustomer: phone match + loose name (dist=${dist}) → "${qboName}" for input "${params.name}"`);
          return c.Id;
        }
      }
    }

    // ── Pass 2: name-only fuzzy match (no phone on file) ────────────────────
    for (const c of customers) {
      const qboName = c.DisplayName || c.FullyQualifiedName || "";
      if (!nameMatches(params.name, qboName)) continue;
      // Require at least the email to match if no phone
      const qboEmail = (c.PrimaryEmailAddr?.Address || "").toLowerCase();
      if (params.email && qboEmail && qboEmail === params.email.toLowerCase()) {
        console.log(`[QBO] findExistingCustomer: fuzzyName+email match → "${qboName}"`);
        return c.Id;
      }
    }
  } catch (err: any) {
    console.error(`[QBO] findExistingCustomer failed:`, err?.message);
  }

  return null; // Not found — do not create
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

  // Try to create new customer
  const displayName = params.company ? `${params.name} - ${params.company}` : params.name;
  const body: Record<string, any> = {
    DisplayName: displayName,
    GivenName: params.name.split(" ")[0],
    FamilyName: params.name.split(" ").slice(1).join(" ") || "",
    PrimaryEmailAddr: { Address: params.email },
    PrimaryPhone: { FreeFormNumber: params.phone },
  };
  if (params.company) body.CompanyName = params.company;

  try {
    const data = await qboPost("/customer", body);
    return data.Customer.Id;
  } catch (createErr: any) {
    // If duplicate name error, fall back to searching by display name
    const isDuplicate = createErr?.message?.includes("6240") || createErr?.message?.includes("Duplicate Name");
    if (isDuplicate) {
      try {
        let existingCustomer: any = null;
        const encoded = encodeURIComponent(`SELECT * FROM Customer WHERE DisplayName = '${displayName}'`);
        const data = await qboGet(`/query?query=${encoded}`);
        const customers = data.QueryResponse?.Customer || [];
        if (customers.length > 0) existingCustomer = customers[0];
        if (!existingCustomer) {
          // Try just the name without company
          const encodedName = encodeURIComponent(`SELECT * FROM Customer WHERE DisplayName = '${params.name}'`);
          const data2 = await qboGet(`/query?query=${encodedName}`);
          const customers2 = data2.QueryResponse?.Customer || [];
          if (customers2.length > 0) existingCustomer = customers2[0];
        }
        if (existingCustomer) {
          // If the existing customer has no email, update it so invoicing works
          const hasEmail = existingCustomer.PrimaryEmailAddr?.Address;
          if (!hasEmail && params.email) {
            try {
              await qboPost("/customer", {
                Id: existingCustomer.Id,
                SyncToken: existingCustomer.SyncToken,
                sparse: true,
                PrimaryEmailAddr: { Address: params.email },
              });
            } catch (updateErr) {
              console.warn("[QBO] Could not update customer email:", updateErr);
            }
          }
          return existingCustomer.Id;
        }
      } catch (_) {}
    }
    throw createErr;
  }
}

// ── Get or create the "BOT" customer in QBO ─────────────────────────────────
// Used for plan-takeoff estimates that aren't tied to an existing human customer.
let _botCustomerIdCache: string | null = null;
export async function getOrCreateBotCustomer(): Promise<string> {
  if (_botCustomerIdCache) return _botCustomerIdCache;
  try {
    const encoded = encodeURIComponent(`SELECT * FROM Customer WHERE DisplayName = 'BOT'`);
    const data = await qboGet(`/query?query=${encoded}`);
    const customers = data.QueryResponse?.Customer || [];
    if (customers.length > 0) {
      _botCustomerIdCache = customers[0].Id;
      return customers[0].Id;
    }
  } catch (err) {
    console.warn("[QBO] BOT customer lookup failed, will attempt create:", err);
  }
  try {
    const data = await qboPost("/customer", {
      DisplayName: "BOT",
      CompanyName: "RCP SMS Bot — Plan Takeoffs",
      Notes: "Automated bid/estimate customer. Used for plan-takeoff estimates generated by the RCP SMS Bot.",
    });
    _botCustomerIdCache = data.Customer.Id;
    console.log(`[QBO] Created BOT customer (id=${data.Customer.Id})`);
    return data.Customer.Id;
  } catch (err) {
    console.error("[QBO] Failed to create BOT customer:", err);
    throw err;
  }
}

// ── Create invoice in QBO ─────────────────────────────────────────────────────
export async function createInvoice(params: {
  customerId: string;
  customerEmail?: string;
  lineItems: LineItem[];
  deliveryFee?: number;
  deliveryMiles?: number;
  deliveryAddress?: string;
  deliveryNotes?: string;
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
    ...(params.customerEmail ? { BillEmail: { Address: params.customerEmail }, EmailStatus: "NeedToSend" } : { EmailStatus: "NotSet" }),
    Line: lines,
    DueDate: new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0],
  };

  if (params.customerMemo) {
    invoiceBody.CustomerMemo = { value: params.customerMemo };
  }
  if (params.deliveryAddress) {
    invoiceBody.ShipAddr = {
      Line1: params.deliveryAddress,
      ...(params.deliveryNotes ? { Line2: params.deliveryNotes } : {}),
    };
  }

  let data: any;
  try {
    data = await qboPostWithDocRetry("/invoice", invoiceBody);
  } catch (err: any) {
    // QBO error 6000: customer has email-statements required but no email on file.
    // Retry with email fields completely removed.
    const is6000 = err?.message?.includes("6000") || err?.message?.includes("email address for this customer");
    if (is6000) {
      console.warn("[QBO] Error 6000 — retrying invoice without BillEmail/EmailStatus");
      const { BillEmail: _be, EmailStatus: _es, ...bodyNoEmail } = invoiceBody;
      bodyNoEmail.EmailStatus = "NotSet";
      data = await qboPostWithDocRetry("/invoice", bodyNoEmail);
    } else {
      throw err;
    }
  }
  const invoice = data.Invoice;

  // Get shareable invoice link (include=invoiceLink, no QBO Payments required)
  const paymentLink = (await getShareableLink("invoice", invoice.Id))
    ?? `https://app.qbo.intuit.com/app/invoice?txnId=${invoice.Id}`;
  console.log("[QBO] Payment link:", paymentLink);

  return {
    invoiceId: invoice.Id,
    invoiceNumber: invoice.DocNumber,
    paymentLink,
  };
}

// ── Create estimate in QBO ───────────────────────────────────────────────────
export async function createEstimate(params: {
  customerId: string;
  customerEmail?: string;
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
    ...(params.customerEmail ? { BillEmail: { Address: params.customerEmail }, EmailStatus: "NeedToSend" } : { EmailStatus: "NotSet" }),
    TxnStatus: "Pending",
    Line: lines,
    ExpirationDate: new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0],
  };

  if (params.customerMemo) estimateBody.CustomerMemo = { value: params.customerMemo };
  if (params.deliveryAddress) estimateBody.ShipAddr = { Line1: params.deliveryAddress };

  const data = await qboPostWithDocRetry("/estimate", estimateBody);
  const estimate = data.Estimate;

  // Get shareable estimate link (include=invoiceLink, no QBO Payments required)
  const estimateLink = (await getShareableLink("estimate", estimate.Id))
    ?? `https://app.qbo.intuit.com/app/estimate?txnId=${estimate.Id}`;
  console.log("[QBO] Estimate link:", estimateLink);

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

  // Get shareable invoice link
  const paymentLink = (await getShareableLink("invoice", invoice.Id))
    ?? `https://app.qbo.intuit.com/app/invoice?txnId=${invoice.Id}`;
  console.log("[QBO] Converted invoice link:", paymentLink);

  return {
    invoiceId: invoice.Id,
    invoiceNumber: docNumber || invoice.DocNumber || invoice.Id,
    paymentLink,
  };
}

// ── Get next sequential DocNumber for invoices or estimates ────────────────────
async function getNextDocNumber(type: "Invoice" | "Estimate"): Promise<string> {
  const fallback = type === "Invoice" ? "20000" : "30000";
  try {
    const result = await Promise.race([
      (async () => {
        // Strategy: fetch the 500 most recently updated docs — highest numbers will be among them
        // This avoids scanning all 2000+ invoices which takes 22+ seconds
        let maxNum = 0;
        let startPos = 1;
        const pageSize = 100;
        const maxPages = 5; // only scan 500 most-recent
        for (let page = 1; page <= maxPages; page++) {
          console.log(`[QBO] getNextDocNumber(${type}) page ${page} startPos=${startPos}`);
          const query = encodeURIComponent(
            `SELECT DocNumber FROM ${type} ORDERBY MetaData.LastUpdatedTime DESC STARTPOSITION ${startPos} MAXRESULTS ${pageSize}`
          );
          const data = await qboGet(`/query?query=${query}`);
          const items: any[] = data.QueryResponse?.[type] || [];
          console.log(`[QBO] getNextDocNumber(${type}) page ${page}: got ${items.length} items`);
          for (const item of items) {
            const match = (item.DocNumber || "").match(/(\d+)$/);
            if (match) {
              const n = parseInt(match[1], 10);
              if (n > maxNum) maxNum = n;
            }
          }
          if (items.length < pageSize) break; // last page
          startPos += pageSize;
        }
        const next = maxNum > 0 ? String(maxNum + 1) : fallback;
        console.log(`[QBO] getNextDocNumber(${type}): maxNum=${maxNum}, next=${next}`);
        return next;
      })(),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error(`getNextDocNumber(${type}) timed out after 20s`)), 20000)
      ),
    ]);
    return result;
  } catch (err) {
    console.error(`[QBO] getNextDocNumber failed:`, err);
    return fallback;
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
