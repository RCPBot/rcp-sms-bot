import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useParams, useLocation } from "wouter";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import type { Message, Order } from "@shared/schema";

function formatTime(date: Date | string | null | number | undefined): string {
  if (!date) return "";
  const d = new Date(typeof date === "number" ? date * 1000 : date);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default function ConversationDetail() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const [reply, setReply] = useState("");
  const { toast } = useToast();

  const { data: conv, isLoading } = useQuery({
    queryKey: ["/api/conversations", id],
    queryFn: () => apiRequest("GET", `/api/conversations/${id}`).then(r => r.json()),
    refetchInterval: 8000,
  });

  const replyMutation = useMutation({
    mutationFn: (message: string) =>
      apiRequest("POST", `/api/conversations/${id}/reply`, { message }).then(r => r.json()),
    onSuccess: () => {
      setReply("");
      queryClient.invalidateQueries({ queryKey: ["/api/conversations", id] });
      toast({ title: "Message sent" });
    },
    onError: () => toast({ title: "Failed to send", variant: "destructive" }),
  });

  if (isLoading) {
    return <div className="p-6 text-muted-foreground text-sm">Loading...</div>;
  }

  if (!conv) {
    return <div className="p-6 text-muted-foreground text-sm">Conversation not found.</div>;
  }

  const order: Order | undefined = conv.order;
  const lineItems = order ? JSON.parse(order.lineItemsJson || "[]") : [];

  return (
    <div className="flex h-full">
      {/* Chat panel */}
      <div className="flex-1 flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-border flex items-center gap-4">
          <a href="#/" className="text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="w-4 h-4" />
          </a>
          <div>
            <div className="font-semibold text-foreground text-sm">
              {conv.customerName || conv.phone}
            </div>
            {conv.customerCompany && (
              <div className="text-xs text-muted-foreground">{conv.customerCompany}</div>
            )}
          </div>
          <div className="ml-auto">
            <span className={`text-xs px-2 py-1 rounded border font-medium ${
              conv.stage === "invoiced"
                ? "bg-yellow-500/20 text-yellow-400 border-yellow-500/30"
                : conv.status === "active"
                ? "bg-primary/20 text-primary border-primary/30"
                : "bg-muted text-muted-foreground border-border"
            }`}>
              {conv.stage === "invoiced" ? "Invoiced" : conv.status}
            </span>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-6 space-y-3">
          {(conv.messages || []).map((msg: Message) => (
            <div
              key={msg.id}
              data-testid={`message-${msg.id}`}
              className={`flex ${msg.direction === "outbound" ? "justify-end" : "justify-start"}`}
            >
              <div className={`max-w-xs lg:max-w-md ${
                msg.direction === "outbound"
                  ? "bg-primary text-primary-foreground rounded-2xl rounded-tr-sm"
                  : "bg-secondary text-foreground rounded-2xl rounded-tl-sm"
              } px-4 py-2.5`}>
                <p className="text-sm whitespace-pre-wrap">{msg.body}</p>
                <p className={`text-xs mt-1 ${
                  msg.direction === "outbound" ? "text-primary-foreground/60" : "text-muted-foreground"
                }`}>
                  {formatTime(msg.createdAt)}
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* Reply box */}
        <div className="p-4 border-t border-border">
          <div className="flex gap-3">
            <Textarea
              data-testid="input-reply"
              placeholder="Type a message to send via SMS..."
              value={reply}
              onChange={e => setReply(e.target.value)}
              className="resize-none text-sm"
              rows={2}
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (reply.trim()) replyMutation.mutate(reply.trim());
                }
              }}
            />
            <Button
              data-testid="button-send"
              onClick={() => reply.trim() && replyMutation.mutate(reply.trim())}
              disabled={!reply.trim() || replyMutation.isPending}
              className="self-end"
              size="sm"
            >
              <Send className="w-4 h-4" />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-1">Press Enter to send · Shift+Enter for new line</p>
        </div>
      </div>

      {/* Right panel — customer + order info */}
      <aside className="w-72 border-l border-border p-5 space-y-5 overflow-y-auto">
        {/* Customer info */}
        <div>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Customer</h3>
          <div className="space-y-2">
            {[
              { icon: Phone, label: conv.phone },
              { icon: Mail, label: conv.customerEmail || "—" },
              { icon: Building, label: conv.customerCompany || "—" },
              { icon: MapPin, label: conv.deliveryAddress || "Pickup" },
            ].map(({ icon: Icon, label }) => (
              <div key={label} className="flex items-start gap-2 text-sm">
                <Icon className="w-3.5 h-3.5 text-muted-foreground mt-0.5 flex-shrink-0" />
                <span className="text-foreground">{label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Order info */}
        {order && (
          <div>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Order</h3>
            <div className="space-y-2">
              {order.qboInvoiceNumber && (
                <div className="flex items-center gap-2 text-sm">
                  <FileText className="w-3.5 h-3.5 text-muted-foreground" />
                  <span>Invoice #{order.qboInvoiceNumber}</span>
                </div>
              )}
              <div className="text-xs text-muted-foreground bg-secondary rounded p-3 space-y-1">
                {lineItems.map((item: any, i: number) => (
                  <div key={i} className="flex justify-between">
                    <span>{item.qty}× {item.name}</span>
                    <span>${item.amount?.toFixed(2)}</span>
                  </div>
                ))}
                {order.deliveryFee > 0 && (
                  <div className="flex justify-between">
                    <span>Delivery</span>
                    <span>${order.deliveryFee.toFixed(2)}</span>
                  </div>
                )}
                <div className="flex justify-between font-semibold text-foreground pt-1 border-t border-border mt-1">
                  <span>Total</span>
                  <span>${order.total.toFixed(2)}</span>
                </div>
              </div>
              {order.paymentLink && (
                <a
                  href={order.paymentLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-xs text-primary hover:underline"
                >
                  <ExternalLink className="w-3 h-3" />
                  View Payment Link
                </a>
              )}
              <div className="text-xs">
                <span className={`px-2 py-0.5 rounded border font-medium ${
                  order.status === "paid"
                    ? "bg-green-500/20 text-green-400 border-green-500/30"
                    : order.status === "invoiced"
                    ? "bg-blue-500/20 text-blue-400 border-blue-500/30"
                    : "bg-yellow-500/20 text-yellow-400 border-yellow-500/30"
                }`}>
                  {order.status}
                </span>
              </div>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
