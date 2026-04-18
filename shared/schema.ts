import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ── Conversations ─────────────────────────────────────────────────────────────
export const conversations = sqliteTable("conversations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  phone: text("phone").notNull(),
  customerName: text("customer_name"),
  customerEmail: text("customer_email"),
  customerCompany: text("customer_company"),
  deliveryAddress: text("delivery_address"),
  qboCustomerId: text("qbo_customer_id"),
  verified: integer("verified", { mode: "boolean" }).notNull().default(false), // true = confirmed existing QBO customer
  status: text("status").notNull().default("active"), // active | completed | abandoned
  stage: text("stage").notNull().default("greeting"), // greeting | collecting_info | ordering | confirming | invoiced | paid
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// ── Messages ──────────────────────────────────────────────────────────────────
export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  conversationId: integer("conversation_id").notNull().references(() => conversations.id),
  direction: text("direction").notNull(), // inbound | outbound
  body: text("body").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// ── Orders ────────────────────────────────────────────────────────────────────
export const orders = sqliteTable("orders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  conversationId: integer("conversation_id").notNull().references(() => conversations.id),
  qboInvoiceId: text("qbo_invoice_id"),
  qboInvoiceNumber: text("qbo_invoice_number"),
  paymentLink: text("payment_link"),
  lineItemsJson: text("line_items_json").notNull(), // JSON array of {name, qty, unitPrice, amount}
  subtotal: real("subtotal").notNull().default(0),
  deliveryFee: real("delivery_fee").notNull().default(0),
  deliveryMiles: real("delivery_miles"),
  total: real("total").notNull().default(0),
  deliveryType: text("delivery_type").notNull().default("pickup"), // pickup | delivery
  status: text("status").notNull().default("pending"), // pending | invoiced | paid | cancelled
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// ── Estimates (Plan Takeoff → QBO Estimate) ────────────────────────────────
export const estimates = sqliteTable("estimates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  conversationId: integer("conversation_id").notNull().references(() => conversations.id),
  qboEstimateId: text("qbo_estimate_id"),
  qboEstimateNumber: text("qbo_estimate_number"),
  qboEstimateLink: text("qbo_estimate_link"),
  lineItemsJson: text("line_items_json").notNull(),       // full takeoff line items
  fabricationJson: text("fabrication_json"),               // cut sheet details for fab items
  planPagesJson: text("plan_pages_json"),                  // image URLs of plan pages submitted
  takeoffNotesJson: text("takeoff_notes_json"),            // AI takeoff notes per page
  subtotal: real("subtotal").notNull().default(0),
  status: text("status").notNull().default("pending"),    // pending | sent | approved | declined
  cutSheetEmailedAt: integer("cut_sheet_emailed_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// ── QBO Products Cache ────────────────────────────────────────────────────────
export const products = sqliteTable("products", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  qboItemId: text("qbo_item_id").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  unitPrice: real("unit_price"),
  unitOfMeasure: text("unit_of_measure"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  syncedAt: integer("synced_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// ── Insert Schemas ────────────────────────────────────────────────────────────
export const insertConversationSchema = createInsertSchema(conversations).omit({ id: true, createdAt: true, updatedAt: true });
export const insertMessageSchema = createInsertSchema(messages).omit({ id: true, createdAt: true });
export const insertOrderSchema = createInsertSchema(orders).omit({ id: true, createdAt: true });
export const insertEstimateSchema = createInsertSchema(estimates).omit({ id: true, createdAt: true });
export const insertProductSchema = createInsertSchema(products).omit({ id: true });

// ── Types ─────────────────────────────────────────────────────────────────────
export type Conversation = typeof conversations.$inferSelect;
export type InsertConversation = z.infer<typeof insertConversationSchema>;
export type Message = typeof messages.$inferSelect;
export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type Order = typeof orders.$inferSelect;
export type InsertOrder = z.infer<typeof insertOrderSchema>;
export type Product = typeof products.$inferSelect;
export type InsertProduct = z.infer<typeof insertProductSchema>;
export type Estimate = typeof estimates.$inferSelect;
export type InsertEstimate = z.infer<typeof insertEstimateSchema>;

export type LineItem = {
  qboItemId: string;
  name: string;
  qty: number;
  unitPrice: number;
  amount: number;
};

export type FabItem = {
  mark: string;         // bar mark e.g. "B1"
  barSize: string;      // e.g. "#4"
  qty: number;          // number of pieces
  lengthFt: number;     // cut length in feet
  totalLF: number;      // qty * lengthFt
  weightLbs: number;    // total weight
  bendDescription: string; // e.g. "90-deg hook, 6" leg" or "Straight"
  stockLengthFt: number;   // stock bar length used (default 20)
  barsPerStock: number;    // how many pieces per stock bar
  stockBarsNeeded: number; // number of stock bars to order
};

export type ConversationWithMessages = Conversation & {
  messages: Message[];
  orders: Order[];
};
