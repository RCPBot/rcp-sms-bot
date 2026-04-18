import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { ExternalLink, CheckCircle2, XCircle, AlertCircle, Copy } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

type SetupStatus = {
  twilio: boolean;
  openai: boolean;
  qbo: boolean;
  qboRealmId?: string;
  productCount?: number;
};

function StatusIcon({ ok, warn }: { ok?: boolean; warn?: boolean }) {
  if (warn) return <AlertCircle className="w-4 h-4 text-yellow-400" />;
  if (ok) return <CheckCircle2 className="w-4 h-4 text-green-400" />;
  return <XCircle className="w-4 h-4 text-red-400" />;
}

function EnvRow({ name, description, example, required = true }: {
  name: string; description: string; example?: string; required?: boolean;
}) {
  const { toast } = useToast();
  const copy = () => {
    navigator.clipboard.writeText(name);
    toast({ title: "Copied", description: `${name} copied to clipboard.` });
  };
  return (
    <div className="flex items-start gap-3 py-3 border-b border-border last:border-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <code className="text-xs font-mono bg-secondary px-2 py-0.5 rounded text-primary">{name}</code>
          {!required && (
            <span className="text-xs text-muted-foreground/60 italic">optional</span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-1">{description}</p>
        {example && (
          <p className="text-xs text-muted-foreground/50 mt-0.5 font-mono">e.g. {example}</p>
        )}
      </div>
      <button
        onClick={copy}
        data-testid={`copy-env-${name}`}
        className="text-muted-foreground hover:text-foreground transition-colors mt-0.5"
        title="Copy variable name"
      >
        <Copy className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4">
      <div className="flex-shrink-0 w-7 h-7 rounded-full bg-primary/20 border border-primary/40 flex items-center justify-center">
        <span className="text-primary text-xs font-bold">{n}</span>
      </div>
      <div className="flex-1 pb-6">
        <h3 className="text-sm font-semibold text-foreground mb-2">{title}</h3>
        <div className="text-sm text-muted-foreground space-y-1.5">{children}</div>
      </div>
    </div>
  );
}

export default function Setup() {
  const { toast } = useToast();

  const { data: status } = useQuery<SetupStatus>({
    queryKey: ["/api/setup/status"],
    queryFn: () => apiRequest("GET", "/api/setup/status").then(r => r.json()),
    retry: false,
  });

  const handleQboConnect = async () => {
    try {
      const res = await apiRequest("GET", "/api/qbo/connect").then(r => r.json());
      if (res.authUrl) window.open(res.authUrl, "_blank", "width=600,height=700");
    } catch {
      toast({ title: "Error", description: "Could not start QBO OAuth flow.", variant: "destructive" });
    }
  };

  const checks = [
    { label: "Twilio",          ok: status?.twilio,    hint: "Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER" },
    { label: "OpenAI",          ok: status?.openai,    hint: "Set OPENAI_API_KEY" },
    { label: "QuickBooks Online", ok: status?.qbo,     hint: "Complete QBO OAuth flow below" },
  ];

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-foreground">Setup</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Configure your SMS bot. All credentials are stored as environment variables on your server.
        </p>
      </div>

      {/* Connection Status */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base text-foreground">Connection Status</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {checks.map(({ label, ok, hint }) => (
            <div key={label} className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <StatusIcon ok={ok} />
                <span className="text-sm text-foreground">{label}</span>
              </div>
              {!ok && (
                <span className="text-xs text-muted-foreground text-right">{hint}</span>
              )}
              {ok && label === "QuickBooks Online" && status?.qboRealmId && (
                <span className="text-xs text-muted-foreground">Realm: {status.qboRealmId}</span>
              )}
              {ok && label === "QuickBooks Online" && (
                <span className="text-xs text-green-400">{status?.productCount ?? 0} products cached</span>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {/* QBO OAuth */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base text-foreground">QuickBooks Online — OAuth</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Connect your QBO account to enable live pricing, invoice creation, and payment links.
            You need <strong className="text-foreground">QuickBooks Payments</strong> enabled on your QBO account
            to send payment links to customers.
          </p>
          <Button
            variant="outline"
            onClick={handleQboConnect}
            data-testid="button-qbo-connect"
            className="border-primary/40 text-primary hover:bg-primary/10 flex items-center gap-2"
          >
            <ExternalLink className="w-4 h-4" />
            {status?.qbo ? "Reconnect QuickBooks" : "Connect QuickBooks Online"}
          </Button>
          <p className="text-xs text-muted-foreground/60">
            After authorizing, your QBO_REFRESH_TOKEN and QBO_REALM_ID will be stored automatically.
            Keep your APP_URL env var set to your deployed server URL so the OAuth callback works.
          </p>
        </CardContent>
      </Card>

      {/* Environment Variables Reference */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base text-foreground">Environment Variables</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-4">
            Create a <code className="bg-secondary px-1 rounded text-primary font-mono">.env</code> file
            in your project root with these variables before starting the server.
          </p>
          <EnvRow
            name="TWILIO_ACCOUNT_SID"
            description="Your Twilio Account SID — found on the Twilio Console dashboard."
            example="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
          />
          <EnvRow
            name="TWILIO_AUTH_TOKEN"
            description="Your Twilio Auth Token — found on the Twilio Console dashboard."
          />
          <EnvRow
            name="TWILIO_PHONE_NUMBER"
            description="The Twilio phone number customers text. Must be in E.164 format."
            example="+14696317730"
          />
          <EnvRow
            name="OPENAI_API_KEY"
            description="OpenAI API key for GPT-4o. The bot uses this to handle customer conversations."
            example="sk-..."
          />
          <EnvRow
            name="QBO_CLIENT_ID"
            description="QuickBooks Online app client ID from developer.intuit.com."
          />
          <EnvRow
            name="QBO_CLIENT_SECRET"
            description="QuickBooks Online app client secret from developer.intuit.com."
          />
          <EnvRow
            name="APP_URL"
            description="The public URL of this server — used as the OAuth redirect URI for QBO."
            example="https://your-server.example.com"
          />
          <EnvRow
            name="GOOGLE_MAPS_API_KEY"
            description="Google Maps Distance Matrix API key for $3/mile delivery fee auto-calculation. Required for delivery fee to work. Enable 'Distance Matrix API' in your Google Cloud project."
            example="AIzaSy..."
          />
          <EnvRow
            name="FORWARD_PHONE"
            description="Your real office phone number. Callers who press 1 get forwarded here. Digits only, no dashes."
            example="4696317730"
          />
          <EnvRow
            name="OWNER_PHONE"
            description="Your cell number to receive voicemail alerts and transcriptions via SMS."
            example="+14696317730"
          />
          <EnvRow
            name="EMAIL_SERVICE"
            description="Email service for sending fabrication cut sheets. Use 'gmail' for Gmail SMTP."
            example="gmail"
          />
          <EnvRow
            name="EMAIL_USER"
            description="Email address used to send fabrication cut sheet PDFs to the owner on estimate approval."
            example="maddoxconstruction1987@gmail.com"
          />
          <EnvRow
            name="EMAIL_PASS"
            description="Gmail App Password (16 chars, no spaces). Generate at myaccount.google.com → Security → App Passwords. Requires 2-Step Verification to be enabled."
          />
          <EnvRow
            name="QBO_REFRESH_TOKEN"
            description="Populated automatically after completing the QBO OAuth flow above. You can also paste it manually."
            required={false}
          />
          <EnvRow
            name="QBO_REALM_ID"
            description="Your QBO Company ID — populated automatically after the OAuth flow."
            required={false}
          />
        </CardContent>
      </Card>

      {/* Setup Steps */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base text-foreground">Setup Guide</CardTitle>
        </CardHeader>
        <CardContent>
          <Step n={1} title="Get a Twilio phone number">
            <p>Sign up at <a href="https://twilio.com" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">twilio.com</a>. Buy a US local phone number (~$1.15/month).</p>
            <p>Copy your Account SID and Auth Token from the Console Dashboard.</p>
            <p>Under Phone Numbers → Manage → Active Numbers, click your number and set the <strong className="text-foreground">Messaging webhook</strong> to:</p>
            <code className="block bg-secondary text-primary font-mono text-xs rounded p-2 mt-1">
              https://your-server.example.com/api/sms/inbound
            </code>
            <p className="mt-1">Then set the <strong className="text-foreground">Voice webhook (A call comes in)</strong> to:</p>
            <code className="block bg-secondary text-primary font-mono text-xs rounded p-2 mt-1">
              https://your-server.example.com/api/voice/inbound
            </code>
            <p className="mt-1">Both webhooks: Method <strong className="text-foreground">HTTP POST</strong></p>
          </Step>

          <Step n={2} title="Create a QuickBooks Online app">
            <p>Go to <a href="https://developer.intuit.com" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">developer.intuit.com</a> and create a new app.</p>
            <p>Select <strong className="text-foreground">QuickBooks Online and Payments</strong> as the scope.</p>
            <p>Add your OAuth redirect URI:</p>
            <code className="block bg-secondary text-primary font-mono text-xs rounded p-2 mt-1">
              https://your-server.example.com/api/qbo/callback
            </code>
            <p className="mt-1">Copy the Client ID and Client Secret into your <code className="text-primary font-mono">.env</code>.</p>
          </Step>

          <Step n={3} title="Get an OpenAI API key">
            <p>Sign up at <a href="https://platform.openai.com" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">platform.openai.com</a>.</p>
            <p>Go to API Keys → Create new secret key. Add it to your <code className="text-primary font-mono">.env</code>.</p>
            <p>The bot uses <strong className="text-foreground">GPT-4o</strong>. Ensure your account has access.</p>
          </Step>

          <Step n={4} title="Enable QuickBooks Payments">
            <p>Log in to QuickBooks Online. Go to <strong className="text-foreground">Account &amp; Settings → Payments</strong>.</p>
            <p>Sign up for QuickBooks Payments if not already enabled — this is required to send payment links to customers.</p>
          </Step>

          <Step n={5} title="Get a Google Maps API key">
            <p>Go to <a href="https://console.cloud.google.com" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">console.cloud.google.com</a>, create a project, and enable the <strong className="text-foreground">Distance Matrix API</strong>.</p>
            <p>Create an API key (restrict to Distance Matrix API for security) and add it as <code className="text-primary font-mono">GOOGLE_MAPS_API_KEY</code> in your <code className="text-primary font-mono">.env</code>.</p>
            <p>Without this key, delivery fee will show as "to be confirmed" — orders still work but fee won't be auto-calculated.</p>
          </Step>

          <Step n={6} title="Existing customers only">
            <p>The bot automatically checks each new texter's phone number against your QuickBooks customer list.</p>
            <p>If the number matches an existing customer, they're verified instantly and their name/email are pre-filled.</p>
            <p>If no match is found, the bot politely tells them to call 469-631-7730 to set up an account first.</p>
            <p>Make sure all your customers have a phone number saved in QuickBooks for the auto-match to work.</p>
          </Step>

          <Step n={7} title="Deploy and connect QBO">
            <p>Set all env vars, deploy the server, then come back to this page.</p>
            <p>Click <strong className="text-foreground">"Connect QuickBooks Online"</strong> above to complete the OAuth flow.</p>
            <p>Click <strong className="text-foreground">"Sync from QBO"</strong> on the Products page to import your product catalog.</p>
            <p>Text your Twilio number to test the bot. Customers will receive AI-powered responses and a payment link when they confirm an order.</p>
          </Step>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground/50 text-center pb-4">
        Rebar Concrete Products SMS Bot · 469-631-7730 · McKinney, TX
      </p>
    </div>
  );
}
