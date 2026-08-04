import { useState, type FormEvent } from "react";
import * as Exit from "effect/Exit";
import {
  AsyncResult,
  createPluginAtomClient,
  defineClientPlugin,
  useAtomRefresh,
  useAtomSet,
  useAtomValue,
} from "@executor-js/sdk/client";
import { Badge } from "@executor-js/react/components/badge";
import { Button } from "@executor-js/react/components/button";
import { Checkbox } from "@executor-js/react/components/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@executor-js/react/components/collapsible";
import { CopyButton } from "@executor-js/react/components/copy-button";
import { Input } from "@executor-js/react/components/input";
import { Label } from "@executor-js/react/components/label";
import { messageFromExit } from "@executor-js/react/api/error-reporting";
import {
  ChevronRight,
  CircleStop,
  Cloud,
  ExternalLink,
  Monitor,
  Plus,
  RefreshCw,
  Server,
  X,
} from "lucide-react";

import { BrowserControlApi, type AddBrowserProviderInput } from "./shared";

const BrowserClient = createPluginAtomClient(BrowserControlApi);
const overviewAtom = BrowserClient.query("browserControl", "overview", {
  timeToLive: "5 seconds",
  reactivityKeys: ["browser-control"],
});
const addProviderAtom = BrowserClient.mutation("browserControl", "addProvider");
const stopSessionAtom = BrowserClient.mutation("browserControl", "stopSession");

type RemoteProvider = AddBrowserProviderInput["provider"];

const providerLabels: Record<RemoteProvider, string> = {
  "vercel-sandbox": "Vercel Sandbox",
  "cloudflare-browser-run": "Cloudflare Browser Run",
  "browser-use": "Browser Use",
  "generic-cdp": "Generic CDP",
};

function StateBadge({ state }: { readonly state: string }) {
  const live = state === "live";
  const ready = state === "ready";
  return (
    <Badge
      variant="outline"
      className={
        live
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : ready
            ? "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300"
            : "text-muted-foreground"
      }
    >
      <span
        className={`size-1.5 rounded-full ${live ? "bg-emerald-500" : ready ? "bg-sky-500" : "bg-muted-foreground/50"}`}
      />
      {state.replace("-", " ")}
    </Badge>
  );
}

function AvailabilityBadge({
  availability,
}: {
  readonly availability: "available" | "needs-setup" | "unavailable";
}) {
  const available = availability === "available";
  const unavailable = availability === "unavailable";
  return (
    <Badge
      variant="outline"
      className={
        available
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : unavailable
            ? "border-destructive/40 bg-destructive/10 text-destructive"
            : "text-muted-foreground"
      }
    >
      {available ? "Configured" : unavailable ? "Unavailable" : "Needs setup"}
    </Badge>
  );
}

function ProviderForm({
  provider,
  onDone,
}: {
  readonly provider: RemoteProvider;
  readonly onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const addProvider = useAtomSet(addProviderAtom, { mode: "promiseExit" });

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    const text = (name: string) => String(data.get(name) || "").trim() || undefined;
    const number = (name: string) => {
      const value = text(name);
      return value ? Number(value) : undefined;
    };
    const payload: AddBrowserProviderInput = {
      provider,
      name: text("name"),
      slug: text("slug"),
      connectionName: text("connectionName"),
      credential: text("credential"),
      accountId: text("accountId"),
      cdpUrl: text("cdpUrl"),
      liveUrl: text("liveUrl"),
      authHeaderName: text("authHeaderName"),
      authPrefix: text("authPrefix"),
      timeoutMs: number("timeoutMs"),
      vcpus: number("vcpus"),
      keepAliveMs: number("keepAliveMs"),
      timeoutMinutes: number("timeoutMinutes"),
      profileId: text("profileId"),
      proxyCountryCode: text("proxyCountryCode"),
      enableRecording: recording,
    };
    const exit = await addProvider({ payload, reactivityKeys: ["browser-control"] });
    setBusy(false);
    if (Exit.isSuccess(exit)) {
      onDone();
      return;
    }
    setError(messageFromExit(exit, "Could not add this browser provider"));
  };

  return (
    <form onSubmit={submit} className="grid gap-4 border-t pt-5">
      {provider === "vercel-sandbox" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            name="timeoutMs"
            label="Session timeout (ms)"
            placeholder="600000"
            type="number"
            min={1}
            step={1000}
          />
          <Field name="vcpus" label="vCPUs" placeholder="2" type="number" min={1} step={1} />
        </div>
      )}
      {provider === "cloudflare-browser-run" && (
        <>
          <Field name="accountId" label="Cloudflare account ID" required />
          <SecretField name="credential" label="API token" />
          <Field
            name="keepAliveMs"
            label="Keep-alive (ms)"
            placeholder="600000"
            type="number"
            min={10000}
            max={1200000}
            step={10000}
          />
        </>
      )}
      {provider === "browser-use" && (
        <>
          <SecretField name="credential" label="API key" />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              name="timeoutMinutes"
              label="Timeout (minutes)"
              placeholder="60"
              type="number"
              min={1}
              max={240}
              step={1}
            />
            <Field name="proxyCountryCode" label="Proxy country" placeholder="us" />
          </div>
          <Field name="profileId" label="Profile ID" placeholder="Optional" />
          <Label htmlFor="browser-enable-recording" className="flex items-center gap-2 text-sm">
            <Checkbox
              id="browser-enable-recording"
              checked={recording}
              onCheckedChange={(checked) => setRecording(checked === true)}
            />
            Record provider session
          </Label>
        </>
      )}
      {provider === "generic-cdp" && (
        <>
          <Field name="cdpUrl" label="CDP endpoint" placeholder="wss://..." required />
          <Field name="liveUrl" label="Live view URL" placeholder="Optional" />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field name="authHeaderName" label="Auth header" placeholder="Optional" />
            <Field name="authPrefix" label="Header prefix" placeholder="Bearer " />
          </div>
          <SecretField name="credential" label="Header value (optional)" required={false} />
        </>
      )}

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
          <ChevronRight
            className={`size-3.5 transition-transform ${advancedOpen ? "rotate-90" : ""}`}
          />
          Advanced
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field name="name" label="Display name" placeholder={providerLabels[provider]} />
            <Field name="connectionName" label="Connection" placeholder="default" />
          </div>
          <div className="mt-3">
            <Field name="slug" label="Tool namespace" placeholder="Generated automatically" />
          </div>
        </CollapsibleContent>
      </Collapsible>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          <Plus className="size-4" />
          {busy ? "Adding..." : "Add browser"}
        </Button>
      </div>
    </form>
  );
}

function Field({
  name,
  label,
  placeholder,
  required = false,
  type = "text",
  min,
  max,
  step,
}: {
  readonly name: string;
  readonly label: string;
  readonly placeholder?: string;
  readonly required?: boolean;
  readonly type?: "text" | "number";
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}) {
  return (
    <div className="grid min-w-0 gap-2">
      <Label htmlFor={`browser-${name}`}>{label}</Label>
      <Input
        id={`browser-${name}`}
        name={name}
        placeholder={placeholder}
        required={required}
        type={type}
        min={min}
        max={max}
        step={step}
      />
    </div>
  );
}

function SecretField(props: {
  readonly name: string;
  readonly label: string;
  readonly required?: boolean;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={`browser-${props.name}`}>{props.label}</Label>
      <Input
        id={`browser-${props.name}`}
        name={props.name}
        type="password"
        autoComplete="off"
        required={props.required !== false}
      />
    </div>
  );
}

function BrowsersPage() {
  const overview = useAtomValue(overviewAtom);
  const refresh = useAtomRefresh(overviewAtom);
  const stopSession = useAtomSet(stopSessionAtom, { mode: "promiseExit" });
  const [adding, setAdding] = useState<RemoteProvider | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  const value = AsyncResult.isSuccess(overview) ? overview.value : null;
  const liveTargets = value?.targets.filter((target) => target.state === "live").length || 0;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-5 py-7 md:px-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Browsers</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Local Chrome and isolated remote targets exposed as separate Executor tool addresses.
          </p>
        </div>
        <Button variant="outline" size="icon" onClick={() => refresh()} title="Refresh browsers">
          <RefreshCw className="size-4" />
        </Button>
      </header>

      {AsyncResult.isFailure(overview) && (
        <div className="rounded-md border border-destructive/40 p-4 text-sm text-destructive">
          Browser availability could not be loaded.
        </div>
      )}

      <section className="grid gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase text-muted-foreground">Browser targets</h2>
          <span className="text-xs text-muted-foreground">
            {value ? `${liveTargets} live · ${value.targets.length} configured` : "Loading"}
          </span>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {value?.targets.map((target) => {
            const key = `${target.integration}:${target.connection || "none"}`;
            const Icon = target.provider === "local-extension" ? Monitor : Cloud;
            return (
              <article key={key} className="rounded-md border bg-card p-4">
                <div className="flex items-start gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted">
                    <Icon className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="truncate text-sm font-semibold">{target.name}</h3>
                      <StateBadge state={target.state} />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{target.detail}</p>
                    {target.address && (
                      <div className="mt-3 flex min-w-0 items-center rounded bg-muted pl-2">
                        <code className="min-w-0 flex-1 truncate py-1.5 text-xs">
                          {target.address}
                        </code>
                        <CopyButton value={target.address} className="mr-1" />
                      </div>
                    )}
                    <div className="mt-3 flex items-center gap-2">
                      {target.session?.liveUrl && (
                        <Button variant="outline" size="sm" asChild>
                          <a href={target.session.liveUrl} target="_blank" rel="noreferrer">
                            Live view <ExternalLink className="size-3.5" />
                          </a>
                        </Button>
                      )}
                      {target.state === "live" &&
                        target.provider !== "local-extension" &&
                        target.connection && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={stopping === key}
                            onClick={async () => {
                              setStopping(key);
                              await stopSession({
                                params: {
                                  integration: target.integration,
                                  connection: target.connection!,
                                },
                                reactivityKeys: ["browser-control"],
                              });
                              setStopping(null);
                            }}
                          >
                            <CircleStop className="size-3.5" />
                            Stop
                          </Button>
                        )}
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="grid gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase text-muted-foreground">
            Remote providers
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Availability reflects this Executor host. Configured sessions start on first use.
          </p>
        </div>
        <div className="divide-y rounded-md border">
          {value?.providers.map((provider) => {
            const open = adding === provider.id;
            return (
              <div key={provider.id} className="px-4 py-4">
                <div className="flex flex-wrap items-center gap-3">
                  <Server className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-medium">{provider.name}</h3>
                      <AvailabilityBadge availability={provider.availability} />
                      <Badge variant="secondary">
                        {provider.transport === "cdp" ? "CDP" : "agent-browser"}
                      </Badge>
                      {provider.configured > 0 && (
                        <Badge variant="secondary">{provider.configured} configured</Badge>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {provider.note} · {provider.availabilityDetail}
                    </p>
                  </div>
                  <Button
                    variant={open ? "ghost" : "outline"}
                    size="sm"
                    disabled={provider.availability === "unavailable"}
                    title={
                      provider.availability === "unavailable"
                        ? provider.availabilityDetail
                        : undefined
                    }
                    onClick={() => setAdding(open ? null : provider.id)}
                  >
                    {open ? <X className="size-4" /> : <Plus className="size-4" />}
                    {open ? "Close" : provider.configured > 0 ? "Add target" : "Configure"}
                  </Button>
                </div>
                {open && <ProviderForm provider={provider.id} onDone={() => setAdding(null)} />}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

export default defineClientPlugin({
  id: "browser-bridge" as const,
  pages: [
    {
      path: "/",
      component: BrowsersPage,
      nav: { label: "Browsers" },
    },
  ],
});
