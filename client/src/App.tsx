import { Router, Switch, Route } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import Dashboard from "@/pages/Dashboard";
import ConversationDetail from "@/pages/ConversationDetail";
import Orders from "@/pages/Orders";
import Products from "@/pages/Products";
import Setup from "@/pages/Setup";
import Layout from "@/components/Layout";
import NotFound from "@/pages/not-found";

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Router hook={useHashLocation}>
        <Layout>
          <Switch>
            <Route path="/" component={Dashboard} />
            <Route path="/conversations/:id" component={ConversationDetail} />
            <Route path="/orders" component={Orders} />
            <Route path="/products" component={Products} />
            <Route path="/setup" component={Setup} />
            <Route component={NotFound} />
          </Switch>
        </Layout>
      </Router>
      <Toaster />
    </QueryClientProvider>
  );
}
