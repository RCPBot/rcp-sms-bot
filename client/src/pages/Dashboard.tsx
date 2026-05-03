import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  MessageSquare, Clock, CheckCircle, DollarSign, Phone,
  Flag, BookOpen, Users, TrendingUp, AlertTriangle, CheckCircle2,
  XCircle, ChevronDown, ChevronUp, Plus, Trash2, ShoppingCart,
  Zap, BarChart2, Star
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from "@/components/ui/select";
import type { ConversationWithMessages, Order } from "@shared/schema";

// ─── helpers ─────────────────────────────────────────────────────────────────

function fmt(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function timeAgo(date: Date | string | null | undefined): string {
  if (!date) return "—";
  const d = new Date(typeof date === "number" ? date * 1000 : date);
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "").slice(-10);
  return digits.length === 10
    ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
    : phone;
}

function stageBadge(stage: string) {
  const map: Record<string, { label: string; color: string }> = {
    greeting:        { label: "New",        color: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30" },
    collecting_info: { label: "Info",       color: "bg-blue-500/20 text-blue-400 border-blue-500/30" },
    ordering:        { label: "Ordering",   color: "bg-purple-500/20 text-purple-400 border-purple-500/30" },
    confirming:      { label: "Confirming", color: "bg-orange-500/20 text-orange-400 border-orange-500/30" },
    invoiced:        { label: "Invoiced",   color: "bg-primary/20 text-primary border-primary/30" },
    paid:            { label: "Paid",       color: "bg-green-500/20 text-green-400 border-green-500/30" },
  };
  const s = map[stage] || { label: stage, color: "bg-muted text-muted-foreground border-border" };
  return (
    <span className={`text-xs px-2 py-0.5 rounded border font-medium ${s.color}`}>
      {s.label}
    </span>
  );
}

function customerTypeBadge(type: string | null) {
  const map: Record<string, string> = {
    contractor: "bg-blue-500/20 text-blue-400 border-blue-500/30",
    homeowner:  "bg-green-500/20 text-green-400 border-green-500/30",
    developer:  "bg-purple-500/20 text-purple-400 border-purple-500/30",
    unknown:    "bg-muted text-muted-foreground border-border",
  };
  const label = type || "unknown";
  const color = map[label] || map.unknown;
  return (
    <span className={`text-xs px-2 py-0.5 rounded border font-medium capitalize ${color}`}>
      {label}
    </span>
  );
}

function flagReasonLabel(reason: string) {
  const map: Record<string, string> = {
    bot_correction:       "Bot Corrected",
    price_dispute:        "Price Dispute",
    bot_said_i_dont_know: "Bot Said Dunno",
    customer_frustration: "Frustration",
    abandoned_mid_quote:  "Abandoned Quote",
  };
  return map[reason] || reason;
}

// ─── Tab definitions ─────────────────────────────────────────────────────────

const TABS = [
  { id: "revenue",   label: "Revenue",       icon: TrendingUp },
  { id: "chats",     label: "Live Chats",    icon: MessageSquare },
  { id: "flags",     label: "AI Flags",      icon: Flag },
  { id: "rules",     label: "Learned Rules", icon: BookOpen },
  { id: "customers", label: "Customers",     icon: Users },
] as const;

type TabId = typeof TABS[number]["id"];

// ─── Revenue Tab ─────────────────────────────────────────────────────────────

function RevenueTab() {
  const { data: orders = [], isLoading } = useQuery<(Order & { customerName?: string | null })[]>({
    queryKey: ["/api/orders"],
    queryFn: () => apiRequest("GET", "/api/orders").then(r => r.json()),
    refetchInterval: 30000,
  });

  const paid      = orders.filter(o => o.status === "paid");
  const invoiced  = orders.filter(o => o.status === "invoiced");
  const all       = orders;

  const totalRevenue    = paid.reduce((s, o) => s + (o.total ?? 0), 0);
  const invoicedValue   = invoiced.reduce((s, o) => s + (o.total ?? 0), 0);
  const avgOrder        = paid.length ? totalRevenue / paid.length : 0;
  const conversionRate  = all.length ? Math.round((paid.length / all.length) * 100) : 0;

  // Monthly breakdown
  const monthly: Record<string, number> = {};
  for (const o of paid) {
    const d = new Date(o.createdAt as any);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    monthly[key] = (monthly[key] || 0) + (o.total ?? 0);
  }
  const monthlyRows = Object.entries(monthly)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 6);

  return (
    <div className="space-y-6">
      {/* Hero revenue number */}
      <div className="rounded-xl border border-primary/30 bg-gradient-to-br from-primary/10 to-transparent p-6">
        <div className="flex items-center gap-3 mb-1">
          <DollarSign className="w-5 h-5 text-primary" />
          <span className="text-sm text-muted-foreground font-medium uppercase tracking-wider">Total AI Channel Revenue</span>
        </div>
        <div className="text-5xl font-bold text-primary mt-2">{isLoading ? "—" : fmt(totalRevenue)}</div>
        <div className="text-sm text-muted-foreground mt-2">From {paid.length} paid order{paid.length !== 1 ? "s" : ""} via SMS &amp; web chat</div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: "Total Orders",     value: all.length,            color: "text-foreground",  sub: "all time" },
          { label: "Invoiced (Unpaid)", value: fmt(invoicedValue),   color: "text-yellow-400",  sub: `${invoiced.length} open` },
          { label: "Avg Order Value",  value: fmt(avgOrder),         color: "text-blue-400",    sub: "paid orders" },
          { label: "Conversion Rate",  value: `${conversionRate}%`,  color: "text-green-400",   sub: "orders → paid" },
        ].map(({ label, value, color, sub }) => (
          <Card key={label} className="bg-card border-border">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
              <p className="text-xs text-muted-foreground/60 mt-0.5">{sub}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Monthly breakdown + recent orders side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Monthly */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-foreground flex items-center gap-2">
              <BarChart2 className="w-4 h-4 text-primary" />
              Monthly Revenue
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 pb-4">
            {monthlyRows.length === 0 ? (
              <div className="px-6 py-8 text-center text-muted-foreground text-sm">No paid orders yet</div>
            ) : (
              <div className="px-6 space-y-3 pt-2">
                {monthlyRows.map(([month, total]) => {
                  const pct = monthlyRows[0][1] > 0 ? (total / monthlyRows[0][1]) * 100 : 0;
                  const [y, m] = month.split("-");
                  const label = new Date(+y, +m - 1).toLocaleString("en-US", { month: "short", year: "numeric" });
                  return (
                    <div key={month}>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-muted-foreground">{label}</span>
                        <span className="font-medium text-foreground">{fmt(total)}</span>
                      </div>
                      <div className="h-2 bg-secondary rounded-full overflow-hidden">
                        <div
                          className="h-full bg-primary rounded-full transition-all"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent paid orders */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-foreground flex items-center gap-2">
              <ShoppingCart className="w-4 h-4 text-primary" />
              Recent Paid Orders
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {paid.length === 0 ? (
              <div className="px-6 py-8 text-center text-muted-foreground text-sm">No paid orders yet</div>
            ) : (
              <div className="divide-y divide-border">
                {paid.slice(0, 8).map(o => (
                  <div key={o.id} className="px-6 py-3 flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium text-foreground">
                        {(o as any).customerName || formatPhone((o as any).customerPhone || "")}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        #{o.qboInvoiceNumber || o.id} · {timeAgo(o.createdAt as any)}
                      </div>
                    </div>
                    <div className="text-sm font-bold text-green-400">{fmt(o.total)}</div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ─── Live Chats Tab ───────────────────────────────────────────────────────────

function ChatsTab() {
  const { data: conversations = [], isLoading } = useQuery<ConversationWithMessages[]>({
    queryKey: ["/api/conversations"],
    queryFn: () => apiRequest("GET", "/api/conversations").then(r => r.json()),
    refetchInterval: 10000,
  });

  const active    = conversations.filter(c => c.status === "active" && c.stage !== "invoiced" && c.stage !== "paid");
  const completed = conversations.filter(c => c.status === "completed");
  const invoiced  = conversations.filter(c => c.stage === "invoiced" || c.stage === "paid");

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: "Active Now",    value: active.length,        icon: MessageSquare, color: "text-primary" },
          { label: "Total Convos",  value: conversations.length, icon: Phone,         color: "text-blue-400" },
          { label: "Completed",     value: completed.length,     icon: CheckCircle,   color: "text-green-400" },
          { label: "Invoiced",      value: invoiced.length,      icon: DollarSign,    color: "text-yellow-400" },
        ].map(({ label, value, icon: Icon, color }) => (
          <Card key={label} className="bg-card border-border">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
                </div>
                <Icon className={`w-8 h-8 ${color} opacity-40`} />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Conversation list */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base text-foreground">Conversations</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground text-sm">Loading...</div>
          ) : conversations.length === 0 ? (
            <div className="p-12 text-center">
              <MessageSquare className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-muted-foreground text-sm">No conversations yet.</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {conversations.map(conv => {
                const lastMsg = conv.messages?.[conv.messages.length - 1];
                return (
                  <div
                    key={conv.id}
                    onClick={() => { window.location.hash = `/conversations/${conv.id}`; }}
                    className="flex items-center gap-4 px-6 py-4 hover:bg-secondary/50 transition-colors cursor-pointer"
                  >
                    <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0">
                      <span className="text-primary font-bold text-sm">
                        {conv.customerName ? conv.customerName[0].toUpperCase() : "#"}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-sm text-foreground">
                          {conv.customerName || formatPhone(conv.phone)}
                        </span>
                        {stageBadge(conv.stage)}
                      </div>
                      <div className="text-xs text-muted-foreground truncate max-w-xs">
                        {conv.customerCompany && (
                          <span className="text-muted-foreground/70">{conv.customerCompany} · </span>
                        )}
                        {lastMsg?.body || "No messages"}
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <div className="text-xs text-muted-foreground flex items-center gap-1 justify-end">
                        <Clock className="w-3 h-3" />
                        {timeAgo(conv.updatedAt)}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        {conv.messages?.length || 0} msgs
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── AI Flags Tab ─────────────────────────────────────────────────────────────

function FlagsTab() {
  const qc = useQueryClient();
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [ruleText, setRuleText] = useState<Record<number, string>>({});
  const [ruleCategory, setRuleCategory] = useState<Record<number, string>>({});

  const { data: flags = [], isLoading } = useQuery<any[]>({
    queryKey: ["/api/admin/flags"],
    queryFn: () => apiRequest("GET", "/api/admin/flags").then(r => r.json()),
    refetchInterval: 30000,
  });

  const approveMut = useMutation({
    mutationFn: ({ id, ruleText, category }: { id: number; ruleText: string; category: string }) =>
      apiRequest("POST", `/api/admin/flags/${id}/approve`, { ruleText, category }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/admin/flags"] }),
  });

  const dismissMut = useMutation({
    mutationFn: (id: number) =>
      apiRequest("POST", `/api/admin/flags/${id}/dismiss`).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/admin/flags"] }),
  });

  const pending = flags.filter((f: any) => f.status === "pending");
  const reviewed = flags.filter((f: any) => f.status !== "pending");

  const FlagCard = ({ flag, showActions }: { flag: any; showActions: boolean }) => {
    const isExpanded = expandedId === flag.id;
    const reasonColor: Record<string, string> = {
      bot_correction:       "bg-red-500/20 text-red-400 border-red-500/30",
      price_dispute:        "bg-orange-500/20 text-orange-400 border-orange-500/30",
      bot_said_i_dont_know: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
      customer_frustration: "bg-red-500/20 text-red-400 border-red-500/30",
      abandoned_mid_quote:  "bg-muted text-muted-foreground border-border",
    };
    return (
      <div className="border border-border rounded-lg overflow-hidden">
        <div
          className="flex items-start gap-4 p-4 cursor-pointer hover:bg-secondary/30 transition-colors"
          onClick={() => setExpandedId(isExpanded ? null : flag.id)}
        >
          <AlertTriangle className="w-4 h-4 text-yellow-400 mt-0.5 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium text-foreground">
                {flag.customerName || formatPhone(flag.phone || "")}
              </span>
              <span className={`text-xs px-2 py-0.5 rounded border font-medium ${reasonColor[flag.flagReason] || "bg-muted text-muted-foreground border-border"}`}>
                {flagReasonLabel(flag.flagReason)}
              </span>
              {flag.quotedAmount > 0 && (
                <span className="text-xs text-muted-foreground">Quote: {fmt(flag.quotedAmount)}</span>
              )}
            </div>
            <div className="text-xs text-muted-foreground mt-1 truncate">
              {flag.triggerMessage}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="text-xs text-muted-foreground">{timeAgo(flag.createdAt)}</span>
            {isExpanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
          </div>
        </div>

        {isExpanded && (
          <div className="border-t border-border bg-secondary/20 p-4 space-y-4">
            {/* Conversation snippet */}
            {flag.conversationSnippet && (
              <div>
                <div className="text-xs text-muted-foreground font-medium mb-2 uppercase tracking-wider">Conversation Snippet</div>
                <pre className="text-xs text-foreground bg-card border border-border rounded p-3 whitespace-pre-wrap font-mono max-h-48 overflow-y-auto">
                  {flag.conversationSnippet}
                </pre>
              </div>
            )}

            {showActions && (
              <div className="space-y-3">
                <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                  Turn this into a learned rule (optional)
                </div>
                <div className="grid grid-cols-1 gap-2">
                  <Select
                    value={ruleCategory[flag.id] || ""}
                    onValueChange={v => setRuleCategory(prev => ({ ...prev, [flag.id]: v }))}
                  >
                    <SelectTrigger className="h-8 text-xs bg-card border-border">
                      <SelectValue placeholder="Category" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="pricing">Pricing</SelectItem>
                      <SelectItem value="product">Product</SelectItem>
                      <SelectItem value="behavior">Bot Behavior</SelectItem>
                      <SelectItem value="policy">Policy</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                  <Textarea
                    placeholder="Write the rule the bot should follow (e.g. 'When customer asks about X, always say Y')"
                    className="text-xs h-20 resize-none bg-card border-border"
                    value={ruleText[flag.id] || ""}
                    onChange={e => setRuleText(prev => ({ ...prev, [flag.id]: e.target.value }))}
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    className="h-8 text-xs bg-primary hover:bg-primary/90 text-primary-foreground"
                    disabled={approveMut.isPending}
                    onClick={() => {
                      const text = ruleText[flag.id] || "";
                      const cat = ruleCategory[flag.id] || "other";
                      approveMut.mutate({ id: flag.id, ruleText: text || "Flagged — review manually", category: cat });
                    }}
                  >
                    <CheckCircle2 className="w-3 h-3 mr-1" />
                    {ruleText[flag.id]?.trim() ? "Approve + Add Rule" : "Mark Reviewed"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs border-border"
                    disabled={dismissMut.isPending}
                    onClick={() => dismissMut.mutate(flag.id)}
                  >
                    <XCircle className="w-3 h-3 mr-1" />
                    Dismiss
                  </Button>
                </div>
              </div>
            )}

            {!showActions && (
              <div className="text-xs text-muted-foreground">
                Status: <span className="font-medium capitalize text-foreground">{flag.status}</span>
                {flag.reviewedAt && ` · Reviewed ${timeAgo(flag.reviewedAt)}`}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        {[
          { label: "Pending Review", value: pending.length,  color: "text-yellow-400" },
          { label: "Reviewed",       value: reviewed.length, color: "text-green-400" },
          { label: "Total Flagged",  value: flags.length,    color: "text-foreground" },
        ].map(({ label, value, color }) => (
          <Card key={label} className="bg-card border-border">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {isLoading ? (
        <div className="text-center text-muted-foreground text-sm py-8">Loading flags...</div>
      ) : (
        <div className="space-y-6">
          {pending.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-foreground mb-3 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-yellow-400" />
                Needs Review ({pending.length})
              </h3>
              <div className="space-y-3">
                {pending.map(f => <FlagCard key={f.id} flag={f} showActions={true} />)}
              </div>
            </div>
          )}

          {pending.length === 0 && (
            <div className="text-center py-12">
              <CheckCircle className="w-12 h-12 text-green-400/30 mx-auto mb-3" />
              <p className="text-muted-foreground text-sm">All caught up — no pending flags.</p>
            </div>
          )}

          {reviewed.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-muted-foreground mb-3">
                Recently Reviewed ({reviewed.length})
              </h3>
              <div className="space-y-2">
                {reviewed.slice(0, 5).map(f => <FlagCard key={f.id} flag={f} showActions={false} />)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Learned Rules Tab ────────────────────────────────────────────────────────

function RulesTab() {
  const qc = useQueryClient();
  const [newText, setNewText] = useState("");
  const [newCategory, setNewCategory] = useState("behavior");
  const [adding, setAdding] = useState(false);

  const { data: rules = [], isLoading } = useQuery<any[]>({
    queryKey: ["/api/admin/learned-rules"],
    queryFn: () => apiRequest("GET", "/api/admin/learned-rules").then(r => r.json()),
    refetchInterval: 60000,
  });

  const addMut = useMutation({
    mutationFn: ({ ruleText, category }: { ruleText: string; category: string }) =>
      apiRequest("POST", "/api/admin/learned-rules", { ruleText, category }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/admin/learned-rules"] });
      setNewText("");
      setAdding(false);
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) =>
      apiRequest("DELETE", `/api/admin/learned-rules/${id}`).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/admin/learned-rules"] }),
  });

  const categoryColor: Record<string, string> = {
    pricing:  "bg-green-500/20 text-green-400 border-green-500/30",
    product:  "bg-blue-500/20 text-blue-400 border-blue-500/30",
    behavior: "bg-purple-500/20 text-purple-400 border-purple-500/30",
    policy:   "bg-orange-500/20 text-orange-400 border-orange-500/30",
    other:    "bg-muted text-muted-foreground border-border",
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-foreground">Active Learned Rules</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            These inject into both bots' system prompts at runtime — no code deploy needed.
          </p>
        </div>
        <Button
          size="sm"
          className="h-8 text-xs bg-primary hover:bg-primary/90 text-primary-foreground"
          onClick={() => setAdding(v => !v)}
        >
          <Plus className="w-3 h-3 mr-1" />
          Add Rule
        </Button>
      </div>

      {/* Add rule form */}
      {adding && (
        <Card className="bg-card border-primary/30">
          <CardContent className="p-4 space-y-3">
            <Select value={newCategory} onValueChange={setNewCategory}>
              <SelectTrigger className="h-8 text-xs bg-secondary border-border">
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pricing">Pricing</SelectItem>
                <SelectItem value="product">Product</SelectItem>
                <SelectItem value="behavior">Bot Behavior</SelectItem>
                <SelectItem value="policy">Policy</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
            <Textarea
              placeholder="Write the rule (e.g. '#7 rebar is $XX per stick')"
              className="text-xs h-20 resize-none bg-secondary border-border"
              value={newText}
              onChange={e => setNewText(e.target.value)}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                className="h-8 text-xs bg-primary hover:bg-primary/90 text-primary-foreground"
                disabled={!newText.trim() || addMut.isPending}
                onClick={() => addMut.mutate({ ruleText: newText, category: newCategory })}
              >
                Save Rule
              </Button>
              <Button size="sm" variant="outline" className="h-8 text-xs border-border" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Rules list */}
      {isLoading ? (
        <div className="text-center text-muted-foreground text-sm py-8">Loading rules...</div>
      ) : rules.length === 0 ? (
        <div className="text-center py-12">
          <BookOpen className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-muted-foreground text-sm">No learned rules yet.</p>
          <p className="text-muted-foreground/60 text-xs mt-1">
            Rules are added when you approve a flagged conversation or click "Add Rule" above.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {rules.map((rule: any) => (
            <div key={rule.id} className="flex items-start gap-3 p-4 rounded-lg border border-border bg-card hover:bg-secondary/30 transition-colors">
              <Zap className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className={`text-xs px-2 py-0.5 rounded border font-medium capitalize ${categoryColor[rule.category] || categoryColor.other}`}>
                    {rule.category}
                  </span>
                  <span className="text-xs text-muted-foreground">{timeAgo(rule.createdAt)}</span>
                  {rule.sourceFlagId && (
                    <span className="text-xs text-muted-foreground/60">from flag #{rule.sourceFlagId}</span>
                  )}
                </div>
                <p className="text-sm text-foreground">{rule.ruleText}</p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0 text-muted-foreground hover:text-red-400 flex-shrink-0"
                onClick={() => deleteMut.mutate(rule.id)}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Customers Tab ────────────────────────────────────────────────────────────

function CustomersTab() {
  const [search, setSearch] = useState("");

  const { data: customers = [], isLoading } = useQuery<any[]>({
    queryKey: ["/api/admin/customer-memory"],
    queryFn: () => apiRequest("GET", "/api/admin/customer-memory").then(r => r.json()),
    refetchInterval: 60000,
  });

  const filtered = customers.filter(c => {
    const q = search.toLowerCase();
    return (
      !q ||
      c.name?.toLowerCase().includes(q) ||
      c.phone?.includes(q) ||
      c.company?.toLowerCase().includes(q) ||
      c.customerType?.toLowerCase().includes(q)
    );
  });

  const totalCustomers   = customers.length;
  const contractors      = customers.filter(c => c.customerType === "contractor").length;
  const totalLifetimeRev = customers.reduce((s, c) => s + (c.totalSpent || 0), 0);
  const repeatCustomers  = customers.filter(c => (c.orderCount || 0) > 1).length;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: "Total Customers",   value: totalCustomers,       color: "text-foreground" },
          { label: "Repeat Customers",  value: repeatCustomers,      color: "text-primary" },
          { label: "Contractors",       value: contractors,          color: "text-blue-400" },
          { label: "Lifetime Revenue",  value: fmt(totalLifetimeRev),color: "text-green-400" },
        ].map(({ label, value, color }) => (
          <Card key={label} className="bg-card border-border">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className={`text-xl font-bold mt-1 ${color}`}>{value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-3">
            <CardTitle className="text-base text-foreground flex-1">Customer Profiles</CardTitle>
            <Input
              className="h-8 w-48 text-xs bg-secondary border-border"
              placeholder="Search name, phone, type…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground text-sm">Loading customers...</div>
          ) : filtered.length === 0 ? (
            <div className="p-12 text-center">
              <Users className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-muted-foreground text-sm">
                {search ? "No customers match that search." : "No customer profiles yet."}
              </p>
              <p className="text-muted-foreground/60 text-xs mt-1">
                Profiles build automatically as customers interact with the bot.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className="px-6 py-3 text-xs font-medium text-muted-foreground">Customer</th>
                    <th className="px-4 py-3 text-xs font-medium text-muted-foreground">Type</th>
                    <th className="px-4 py-3 text-xs font-medium text-muted-foreground">Orders</th>
                    <th className="px-4 py-3 text-xs font-medium text-muted-foreground">Total Spent</th>
                    <th className="px-4 py-3 text-xs font-medium text-muted-foreground">Avg Order</th>
                    <th className="px-4 py-3 text-xs font-medium text-muted-foreground">Top Product</th>
                    <th className="px-4 py-3 text-xs font-medium text-muted-foreground">Last Seen</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filtered.map(c => (
                    <tr key={c.id} className="hover:bg-secondary/30 transition-colors">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0">
                            <span className="text-primary font-bold text-xs">
                              {c.name ? c.name[0].toUpperCase() : "#"}
                            </span>
                          </div>
                          <div>
                            <div className="font-medium text-foreground text-sm">
                              {c.name || "—"}
                              {(c.orderCount || 0) > 1 && (
                                <Star className="w-3 h-3 text-yellow-400 inline ml-1" />
                              )}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {formatPhone(c.phone)}
                            </div>
                            {c.company && (
                              <div className="text-xs text-muted-foreground/70">{c.company}</div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-4">{customerTypeBadge(c.customerType)}</td>
                      <td className="px-4 py-4">
                        <span className="font-medium text-foreground">{c.orderCount || 0}</span>
                      </td>
                      <td className="px-4 py-4">
                        <span className="font-medium text-green-400">{fmt(c.totalSpent || 0)}</span>
                      </td>
                      <td className="px-4 py-4">
                        <span className="text-muted-foreground">{fmt(c.avgOrderValue || 0)}</span>
                      </td>
                      <td className="px-4 py-4">
                        <span className="text-xs text-muted-foreground">
                          {c.mostOrderedProduct || "—"}
                        </span>
                      </td>
                      <td className="px-4 py-4">
                        <span className="text-xs text-muted-foreground">{timeAgo(c.updatedAt)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState<TabId>("revenue");

  // Badge counts
  const { data: flags = [] } = useQuery<any[]>({
    queryKey: ["/api/admin/flags"],
    queryFn: () => apiRequest("GET", "/api/admin/flags").then(r => r.json()),
    refetchInterval: 30000,
  });
  const { data: conversations = [] } = useQuery<ConversationWithMessages[]>({
    queryKey: ["/api/conversations"],
    queryFn: () => apiRequest("GET", "/api/conversations").then(r => r.json()),
    refetchInterval: 10000,
  });

  const pendingFlags   = flags.filter((f: any) => f.status === "pending").length;
  const activeChats    = conversations.filter(c => c.status === "active" && c.stage !== "invoiced" && c.stage !== "paid").length;

  const badges: Partial<Record<TabId, number>> = {
    flags: pendingFlags,
    chats: activeChats,
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <img
          src="https://ai.rebarconcreteproducts.com/corebuild_ai_logo.png"
          alt="CoreBuild AI"
          className="h-8 w-auto object-contain"
        />
        <div>
          <h1 className="text-xl font-bold text-foreground">AI Channel Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Rebar Concrete Products — SMS &amp; Web Chat Management</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {TABS.map(({ id, label, icon: Icon }) => {
          const count = badges[id];
          const isActive = activeTab === id;
          return (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors relative -mb-px ${
                isActive
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
              }`}
            >
              <Icon className="w-4 h-4" />
              {label}
              {count != null && count > 0 && (
                <span className="ml-1 bg-red-500 text-white text-xs rounded-full px-1.5 py-0.5 leading-none">
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div>
        {activeTab === "revenue"   && <RevenueTab />}
        {activeTab === "chats"     && <ChatsTab />}
        {activeTab === "flags"     && <FlagsTab />}
        {activeTab === "rules"     && <RulesTab />}
        {activeTab === "customers" && <CustomersTab />}
      </div>
    </div>
  );
}
