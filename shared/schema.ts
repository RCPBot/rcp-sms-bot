import { pgTable, text, integer, real, boolean, serial, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ── Conversations ─────────────────────────────────────────────────────────────
export const conversations = pgTable("conversations", {
  id: serial("id").primaryKey(),
  phone: text("phone").notNull(),
  customerName: text("customer_name"),
  customerEmail: text("customer_email"),
  customerCompany: text("customer_company"),
  deliveryAddress: text("delivery_address"),
  projectName: text("project_name"),
  projectAddress: text("project_address"),
  qboCustomerId: text("qbo_customer_id"),
  verified: boolean("verified").notNull().default(false),
  status: text("status").notNull().default("active"), // active | completed | abandoned
  stage: text("stage").notNull().default("greeting"), // greeting | collecting_info | ordering | confirming | invoiced | paid
  pendingImagesJson: text("pending_images_json"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ── Messages ──────────────────────────────────────────────────────────────────
export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull().references(() => conversations.id),
  direction: text("direction").notNull(), // inbound | outbound
  body: text("body").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

// ── Orders ────────────────────────────────────────────────────────────────────
export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull().references(() => conversations.id),
  qboInvoiceId: text("qbo_invoice_id"),
  qboInvoiceNumber: text("qbo_invoice_number"),
  paymentLink: text("payment_link"),
  lineItemsJson: text("line_items_json").notNull(),
  subtotal: real("subtotal").notNull().default(0),
  deliveryFee: real("delivery_fee").notNull().default(0),
  deliveryMiles: real("delivery_miles"),
  total: real("total").notNull().default(0),
  deliveryType: text("delivery_type").notNull().default("pickup"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ── Estimates ─────────────────────────────────────────────────────────────────
export const estimates = pgTable("estimates", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull().references(() => conversations.id),
  qboEstimateId: text("qbo_estimate_id"),
  qboEstimateNumber: text("qbo_estimate_number"),
  qboEstimateLink: text("qbo_estimate_link"),
  lineItemsJson: text("line_items_json").notNull(),
  fabricationJson: text("fabrication_json"),
  planPagesJson: text("plan_pages_json"),
  takeoffNotesJson: text("takeoff_notes_json"),
  subtotal: real("subtotal").notNull().default(0),
  status: text("status").notNull().default("pending"),
  cutSheetEmailedAt: timestamp("cut_sheet_emailed_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ── QBO Products Cache ────────────────────────────────────────────────────────
export const products = pgTable("products", {
  id: serial("id").primaryKey(),
  qboItemId: text("qbo_item_id").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  unitPrice: real("unit_price"),
  unitOfMeasure: text("unit_of_measure"),
  active: boolean("active").notNull().default(true),
  syncedAt: timestamp("synced_at").defaultNow(),
});

// ── Settings (key-value) ──────────────────────────────────────────────────────
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// ── Flagged Conversations ─────────────────────────────────────────────────────
export const flaggedConversations = pgTable("flagged_conversations", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").references(() => conversations.id),
  source: text("source").notNull(), // 'sms' | 'web'
  flagReason: text("flag_reason").notNull(), // 'customer_correction' | 'bot_claimed_wrong' | 'unanswered_question' | 'abandoned_mid_quote'
  flagDetail: text("flag_detail").notNull(),
  customerMessage: text("customer_message").notNull(),
  botResponse: text("bot_response").notNull(),
  status: text("status").notNull().default("pending"), // 'pending' | 'approved' | 'dismissed'
  quotedAmount: real("quoted_amount"),           // price quoted when flag was triggered (if any)
  conversion: text("conversion"),                // 'converted' | 'abandoned' | 'unknown'
  reviewedAt: timestamp("reviewed_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ── Learned Rules ─────────────────────────────────────────────────────────────
export const learnedRules = pgTable("learned_rules", {
  id: serial("id").primaryKey(),
  ruleText: text("rule_text").notNull(),
  sourceFlagId: integer("source_flag_id").references(() => flaggedConversations.id),
  category: text("category").notNull(), // 'product' | 'pricing' | 'behavior' | 'correction'
  addedBy: text("added_by").notNull().default("brian"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

// ── Customer Memory ───────────────────────────────────────────────────────────
export const customerMemory = pgTable("customer_memory", {
  id: serial("id").primaryKey(),
  phone: text("phone").notNull().unique(),
  name: text("name"),
  email: text("email"),
  company: text("company"),
  deliveryAddress: text("delivery_address"),
  typicalBarSizes: text("typical_bar_sizes"),
  typicalProducts: text("typical_products"),
  lastOrderSummary: text("last_order_summary"),
  orderCount: integer("order_count").notNull().default(0),
  totalSpent: real("total_spent").notNull().default(0),
  avgOrderValue: real("avg_order_value").notNull().default(0),
  largestOrderValue: real("largest_order_value").notNull().default(0),
  mostOrderedProduct: text("most_ordered_product"),
  customerType: text("customer_type"),              // 'contractor' | 'homeowner' | 'developer' | 'unknown'
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
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
  description?: string;
  qty: number;
  unitPrice: number;
  amount: number;
};

export type FabItem = {
  mark: string;
  barSize: string;
  qty: number;
  lengthFt: number;
  totalLF: number;
  weightLbs: number;
  bendDescription: string;
  stockLengthFt: number;
  barsPerStock: number;
  stockBarsNeeded: number;
};

export type ConversationWithMessages = Conversation & {
  messages: Message[];
  orders: Order[];
};
