import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { RefreshCw, Package, Search, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";
import type { Product } from "@shared/schema";

function fmt(n: number | null | undefined) {
  if (n == null) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function timeAgo(date: Date | string | null | undefined): string {
  if (!date) return "never";
  const d = new Date(typeof date === "number" ? date * 1000 : date);
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

export default function Products() {
  const { toast } = useToast();
  const [search, setSearch] = useState("");

  const { data: products = [], isLoading } = useQuery<Product[]>({
    queryKey: ["/api/products"],
    queryFn: () => apiRequest("GET", "/api/products").then(r => r.json()),
    refetchInterval: 60000,
  });

  const syncMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/products/sync").then(r => r.json()),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/products"] });
      toast({
        title: "Products synced",
        description: `${data.count ?? "?"} products synced from QuickBooks Online.`,
      });
    },
    onError: () => {
      toast({
        title: "Sync failed",
        description: "Could not sync products from QuickBooks. Check your QBO credentials in Setup.",
        variant: "destructive",
      });
    },
  });

  const filtered = products.filter(p =>
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    (p.description ?? "").toLowerCase().includes(search.toLowerCase())
  );

  const activeCount = products.filter(p => p.active).length;
  const lastSynced = products.length > 0
    ? products.reduce((latest, p) => {
        const t = p.syncedAt ? new Date(p.syncedAt).getTime() : 0;
        return t > latest ? t : latest;
      }, 0)
    : null;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-foreground">Products</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Synced from QuickBooks Online — {activeCount} active items
          </p>
          {lastSynced && (
            <p className="text-xs text-muted-foreground/60 mt-0.5 flex items-center gap-1">
              <Clock className="w-3 h-3" />
              Last synced {timeAgo(lastSynced)}
            </p>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => syncMutation.mutate()}
          disabled={syncMutation.isPending}
          data-testid="button-sync-products"
          className="flex items-center gap-2 border-border"
        >
          <RefreshCw className={`w-4 h-4 ${syncMutation.isPending ? "animate-spin" : ""}`} />
          {syncMutation.isPending ? "Syncing…" : "Sync from QBO"}
        </Button>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Search products…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="pl-9 bg-secondary border-border"
          data-testid="input-product-search"
        />
      </div>

      {/* Products grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => (
            <Skeleton key={i} className="h-28 w-full rounded-lg" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="p-12 text-center">
            <Package className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
            {products.length === 0 ? (
              <>
                <p className="text-muted-foreground text-sm">No products synced yet.</p>
                <p className="text-muted-foreground/60 text-xs mt-1 mb-4">
                  Connect QuickBooks Online in Setup, then click "Sync from QBO".
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => syncMutation.mutate()}
                  disabled={syncMutation.isPending}
                  className="border-primary/30 text-primary"
                >
                  <RefreshCw className={`w-4 h-4 mr-2 ${syncMutation.isPending ? "animate-spin" : ""}`} />
                  Sync Now
                </Button>
              </>
            ) : (
              <p className="text-muted-foreground text-sm">No products match "{search}"</p>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map(product => (
            <Card
              key={product.id}
              className={`bg-card border-border transition-colors ${!product.active ? "opacity-50" : ""}`}
              data-testid={`product-card-${product.id}`}
            >
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-medium text-sm text-foreground truncate">{product.name}</h3>
                      {!product.active && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border flex-shrink-0">
                          Inactive
                        </span>
                      )}
                    </div>
                    {product.description && (
                      <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                        {product.description}
                      </p>
                    )}
                    <div className="flex items-center gap-3 mt-2">
                      <span className="text-xs text-muted-foreground/60">
                        QBO: {product.qboItemId}
                      </span>
                      {product.unitOfMeasure && (
                        <span className="text-xs text-muted-foreground/60">
                          per {product.unitOfMeasure}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="text-base font-bold text-primary">{fmt(product.unitPrice)}</div>
                    {product.unitOfMeasure && (
                      <div className="text-xs text-muted-foreground">/{product.unitOfMeasure}</div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Count footer */}
      {filtered.length > 0 && (
        <p className="text-xs text-muted-foreground text-center">
          Showing {filtered.length} of {products.length} products
        </p>
      )}
    </div>
  );
}
