import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, desc, and } from "drizzle-orm";
import {
  conversations, messages, orders, products, estimates,
  type Conversation, type InsertConversation,
  type Message, type InsertMessage,
  type Order, type InsertOrder,
  type Product, type InsertProduct,
  type Estimate, type InsertEstimate,
  type ConversationWithMessages,
} from "@shared/schema";

// Use persistent volume path if available (Railway), otherwise fall back to local
const DB_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? `${process.env.RAILWAY_VOLUME_MOUNT_PATH}/data.db`
  : "data.db";
const sqlite = new Database(DB_PATH);
export const db = drizzle(sqlite);

// ── Migrations (create tables) ────────────────────────────────────────────────
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    customer_name TEXT,
    customer_email TEXT,
    customer_company TEXT,
    delivery_address TEXT,
    qbo_customer_id TEXT,
    verified INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    stage TEXT NOT NULL DEFAULT 'greeting',
    pending_images_json TEXT,
    created_at INTEGER,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    direction TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    qbo_invoice_id TEXT,
    qbo_invoice_number TEXT,
    payment_link TEXT,
    line_items_json TEXT NOT NULL,
    subtotal REAL NOT NULL DEFAULT 0,
    delivery_fee REAL NOT NULL DEFAULT 0,
    delivery_miles REAL,
    total REAL NOT NULL DEFAULT 0,
    delivery_type TEXT NOT NULL DEFAULT 'pickup',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    qbo_item_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    unit_price REAL,
    unit_of_measure TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    synced_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS estimates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    qbo_estimate_id TEXT,
    qbo_estimate_number TEXT,
    qbo_estimate_link TEXT,
    line_items_json TEXT NOT NULL,
    fabrication_json TEXT,
    plan_pages_json TEXT,
    takeoff_notes_json TEXT,
    subtotal REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    cut_sheet_emailed_at INTEGER,
    created_at INTEGER
  );
`);

// ── Column migrations (safe: ignore error if column already exists) ───────────
const migrations = [
  `ALTER TABLE conversations ADD COLUMN pending_images_json TEXT`,
  `ALTER TABLE conversations ADD COLUMN project_name TEXT`,
  `ALTER TABLE conversations ADD COLUMN project_address TEXT`,
];
for (const sql of migrations) {
  try { sqlite.exec(sql); } catch { /* column already exists — safe to ignore */ }
}

export interface IStorage {
  // Conversations
  getOrCreateConversation(phone: string): Conversation;
  getConversation(id: number): Conversation | undefined;
  getConversationByPhone(phone: string): Conversation | undefined;
  updateConversation(id: number, data: Partial<InsertConversation>): Conversation;
  getAllConversations(): ConversationWithMessages[];

  // Messages
  addMessage(data: InsertMessage): Message;
  getMessages(conversationId: number): Message[];

  // Orders
  createOrder(data: InsertOrder): Order;
  updateOrder(id: number, data: Partial<InsertOrder>): Order;
  getOrderByConversation(conversationId: number): Order | undefined;
  getAllOrders(): Order[];

  // Products
  upsertProduct(data: InsertProduct): Product;
  getAllProducts(): Product[];
  getProductByQboId(qboItemId: string): Product | undefined;

  // Estimates
  createEstimate(data: InsertEstimate): Estimate;
  updateEstimate(id: number, data: Partial<InsertEstimate>): Estimate;
  getEstimate(id: number): Estimate | undefined;
  getEstimateByConversation(conversationId: number): Estimate | undefined;
  getAllEstimates(): Estimate[];

  // Settings (key-value)
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
}

export class Storage implements IStorage {
  // ── Conversations ───────────────────────────────────────────────────────────
  getOrCreateConversation(phone: string): Conversation {
    // First look for an active conversation
    const active = db.select().from(conversations)
      .where(and(eq(conversations.phone, phone), eq(conversations.status, "active")))
      .orderBy(desc(conversations.createdAt))
      .get();
    if (active) return active;

    // If a completed conversation exists, reactivate it so the customer
    // keeps their verified status and history rather than starting over.
    // Preserve "invoiced" stage so the AI knows the invoice was already sent
    // and the customer can ask follow-up questions without restarting ordering.
    const completed = db.select().from(conversations)
      .where(and(eq(conversations.phone, phone), eq(conversations.status, "completed")))
      .orderBy(desc(conversations.updatedAt))
      .get();
    if (completed) {
      const nextStage = completed.stage === "invoiced" ? "invoiced" : "ordering";
      // Clear pendingImagesJson on reactivation — otherwise PDFs / base64 images
      // from the prior SQLite-persisted session bleed into the new conversation
      // and contaminate any future takeoff.
      return db.update(conversations)
        .set({ status: "active", stage: nextStage, pendingImagesJson: null, updatedAt: new Date() })
        .where(eq(conversations.id, completed.id))
        .returning().get();
    }

    // No history at all — brand new customer
    return db.insert(conversations).values({
      phone,
      status: "active",
      stage: "greeting",
      pendingImagesJson: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).returning().get();
  }

  getConversation(id: number): Conversation | undefined {
    return db.select().from(conversations).where(eq(conversations.id, id)).get();
  }

  getConversationByPhone(phone: string): Conversation | undefined {
    return db.select().from(conversations)
      .where(and(eq(conversations.phone, phone), eq(conversations.status, "active")))
      .orderBy(desc(conversations.createdAt))
      .get();
  }

  updateConversation(id: number, data: Partial<InsertConversation>): Conversation {
    return db.update(conversations)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(conversations.id, id))
      .returning().get();
  }

  getAllConversations(): ConversationWithMessages[] {
    const convs = db.select().from(conversations).orderBy(desc(conversations.updatedAt)).all();
    return convs.map(conv => ({
      ...conv,
      messages: db.select().from(messages).where(eq(messages.conversationId, conv.id)).all(),
      orders: db.select().from(orders).where(eq(orders.conversationId, conv.id)).all(),
    }));
  }

  // ── Messages ────────────────────────────────────────────────────────────────
  addMessage(data: InsertMessage): Message {
    return db.insert(messages).values({ ...data, createdAt: new Date() }).returning().get();
  }

  getMessages(conversationId: number): Message[] {
    return db.select().from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(messages.createdAt)
      .all();
  }

  // ── Orders ──────────────────────────────────────────────────────────────────
  createOrder(data: InsertOrder): Order {
    return db.insert(orders).values({ ...data, createdAt: new Date() }).returning().get();
  }

  updateOrder(id: number, data: Partial<InsertOrder>): Order {
    return db.update(orders).set(data).where(eq(orders.id, id)).returning().get();
  }

  getOrderByConversation(conversationId: number): Order | undefined {
    return db.select().from(orders)
      .where(eq(orders.conversationId, conversationId))
      .orderBy(desc(orders.createdAt))
      .get();
  }

  getAllOrders(): Order[] {
    return db.select().from(orders).orderBy(desc(orders.createdAt)).all();
  }

  // ── Products ────────────────────────────────────────────────────────────────
  upsertProduct(data: InsertProduct): Product {
    const existing = db.select().from(products).where(eq(products.qboItemId, data.qboItemId)).get();
    if (existing) {
      return db.update(products).set({ ...data, syncedAt: new Date() })
        .where(eq(products.qboItemId, data.qboItemId)).returning().get();
    }
    return db.insert(products).values({ ...data, syncedAt: new Date() }).returning().get();
  }

  getAllProducts(): Product[] {
    return db.select().from(products).where(eq(products.active, true)).all();
  }

  getProductByQboId(qboItemId: string): Product | undefined {
    return db.select().from(products).where(eq(products.qboItemId, qboItemId)).get();
  }

  // ── Estimates ────────────────────────────────────────────────────────────────
  createEstimate(data: InsertEstimate): Estimate {
    return db.insert(estimates).values({ ...data, createdAt: new Date() }).returning().get();
  }

  updateEstimate(id: number, data: Partial<InsertEstimate>): Estimate {
    return db.update(estimates).set(data).where(eq(estimates.id, id)).returning().get();
  }

  getEstimate(id: number): Estimate | undefined {
    return db.select().from(estimates).where(eq(estimates.id, id)).get();
  }

  getEstimateByConversation(conversationId: number): Estimate | undefined {
    return db.select().from(estimates)
      .where(eq(estimates.conversationId, conversationId))
      .orderBy(desc(estimates.createdAt))
      .get();
  }

  getAllEstimates(): Estimate[] {
    return db.select().from(estimates).orderBy(desc(estimates.createdAt)).all();
  }

  // ── Settings (key-value) ────────────────────────────────────────────────────
  getSetting(key: string): string | null {
    const row = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    sqlite.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
}

export const storage = new Storage();
