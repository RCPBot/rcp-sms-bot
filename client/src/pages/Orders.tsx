import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Link } from "wouter";
import {
  ShoppingCart, ExternalLink, Clock, Package,
  Truck, CheckCircle2, XCircle, AlertCircle
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { Order, LineItem } from "@shared/schema";

type OrderWithConv = Order & { customerName?: string | null; customerPhone?: string };

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

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; icon: typeof CheckCircle2; color: string }> = {
    pending:  { label: "Pending",  icon: AlertCircle,  color: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30" },
    invoiced: { label: "Invoiced", icon: Package,      color: "bg-primary/15 text-primary border-primary/30" },
    paid:     { label: "Paid",     icon: CheckCircle2, color: "bg-green-500/15 text-green-400 border-green-500/30" },
    cancelled:{ label: "Cancelled",icon: XCircle,      color: "bg-red-500/15 text-red-400 border-red-500/30" },
  };
  const s = map[status] ?? { label: status, icon: AlertCircle, color: "bg-muted text-muted-foreground border-border" };
  const Icon = s.icon;
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border font-medium ${s.color}`}>
      <Icon className="w-3 h-3" />
      {s.label}
    </span>
  );
}

export default function Orders() {
  const { data: orders = [], isLoading } = useQuery<OrderWithConv[]>({
    queryKey: ["/api/orders"],
    queryFn: () => apiRequest("GET", "/api/orders").then(r => r.json()),
    refetchInterval: 15000,
  });

  const totalRevenue = orders
    .filter(o => o.status === "paid")
    .reduce((sum, o) => sum + (o.total ?? 0), 0);

  const invoicedCount = orders.filter(o => o.status === "invoiced").length;
  const paidCount = orders.filter(o => o.status === "paid").length;
  const pendingCount = orders.filter(o => o.status === "pending").length;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-foreground">Orders</h1>
        <p className="text-sm text-muted-foreground mt-1">All orders placed via SMS</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: "Total Orders",  value: orders.length,   color: "text-foreground" },
          { label: "Pending",       value: pendingCount,    color: "text-yellow-400" },
          { label: "Invoiced",      value: invoicedCount,   color: "text-primary" },
          { label: "Revenue (Paid)",value: fmt(totalRevenue),color: "text-green-400" },
        ].map(({ label, value, color }) => (
          <Card key={label} className="bg-card border-border">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className={`text-xl font-bold mt-1 ${color}`}>{value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Orders table */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base text-foreground">Order History</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-14 w-full rounded-lg" />
              ))}
            </div>
          ) : orders.length === 0 ? (
            <div className="p-12 text-center">
              <ShoppingCart className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-muted-foreground text-sm">No orders yet.</p>
              <p className="text-muted-foreground/60 text-xs mt-1">Orders will appear here when customers confirm via SMS.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="orders-table">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className="px-6 py-3 text-xs font-medium text-muted-foreground">Order</th>
                    <th className="px-4 py-3 text-xs font-medium text-muted-foreground">Customer</th>
                    <th className="px-4 py-3 text-xs font-medium text-muted-foreground">Items</th>
                    <th className="px-4 py-3 text-xs font-medium text-muted-foreground">Delivery</th>
                    <th className="px-4 py-3 text-xs font-medium text-muted-foreground">Total</th>
                    <th className="px-4 py-3 text-xs font-medium text-muted-foreground">Status</th>
                    <th className="px-4 py-3 text-xs font-medium text-muted-foreground">Date</th>
                    <th className="px-4 py-3 text-xs font-medium text-muted-foreground">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {orders.map(order => {
                    let lineItems: LineItem[] = [];
                    try { lineItems = JSON.parse(order.lineItemsJson); } catch {}
                    return (
                      <tr
                        key={order.id}
                        className="hover:bg-secondary/30 transition-colors"
                        data-testid={`order-row-${order.id}`}
                      >
                        {/* Order # */}
                        <td className="px-6 py-4">
                          <div className="font-medium text-foreground">
                            #{order.qboInvoiceNumber || order.id}
                          </div>
                          {order.qboInvoiceId && (
                            <div className="text-xs text-muted-foreground">QBO ID: {order.qboInvoiceId}</div>
                          )}
                        </td>

                        {/* Customer */}
                        <td className="px-4 py-4">
                          <Link href={`/conversations/${order.conversationId}`}>
                            <a className="text-primary hover:underline text-sm font-medium">
                              {order.customerName || `Conv #${order.conversationId}`}
                            </a>
                          </Link>
                          {order.customerPhone && (
                            <div className="text-xs text-muted-foreground">{order.customerPhone}</div>
                          )}
                        </td>

                        {/* Items */}
                        <td className="px-4 py-4">
                          <div className="max-w-[200px]">
                            {lineItems.length === 0 ? (
                              <span className="text-muted-foreground">—</span>
                            ) : lineItems.length === 1 ? (
                              <div className="text-sm text-foreground truncate">{lineItems[0].name}</div>
                            ) : (
                              <div className="text-sm text-foreground">
                                {lineItems[0].name}
                                <span className="text-muted-foreground"> +{lineItems.length - 1} more</span>
                              </div>
                            )}
                            <div className="text-xs text-muted-foreground mt-0.5">
                              {lineItems.length} line item{lineItems.length !== 1 ? "s" : ""}
                            </div>
                          </div>
                        </td>

                        {/* Delivery */}
                        <td className="px-4 py-4">
                          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                            {order.deliveryType === "delivery" ? (
                              <><Truck className="w-3 h-3" /> Delivery</>
                            ) : (
                              <><Package className="w-3 h-3" /> Pickup</>
                            )}
                          </span>
                          {order.deliveryFee > 0 && (
                            <div className="text-xs text-muted-foreground">
                              {fmt(order.deliveryFee)} fee{(order as any).deliveryMiles ? ` · ${(order as any).deliveryMiles} mi` : ""}
                            </div>
                          )}
                        </td>

                        {/* Total */}
                        <td className="px-4 py-4">
                          <div className="font-medium text-foreground">{fmt(order.total)}</div>
                          {order.subtotal !== order.total && (
                            <div className="text-xs text-muted-foreground">Sub: {fmt(order.subtotal)}</div>
                          )}
                        </td>

                        {/* Status */}
                        <td className="px-4 py-4">
                          <StatusBadge status={order.status} />
                        </td>

                        {/* Date */}
                        <td className="px-4 py-4">
                          <div className="text-xs text-muted-foreground flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {timeAgo(order.createdAt)}
                          </div>
                        </td>

                        {/* Actions */}
                        <td className="px-4 py-4">
                          <div className="flex items-center gap-2">
                            {order.paymentLink && (
                              <a
                                href={order.paymentLink}
                                target="_blank"
                                rel="noopener noreferrer"
                                data-testid={`order-payment-link-${order.id}`}
                                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                              >
                                <ExternalLink className="w-3 h-3" />
                                Invoice
                              </a>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
