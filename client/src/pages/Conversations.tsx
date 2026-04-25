import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useState, useMemo } from "react";
import { Link } from "wouter";
import {
  MessageSquare, Search, ChevronDown, ChevronUp,
  AlertTriangle, CheckCircle, Clock, DollarSign, Phone, Mail, Building
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { ConversationWithMessages } from "@shared/schema";

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatPhone(phone: string): string {
  const d = phone.replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}` : phone;
}

function formatTime(date: string | Date | null | undefined): string {
  if (!date) return "—";
  const d = new Date(date as string);
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true
  });
}

function timeAgo(date: string | Date | null | undefined): string {
  if (!date) return "—";
  const secs = Math.floor((Date.now() - new Date(date as string).getTime()) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

// Frustration signals — short messages expressing dissatisfaction
const FRUSTRATION_RE = /\b(wrong|incorrect|mistake|error|fix|change|no|not right|that'?s? not|confused|help|what|why|again|still|same|issue|problem|broken|fail|didn'?t|doesn'?t|won'?t|can'?t)\b/i;

function getFrustrationScore(messages: any[]): number {
  // Count inbound messages that look frustrated
  const inbound = messages.filter(m => m.direction === "inbound");
  let score = 0;
  for (const msg of inbound) {
    if (FRUSTRATION_RE.test(msg.body)) score++;
    // Short "yes" "no" repeated many times = confusion
  }
  // Penalty for many total messages (long unresolved conversations)
  if (messages.length > 20) score++;
  if (messages.length > 35) score++;
  return score;
}

function stageBadge(stage: string) {
  const map: Record<string, { label: string; color: string }> = {
    greeting:        { label: "New",          color: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30" },
    collecting_info: { label: "Info",         color: "bg-blue-500/20 text-blue-400 border-blue-500/30" },
    ordering:        { label: "Ordering",     color: "bg-purple-500/20 text-purple-400 border-purple-500/30" },
    confirming:      { label: "Confirming",   color: "bg-orange-500/20 text-orange-400 border-orange-500/30" },
    invoice_review:  { label: "Review",       color: "bg-orange-500/20 text-orange-400 border-orange-500/30" },
    invoiced:        { label: "Invoiced",     color: "bg-primary/20 text-primary border-primary/30" },
    paid:            { label: "Paid",         color: "bg-green-500/20 text-green-400 border-green-500/30" },
  };
  const s = map[stage] || { label: stage, color: "bg-muted text-muted-foreground border-border" };
  return (
    <span className={`text-xs px-2 py-0.5 rounded border font-medium ${s.color}`}>
      {s.label}
    </span>
  );
}

// ── Conversation Row (expandable) ─────────────────────────────────────────────

function ConvRow({ conv }: { conv: ConversationWithMessages }) {
  const [expanded, setExpanded] = useState(false);
  const messages: any[] = conv.messages || [];
  const lastMsg = messages[messages.length - 1];
  const frustration = getFrustrationScore(messages);

  return (
    <div className="border-b border-border last:border-0">
      {/* Summary row */}
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full text-left flex items-start gap-4 px-5 py-4 hover:bg-secondary/40 transition-colors"
      >
        {/* Avatar */}
        <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 text-sm font-bold
          ${frustration >= 3 ? "bg-red-500/20 text-red-400" : frustration >= 1 ? "bg-yellow-500/20 text-yellow-400" : "bg-primary/20 text-primary"}`}>
          {conv.customerName ? conv.customerName[0].toUpperCase() : "#"}
        </div>

        {/* Core info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
            <span className="font-semibold text-sm text-foreground">
              {conv.customerName || formatPhone(conv.phone)}
            </span>
            {stageBadge(conv.stage)}
            {frustration >= 3 && (
              <span className="flex items-center gap-1 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded px-1.5 py-0.5">
                <AlertTriangle className="w-3 h-3" /> Frustrated
              </span>
            )}
            {frustration === 1 || frustration === 2 ? (
              <span className="flex items-center gap-1 text-xs text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 rounded px-1.5 py-0.5">
                <AlertTriangle className="w-3 h-3" /> Watch
              </span>
            ) : null}
          </div>
          <div className="text-xs text-muted-foreground truncate max-w-lg">
            {conv.customerCompany && <span className="mr-1 text-muted-foreground/60">{conv.customerCompany} ·</span>}
            <span className={lastMsg?.direction === "inbound" ? "text-foreground/80" : ""}>
              {lastMsg?.body?.slice(0, 100) || "No messages"}
            </span>
          </div>
        </div>

        {/* Right side */}
        <div className="flex-shrink-0 text-right flex flex-col items-end gap-1">
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="w-3 h-3" />
            {timeAgo(conv.updatedAt)}
          </div>
          <div className="text-xs text-muted-foreground">{messages.length} msgs</div>
          {expanded ? <ChevronUp className="w-3 h-3 text-muted-foreground mt-1" /> : <ChevronDown className="w-3 h-3 text-muted-foreground mt-1" />}
        </div>
      </button>

      {/* Expanded chat view */}
      {expanded && (
        <div className="border-t border-border bg-background/50">
          {/* Customer meta */}
          <div className="flex flex-wrap gap-4 px-5 py-3 border-b border-border/50 text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{formatPhone(conv.phone)}</span>
            {conv.customerEmail && <span className="flex items-center gap-1"><Mail className="w-3 h-3" />{conv.customerEmail}</span>}
            {conv.customerCompany && <span className="flex items-center gap-1"><Building className="w-3 h-3" />{conv.customerCompany}</span>}
            {conv.deliveryAddress && <span className="flex items-center gap-1">📍 {conv.deliveryAddress}</span>}
            <span className="ml-auto">
              <Link href={`/conversations/${conv.id}`}>
                <a className="text-primary hover:underline">Open full view →</a>
              </Link>
            </span>
          </div>

          {/* Message thread */}
          <div className="px-5 py-4 space-y-2 max-h-96 overflow-y-auto">
            {messages.length === 0 && (
              <p className="text-xs text-muted-foreground italic">No messages</p>
            )}
            {messages.map((msg: any) => (
              <div
                key={msg.id}
                className={`flex ${msg.direction === "outbound" ? "justify-end" : "justify-start"}`}
              >
                <div className={`max-w-sm rounded-2xl px-3 py-2 text-xs ${
                  msg.direction === "outbound"
                    ? "bg-primary text-primary-foreground rounded-tr-sm"
                    : "bg-secondary text-foreground rounded-tl-sm"
                }`}>
                  <p className="whitespace-pre-wrap leading-relaxed">{msg.body}</p>
                  <p className={`text-[10px] mt-1 ${msg.direction === "outbound" ? "text-primary-foreground/50" : "text-muted-foreground"}`}>
                    {formatTime(msg.createdAt)}
                    {FRUSTRATION_RE.test(msg.body) && msg.direction === "inbound" && (
                      <span className="ml-1 text-yellow-400">⚠</span>
                    )}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function Conversations() {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "invoiced" | "frustrated">("all");

  const { data: conversations = [], isLoading } = useQuery<ConversationWithMessages[]>({
    queryKey: ["/api/conversations"],
    queryFn: () => apiRequest("GET", "/api/conversations").then(r => r.json()),
    refetchInterval: 15000,
  });

  const filtered = useMemo(() => {
    let list = [...conversations].sort((a, b) =>
      new Date(b.updatedAt as string).getTime() - new Date(a.updatedAt as string).getTime()
    );

    if (filter === "active") list = list.filter(c => c.status === "active" && c.stage !== "invoiced");
    if (filter === "invoiced") list = list.filter(c => c.stage === "invoiced" || c.stage === "paid");
    if (filter === "frustrated") list = list.filter(c => getFrustrationScore(c.messages || []) >= 2);

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(c =>
        (c.customerName || "").toLowerCase().includes(q) ||
        (c.customerEmail || "").toLowerCase().includes(q) ||
        (c.customerCompany || "").toLowerCase().includes(q) ||
        c.phone.includes(q) ||
        (c.messages || []).some((m: any) => m.body.toLowerCase().includes(q))
      );
    }

    return list;
  }, [conversations, search, filter]);

  const frustratedCount = conversations.filter(c => getFrustrationScore(c.messages || []) >= 2).length;

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-foreground">Conversation History</h1>
        <p className="text-sm text-muted-foreground mt-1">Full chat log — expand any row to review the thread</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: "Total", value: conversations.length, icon: MessageSquare, color: "text-primary" },
          { label: "Active", value: conversations.filter(c => c.status === "active").length, icon: Clock, color: "text-blue-400" },
          { label: "Invoiced", value: conversations.filter(c => c.stage === "invoiced" || c.stage === "paid").length, icon: DollarSign, color: "text-green-400" },
          { label: "Frustrated", value: frustratedCount, icon: AlertTriangle, color: frustratedCount > 0 ? "text-red-400" : "text-muted-foreground" },
        ].map(({ label, value, icon: Icon, color }) => (
          <Card key={label} className="bg-card border-border">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
                </div>
                <Icon className={`w-7 h-7 ${color} opacity-40`} />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filters + Search */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search by name, phone, company, or message content…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2 text-sm bg-secondary border border-border rounded-md text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div className="flex gap-1">
          {(["all", "active", "invoiced", "frustrated"] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-2 text-xs rounded-md border transition-colors capitalize ${
                filter === f
                  ? f === "frustrated"
                    ? "bg-red-500/20 text-red-400 border-red-500/30"
                    : "bg-primary text-primary-foreground border-primary"
                  : "bg-secondary text-muted-foreground border-border hover:text-foreground"
              }`}
            >
              {f === "frustrated" && frustratedCount > 0 ? `⚠ Frustrated (${frustratedCount})` : f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Conversation List */}
      <Card className="bg-card border-border overflow-hidden">
        <CardHeader className="pb-2 px-5 pt-4">
          <CardTitle className="text-sm text-foreground font-semibold">
            {filtered.length} conversation{filtered.length !== 1 ? "s" : ""}
            {search && <span className="text-muted-foreground font-normal"> matching "{search}"</span>}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-10 text-center text-muted-foreground text-sm">Loading conversations…</div>
          ) : filtered.length === 0 ? (
            <div className="p-10 text-center">
              <MessageSquare className="w-10 h-10 text-muted-foreground/20 mx-auto mb-3" />
              <p className="text-muted-foreground text-sm">No conversations match your filters.</p>
            </div>
          ) : (
            <div>
              {filtered.map(conv => (
                <ConvRow key={conv.id} conv={conv} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
