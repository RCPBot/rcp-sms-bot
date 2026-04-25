import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { MessageSquare, Clock, CheckCircle, DollarSign, Phone } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { ConversationWithMessages } from "@shared/schema";

function stageBadge(stage: string) {
  const map: Record<string, { label: string; color: string }> = {
    greeting:       { label: "New",       color: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30" },
    collecting_info:{ label: "Info",      color: "bg-blue-500/20 text-blue-400 border-blue-500/30" },
    ordering:       { label: "Ordering",  color: "bg-purple-500/20 text-purple-400 border-purple-500/30" },
    confirming:     { label: "Confirming",color: "bg-orange-500/20 text-orange-400 border-orange-500/30" },
    invoiced:       { label: "Invoiced",  color: "bg-primary/20 text-primary border-primary/30" },
    paid:           { label: "Paid",      color: "bg-green-500/20 text-green-400 border-green-500/30" },
  };
  const s = map[stage] || { label: stage, color: "bg-muted text-muted-foreground border-border" };
  return <span className={`text-xs px-2 py-0.5 rounded border font-medium ${s.color}`}>{s.label}</span>;
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
    ? `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`
    : phone;
}

export default function Dashboard() {
  const { data: conversations = [], isLoading } = useQuery<ConversationWithMessages[]>({
    queryKey: ["/api/conversations"],
    queryFn: () => apiRequest("GET", "/api/conversations").then(r => r.json()),
    refetchInterval: 10000,
  });

  const active = conversations.filter(c => c.status === "active" && c.stage !== "invoiced" && c.stage !== "paid");
  const completed = conversations.filter(c => c.status === "completed");
  const invoiced = conversations.filter(c => c.stage === "invoiced" || c.stage === "paid");

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-foreground">SMS Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-1">Rebar Concrete Products — Text Order Bot</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: "Active Chats", value: active.length, icon: MessageSquare, color: "text-primary" },
          { label: "Total Convos", value: conversations.length, icon: Phone, color: "text-blue-400" },
          { label: "Completed", value: completed.length, icon: CheckCircle, color: "text-green-400" },
          { label: "Invoiced", value: invoiced.length, icon: DollarSign, color: "text-yellow-400" },
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

      {/* Conversation List */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base text-foreground">Conversations</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground text-sm">Loading...</div>
          ) : conversations.length === 0 ? (
            <div className="p-8 text-center">
              <MessageSquare className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-muted-foreground text-sm">No conversations yet.</p>
              <p className="text-muted-foreground/60 text-xs mt-1">Customers will appear here when they text your Twilio number.</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {conversations.map(conv => {
                const lastMsg = conv.messages?.[conv.messages.length - 1];
                return (
                  <div
                    key={conv.id}
                    data-testid={`conversation-${conv.id}`}
                    onClick={() => { window.location.hash = `/conversations/${conv.id}`; }}
                    className="flex items-center gap-4 px-6 py-4 hover:bg-secondary/50 transition-colors cursor-pointer"
                  >
                      {/* Avatar */}
                      <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0">
                        <span className="text-primary font-bold text-sm">
                          {conv.customerName ? conv.customerName[0].toUpperCase() : "#"}
                        </span>
                      </div>

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-medium text-sm text-foreground">
                            {conv.customerName || formatPhone(conv.phone)}
                          </span>
                          {stageBadge(conv.stage)}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground truncate max-w-xs">
                            {conv.customerCompany && <span className="text-muted-foreground/70">{conv.customerCompany} · </span>}
                            {lastMsg?.body || "No messages"}
                          </span>
                        </div>
                      </div>

                      {/* Time + message count */}
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
