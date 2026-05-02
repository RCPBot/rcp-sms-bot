import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq, desc, and } from "drizzle-orm";
import {
  conversations, messages, orders, products, estimates, settings,
  type Conversation, type InsertConversation,
  type Message, type InsertMessage,
  type Order, type InsertOrder,
  type Product, type InsertProduct,
  type Estimate, type InsertEstimate,
  type ConversationWithMessages,
} from "@shared/schema";

// ── Database connection ───────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway") ? { rejectUnauthorized: false } : false,
});
export const db = drizzle(pool);

// ── Migrations (create tables if not exist) ───────────────────────────────────
async function runMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      customer_name TEXT,
      customer_email TEXT,
      customer_company TEXT,
      delivery_address TEXT,
      project_name TEXT,
      project_address TEXT,
      qbo_customer_id TEXT,
      verified BOOLEAN NOT NULL DEFAULT false,
      status TEXT NOT NULL DEFAULT 'active',
      stage TEXT NOT NULL DEFAULT 'greeting',
      pending_images_json TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      direction TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
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
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      qbo_item_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      unit_price REAL,
      unit_of_measure TEXT,
      active BOOLEAN NOT NULL DEFAULT true,
      synced_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS estimates (
      id SERIAL PRIMARY KEY,
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
      cut_sheet_emailed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS flagged_conversations (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER REFERENCES conversations(id),
      source TEXT NOT NULL,
      flag_reason TEXT NOT NULL,
      flag_detail TEXT NOT NULL,
      customer_message TEXT NOT NULL,
      bot_response TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      quoted_amount REAL,
      conversion TEXT,
      reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- Add new columns to flagged_conversations if upgrading existing DB
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='flagged_conversations' AND column_name='quoted_amount') THEN
        ALTER TABLE flagged_conversations ADD COLUMN quoted_amount REAL;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='flagged_conversations' AND column_name='conversion') THEN
        ALTER TABLE flagged_conversations ADD COLUMN conversion TEXT;
      END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS learned_rules (
      id SERIAL PRIMARY KEY,
      rule_text TEXT NOT NULL,
      source_flag_id INTEGER REFERENCES flagged_conversations(id),
      category TEXT NOT NULL,
      added_by TEXT NOT NULL DEFAULT 'brian',
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS customer_memory (
      id SERIAL PRIMARY KEY,
      phone TEXT UNIQUE NOT NULL,
      name TEXT,
      email TEXT,
      company TEXT,
      delivery_address TEXT,
      typical_bar_sizes TEXT,
      typical_products TEXT,
      last_order_summary TEXT,
      order_count INTEGER NOT NULL DEFAULT 0,
      total_spent REAL NOT NULL DEFAULT 0,
      avg_order_value REAL NOT NULL DEFAULT 0,
      largest_order_value REAL NOT NULL DEFAULT 0,
      most_ordered_product TEXT,
      customer_type TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- Add new columns to customer_memory if upgrading existing DB
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='customer_memory' AND column_name='avg_order_value') THEN
        ALTER TABLE customer_memory ADD COLUMN avg_order_value REAL NOT NULL DEFAULT 0;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='customer_memory' AND column_name='largest_order_value') THEN
        ALTER TABLE customer_memory ADD COLUMN largest_order_value REAL NOT NULL DEFAULT 0;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='customer_memory' AND column_name='most_ordered_product') THEN
        ALTER TABLE customer_memory ADD COLUMN most_ordered_product TEXT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='customer_memory' AND column_name='customer_type') THEN
        ALTER TABLE customer_memory ADD COLUMN customer_type TEXT;
      END IF;
    END $$;
  `);
}

// Export so index.ts can await it before starting the server
export { runMigrations };

// ── Interface ─────────────────────────────────────────────────────────────────
export interface IStorage {
  // Conversations
  getOrCreateConversation(phone: string): Promise<Conversation>;
  getConversation(id: number): Promise<Conversation | undefined>;
  getConversationByPhone(phone: string): Promise<Conversation | undefined>;
  updateConversation(id: number, data: Partial<InsertConversation>): Promise<Conversation>;
  getAllConversations(): Promise<ConversationWithMessages[]>;

  // Messages
  addMessage(data: InsertMessage): Promise<Message>;
  getMessages(conversationId: number): Promise<Message[]>;

  // Orders
  createOrder(data: InsertOrder): Promise<Order>;
  updateOrder(id: number, data: Partial<InsertOrder>): Promise<Order>;
  getOrderByConversation(conversationId: number): Promise<Order | undefined>;
  getAllOrders(): Promise<Order[]>;

  // Products
  upsertProduct(data: InsertProduct): Promise<Product>;
  getAllProducts(): Promise<Product[]>;
  getProductByQboId(qboItemId: string): Promise<Product | undefined>;

  // Estimates
  createEstimate(data: InsertEstimate): Promise<Estimate>;
  updateEstimate(id: number, data: Partial<InsertEstimate>): Promise<Estimate>;
  getEstimate(id: number): Promise<Estimate | undefined>;
  getEstimateByConversation(conversationId: number): Promise<Estimate | undefined>;
  getAllEstimates(): Promise<Estimate[]>;

  // Settings
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;

  // Flagged conversations
  flagConversation(data: { conversationId: number, source: string, flagReason: string, flagDetail: string, customerMessage: string, botResponse: string, quotedAmount?: number, conversion?: string }): Promise<void>;
  updateFlagConversion(conversationId: number, conversion: 'converted' | 'abandoned'): Promise<void>;
  getPendingFlags(): Promise<any[]>;
  reviewFlag(id: number, status: 'approved' | 'dismissed'): Promise<void>;

  // Learned rules
  addLearnedRule(ruleText: string, category: string, sourceFlagId?: number): Promise<void>;
  getLearnedRules(): Promise<{ id: number, ruleText: string, category: string }[]>;
  deactivateLearnedRule(id: number): Promise<void>;

  // Customer memory
  upsertCustomerMemory(phone: string, data: Partial<{name:string, email:string, company:string, deliveryAddress:string, typicalBarSizes:string, typicalProducts:string, lastOrderSummary:string, orderCount:number, totalSpent:number, avgOrderValue:number, largestOrderValue:number, mostOrderedProduct:string, customerType:string, notes:string}>): Promise<void>;
  getCustomerMemory(phone: string): Promise<any | null>;
  recordOrderCompletion(phone: string, orderTotal: number, orderSummary: string, lineItems: Array<{name: string, qty: number}>): Promise<void>;
}

export class Storage implements IStorage {
  // ── Conversations ───────────────────────────────────────────────────────────
  async getOrCreateConversation(phone: string): Promise<Conversation> {
    // Look for active conversation
    const [active] = await db.select().from(conversations)
      .where(and(eq(conversations.phone, phone), eq(conversations.status, "active")))
      .orderBy(desc(conversations.createdAt))
      .limit(1);
    if (active) return active;

    // Reactivate completed conversation
    const [completed] = await db.select().from(conversations)
      .where(and(eq(conversations.phone, phone), eq(conversations.status, "completed")))
      .orderBy(desc(conversations.updatedAt))
      .limit(1);
    if (completed) {
      const nextStage = completed.stage === "invoiced" ? "invoiced" : "ordering";
      const [updated] = await db.update(conversations)
        .set({ status: "active", stage: nextStage, pendingImagesJson: null, updatedAt: new Date() })
        .where(eq(conversations.id, completed.id))
        .returning();
      return updated;
    }

    // Brand new customer
    const [created] = await db.insert(conversations).values({
      phone,
      status: "active",
      stage: "greeting",
      pendingImagesJson: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).returning();
    return created;
  }

  async getConversation(id: number): Promise<Conversation | undefined> {
    const [row] = await db.select().from(conversations).where(eq(conversations.id, id));
    return row;
  }

  async getConversationByPhone(phone: string): Promise<Conversation | undefined> {
    const [row] = await db.select().from(conversations)
      .where(and(eq(conversations.phone, phone), eq(conversations.status, "active")))
      .orderBy(desc(conversations.createdAt))
      .limit(1);
    return row;
  }

  async updateConversation(id: number, data: Partial<InsertConversation>): Promise<Conversation> {
    const [updated] = await db.update(conversations)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(conversations.id, id))
      .returning();
    return updated;
  }

  async getAllConversations(): Promise<ConversationWithMessages[]> {
    const convs = await db.select().from(conversations).orderBy(desc(conversations.updatedAt));
    return Promise.all(convs.map(async conv => ({
      ...conv,
      messages: await db.select().from(messages).where(eq(messages.conversationId, conv.id)),
      orders: await db.select().from(orders).where(eq(orders.conversationId, conv.id)),
    })));
  }

  // ── Messages ────────────────────────────────────────────────────────────────
  async addMessage(data: InsertMessage): Promise<Message> {
    const [msg] = await db.insert(messages).values({ ...data, createdAt: new Date() }).returning();
    return msg;
  }

  async getMessages(conversationId: number): Promise<Message[]> {
    return db.select().from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(messages.createdAt);
  }

  // ── Orders ──────────────────────────────────────────────────────────────────
  async createOrder(data: InsertOrder): Promise<Order> {
    const [order] = await db.insert(orders).values({ ...data, createdAt: new Date() }).returning();
    return order;
  }

  async updateOrder(id: number, data: Partial<InsertOrder>): Promise<Order> {
    const [updated] = await db.update(orders).set(data).where(eq(orders.id, id)).returning();
    return updated;
  }

  async getOrderByConversation(conversationId: number): Promise<Order | undefined> {
    const [row] = await db.select().from(orders)
      .where(eq(orders.conversationId, conversationId))
      .orderBy(desc(orders.createdAt))
      .limit(1);
    return row;
  }

  async getAllOrders(): Promise<Order[]> {
    return db.select().from(orders).orderBy(desc(orders.createdAt));
  }

  // ── Products ────────────────────────────────────────────────────────────────
  async upsertProduct(data: InsertProduct): Promise<Product> {
    const [existing] = await db.select().from(products).where(eq(products.qboItemId, data.qboItemId));
    if (existing) {
      const [updated] = await db.update(products).set({ ...data, syncedAt: new Date() })
        .where(eq(products.qboItemId, data.qboItemId)).returning();
      return updated;
    }
    const [created] = await db.insert(products).values({ ...data, syncedAt: new Date() }).returning();
    return created;
  }

  async getAllProducts(): Promise<Product[]> {
    return db.select().from(products).where(eq(products.active, true));
  }

  async getProductByQboId(qboItemId: string): Promise<Product | undefined> {
    const [row] = await db.select().from(products).where(eq(products.qboItemId, qboItemId));
    return row;
  }

  // ── Estimates ────────────────────────────────────────────────────────────────
  async createEstimate(data: InsertEstimate): Promise<Estimate> {
    const [est] = await db.insert(estimates).values({ ...data, createdAt: new Date() }).returning();
    return est;
  }

  async updateEstimate(id: number, data: Partial<InsertEstimate>): Promise<Estimate> {
    const [updated] = await db.update(estimates).set(data).where(eq(estimates.id, id)).returning();
    return updated;
  }

  async getEstimate(id: number): Promise<Estimate | undefined> {
    const [row] = await db.select().from(estimates).where(eq(estimates.id, id));
    return row;
  }

  async getEstimateByConversation(conversationId: number): Promise<Estimate | undefined> {
    const [row] = await db.select().from(estimates)
      .where(eq(estimates.conversationId, conversationId))
      .orderBy(desc(estimates.createdAt))
      .limit(1);
    return row;
  }

  async getAllEstimates(): Promise<Estimate[]> {
    return db.select().from(estimates).orderBy(desc(estimates.createdAt));
  }

  // ── Settings ────────────────────────────────────────────────────────────────
  async getSetting(key: string): Promise<string | null> {
    const [row] = await db.select().from(settings).where(eq(settings.key, key));
    return row?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value]
    );
  }

  // ── Flagged conversations ────────────────────────────────────────────────────
  async flagConversation(data: { conversationId: number, source: string, flagReason: string, flagDetail: string, customerMessage: string, botResponse: string, quotedAmount?: number, conversion?: string }): Promise<void> {
    await pool.query(
      `INSERT INTO flagged_conversations (conversation_id, source, flag_reason, flag_detail, customer_message, bot_response, quoted_amount, conversion)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [data.conversationId, data.source, data.flagReason, data.flagDetail, data.customerMessage, data.botResponse, data.quotedAmount ?? null, data.conversion ?? 'unknown']
    );
  }

  async updateFlagConversion(conversationId: number, conversion: 'converted' | 'abandoned'): Promise<void> {
    await pool.query(
      `UPDATE flagged_conversations SET conversion = $1 WHERE conversation_id = $2 AND conversion = 'unknown'`,
      [conversion, conversationId]
    );
  }

  async getPendingFlags(): Promise<any[]> {
    const result = await pool.query(
      `SELECT * FROM flagged_conversations WHERE status = 'pending' ORDER BY created_at DESC`
    );
    return result.rows;
  }

  async reviewFlag(id: number, status: 'approved' | 'dismissed'): Promise<void> {
    await pool.query(
      `UPDATE flagged_conversations SET status = $1, reviewed_at = NOW() WHERE id = $2`,
      [status, id]
    );
  }

  // ── Learned rules ────────────────────────────────────────────────────────────
  async addLearnedRule(ruleText: string, category: string, sourceFlagId?: number): Promise<void> {
    await pool.query(
      `INSERT INTO learned_rules (rule_text, category, source_flag_id) VALUES ($1, $2, $3)`,
      [ruleText, category, sourceFlagId ?? null]
    );
  }

  async getLearnedRules(): Promise<{ id: number, ruleText: string, category: string }[]> {
    const result = await pool.query(
      `SELECT id, rule_text, category FROM learned_rules WHERE active = true ORDER BY created_at ASC`
    );
    return result.rows.map((r: any) => ({ id: r.id, ruleText: r.rule_text, category: r.category }));
  }

  async deactivateLearnedRule(id: number): Promise<void> {
    await pool.query(
      `UPDATE learned_rules SET active = false WHERE id = $1`,
      [id]
    );
  }

  // ── Customer memory ──────────────────────────────────────────────────────────
  async upsertCustomerMemory(phone: string, data: Partial<{name:string, email:string, company:string, deliveryAddress:string, typicalBarSizes:string, typicalProducts:string, lastOrderSummary:string, orderCount:number, totalSpent:number, avgOrderValue:number, largestOrderValue:number, mostOrderedProduct:string, customerType:string, notes:string}>): Promise<void> {
    const setClauses: string[] = ['updated_at = NOW()'];
    const values: any[] = [phone];
    let paramIndex = 2;

    const fieldMap: Record<string, string> = {
      name: 'name',
      email: 'email',
      company: 'company',
      deliveryAddress: 'delivery_address',
      typicalBarSizes: 'typical_bar_sizes',
      typicalProducts: 'typical_products',
      lastOrderSummary: 'last_order_summary',
      orderCount: 'order_count',
      totalSpent: 'total_spent',
      avgOrderValue: 'avg_order_value',
      largestOrderValue: 'largest_order_value',
      mostOrderedProduct: 'most_ordered_product',
      customerType: 'customer_type',
      notes: 'notes',
    };

    for (const [jsKey, dbCol] of Object.entries(fieldMap)) {
      if (data[jsKey as keyof typeof data] !== undefined) {
        setClauses.push(`${dbCol} = $${paramIndex}`);
        values.push(data[jsKey as keyof typeof data]);
        paramIndex++;
      }
    }

    await pool.query(
      `INSERT INTO customer_memory (phone) VALUES ($1)
       ON CONFLICT (phone) DO UPDATE SET ${setClauses.join(', ')}`,
      values
    );
  }

  async getCustomerMemory(phone: string): Promise<any | null> {
    const result = await pool.query(
      `SELECT * FROM customer_memory WHERE phone = $1`,
      [phone]
    );
    if (result.rows.length === 0) return null;
    const r = result.rows[0];
    return {
      id: r.id,
      phone: r.phone,
      name: r.name,
      email: r.email,
      company: r.company,
      deliveryAddress: r.delivery_address,
      typicalBarSizes: r.typical_bar_sizes,
      typicalProducts: r.typical_products,
      lastOrderSummary: r.last_order_summary,
      orderCount: r.order_count,
      totalSpent: r.total_spent,
      avgOrderValue: r.avg_order_value,
      largestOrderValue: r.largest_order_value,
      mostOrderedProduct: r.most_ordered_product,
      customerType: r.customer_type,
      notes: r.notes,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  // Records a completed order and updates all order statistics atomically
  async recordOrderCompletion(phone: string, orderTotal: number, orderSummary: string, lineItems: Array<{name: string, qty: number}>): Promise<void> {
    // Determine most ordered product from this order's line items (highest qty, filter out delivery/tax lines)
    const productItems = lineItems.filter(i =>
      i.name &&
      !i.name.toLowerCase().includes('delivery') &&
      !i.name.toLowerCase().includes('tax')
    );
    const topItem = productItems.sort((a, b) => b.qty - a.qty)[0];
    const mostOrderedProduct = topItem?.name || null;

    // Upsert the record first if it doesn't exist, then atomically update stats
    await pool.query(
      `INSERT INTO customer_memory (phone) VALUES ($1) ON CONFLICT (phone) DO NOTHING`,
      [phone]
    );

    // Atomic update: recalculate running stats from current values
    await pool.query(
      `UPDATE customer_memory SET
        order_count = order_count + 1,
        total_spent = total_spent + $2,
        avg_order_value = (total_spent + $2) / (order_count + 1),
        largest_order_value = GREATEST(largest_order_value, $2),
        last_order_summary = $3,
        most_ordered_product = COALESCE($4, most_ordered_product),
        updated_at = NOW()
       WHERE phone = $1`,
      [phone, orderTotal, orderSummary, mostOrderedProduct]
    );
  }
}

export const storage = new Storage();
