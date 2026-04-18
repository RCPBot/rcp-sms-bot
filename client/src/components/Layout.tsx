import { Link, useLocation } from "wouter";
import { MessageSquare, ShoppingCart, Package, Settings, Zap } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

const navItems = [
  { href: "/", label: "Conversations", icon: MessageSquare },
  { href: "/orders", label: "Orders", icon: ShoppingCart },
  { href: "/products", label: "Products", icon: Package },
  { href: "/setup", label: "Setup", icon: Settings },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  const { data: status } = useQuery({
    queryKey: ["/api/status"],
    queryFn: () => apiRequest("GET", "/api/status").then(r => r.json()),
    refetchInterval: 30000,
  });

  const allConfigured = status?.twilio && status?.qbo && status?.openai;

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside className="w-56 flex-shrink-0 bg-card border-r border-border flex flex-col">
        {/* Logo */}
        <div className="p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-primary rounded flex items-center justify-center">
              <Zap className="w-4 h-4 text-primary-foreground" />
            </div>
            <div>
              <div className="text-sm font-bold text-foreground leading-none">RCP TextBot</div>
              <div className="text-xs text-muted-foreground mt-0.5">Order Automation</div>
            </div>
          </div>
        </div>

        {/* Status indicator */}
        <div className="px-4 py-2 border-b border-border">
          <div className="flex items-center gap-2 text-xs">
            <div className={`w-2 h-2 rounded-full ${allConfigured ? "bg-green-500" : "bg-yellow-500"}`} />
            <span className="text-muted-foreground">
              {allConfigured ? "All systems active" : "Setup required"}
            </span>
          </div>
          {status && (
            <div className="mt-1 text-xs text-muted-foreground">
              {status.products} products synced
            </div>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-3 space-y-1">
          {navItems.map(({ href, label, icon: Icon }) => {
            const active = location === href || (href !== "/" && location.startsWith(href));
            return (
              <Link key={href} href={href}>
                <a
                  data-testid={`nav-${label.toLowerCase()}`}
                  className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                    active
                      ? "bg-primary text-primary-foreground font-medium"
                      : "text-muted-foreground hover:text-foreground hover:bg-secondary"
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {label}
                </a>
              </Link>
            );
          })}
        </nav>

        {/* Twilio number */}
        {status?.twilio && (
          <div className="p-4 border-t border-border">
            <div className="text-xs text-muted-foreground">SMS Number</div>
            <div className="text-sm font-mono text-primary mt-0.5">
              {import.meta.env.VITE_TWILIO_PHONE || "Configured"}
            </div>
          </div>
        )}
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
