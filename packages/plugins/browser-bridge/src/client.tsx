import { useState, type FormEvent } from "react";
import * as Exit from "effect/Exit";
import * as Atom from "effect/unstable/reactivity/Atom";
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
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleStop,
  Cloud,
  ExternalLink,
  Monitor,
  PlayCircle,
  Plus,
  PlugZap,
  RefreshCw,
  Server,
  X,
} from "lucide-react";

import { PROVIDER_SETUP } from "./provider-setup";
import {
  BrowserControlApi,
  type AddBrowserProviderInput,
  type BrowserAccessView,
  type BrowserConnectionTestView,
  type BrowserTargetView,
  type BrowserTrialRunView,
  type ReusableCredentialView,
} from "./shared";

const BrowserClient = createPluginAtomClient(BrowserControlApi);
const overviewAtom = BrowserClient.query("browserControl", "overview", {
  timeToLive: "5 seconds",
  reactivityKeys: ["browser-control"],
});
const addProviderAtom = BrowserClient.mutation("browserControl", "addProvider");
const stopSessionAtom = BrowserClient.mutation("browserControl", "stopSession");
const removeTargetAtom = BrowserClient.mutation("browserControl", "removeTarget");
const testConnectionAtom = BrowserClient.mutation("browserControl", "testConnection");
const trialRunAtom = BrowserClient.mutation("browserControl", "trialRun");

/** `Atom.family` because the form re-renders: a fresh atom per render refetches in a loop. */
const reusableCredentialsAtom = Atom.family((provider: RemoteProvider) =>
  BrowserClient.query("browserControl", "reusableCredentials", {
    params: { provider },
    timeToLive: "30 seconds",
    reactivityKeys: ["browser-control"],
  }),
);

type RemoteProvider = AddBrowserProviderInput["provider"];

const providerLabels: Record<RemoteProvider, string> = {
  "vercel-sandbox": "Vercel Sandbox",
  "cloudflare-browser-run": "Cloudflare Browser Run",
  "browser-use": "Browser Use",
  "generic-cdp": "Generic CDP",
};

const stateTone: Record<string, { readonly badge: string; readonly dot: string }> = {
  live: {
    badge: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  // Distinct from both live and offline: the session exists but has stopped
  // answering, which is a different thing to do about than "not connected".
  stale: {
    badge: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  ready: {
    badge: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    dot: "bg-sky-500",
  },
  error: {
    badge: "border-destructive/40 bg-destructive/10 text-destructive",
    dot: "bg-destructive",
  },
};

function StateBadge({ state }: { readonly state: string }) {
  const tone = stateTone[state];
  return (
    <Badge variant="outline" className={tone?.badge || "text-muted-foreground"}>
      <span className={`size-1.5 rounded-full ${tone?.dot || "bg-muted-foreground/50"}`} />
      {state === "error" ? "start failed" : state.replace("-", " ")}
    </Badge>
  );
}

/**
 * The scope the extension is enforcing, as the extension reports it.
 *
 * Shown because the console previously received this and dropped it, leaving
 * the user to infer from a refusal which of several limits had applied.
 */
function AccessSummary({ access }: { readonly access: BrowserAccessView }) {
  const hosts = access.allowedHosts;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <Badge variant="secondary">{access.mode === "full" ? "Full access" : "Limited access"}</Badge>
      <Badge variant="secondary">
        {access.sessionActive ? "Control session running" : "No control session"}
      </Badge>
      {access.advanced && <Badge variant="secondary">Advanced on</Badge>}
      {access.mode === "limited" && (
        <Badge variant="secondary" title={hosts.join(", ")}>
          {hosts.length === 0
            ? "Executor tab group only"
            : `${hosts.length} allowed host${hosts.length === 1 ? "" : "s"}`}
        </Badge>
      )}
      {access.expiresAt && (
        <Badge variant="secondary">Ends in {untilLabel(access.expiresAt, Date.now())}</Badge>
      )}
    </div>
  );
}

/**
 * There is no "unavailable" any more.
 *
 * That state existed for Vercel without an ambient identity on the host, and it
 * disabled the provider outright. Since a Vercel API token works on any host,
 * every provider here can be set up from this page, so the only question left
 * is whether it already has been.
 */
function AvailabilityBadge({
  availability,
}: {
  readonly availability: "available" | "needs-setup";
}) {
  const available = availability === "available";
  return (
    <Badge
      variant="outline"
      className={
        available
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "text-muted-foreground"
      }
    >
      {available ? "Configured" : "Needs setup"}
    </Badge>
  );
}

/**
 * The prompt that tells an agent this browser exists and how to use it.
 *
 * The tool address alone is copyable already, but on its own it is a string
 * with no instructions attached: an agent handed `tools.browser.user.desktop`
 * still does not know it should prefer snapshots, that only certain tabs are
 * reachable, or that it must not invent page state. This is the paste that
 * makes the target usable, and it is never shown, nobody reads a wall of
 * instructions written for a machine.
 */
function agentPromptFor(target: BrowserTargetView): string {
  const local = target.provider === "local-extension";
  const lines = [
    local
      ? "You can control my Chrome browser through Executor."
      : `You can control a remote browser (${target.name}) through Executor.`,
    "",
    `Browser tools: ${target.address} (tabs, navigate, snapshot, click, type, screenshot).`,
    "",
    "How to use it:",
    "- Prefer snapshot over screenshots: it is cheaper and describes structure.",
  ];
  if (local) {
    lines.push(
      "- Only tabs in my Executor tab group are controllable; others are refused.",
      "- Normal http(s) pages only; chrome:// pages are refused.",
    );
  } else {
    lines.push(
      "- This browser is fresh: it holds no sign-ins or cookies of mine.",
      "- An idle session is closed to stop it billing, and the next call starts a new one, so do not assume open tabs survive a pause.",
    );
  }
  if (target.access?.mode === "limited" && target.access.allowedHosts.length > 0) {
    lines.push(`- Only these sites are allowed: ${target.access.allowedHosts.join(", ")}.`);
  }
  lines.push("- If a tool returns an error, report it, do not guess what the page shows.");
  return lines.join("\n");
}

/** Rough countdown, enough to decide whether to act, not a clock. */
function untilLabel(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((at - now) / 1000));
  return seconds >= 90 ? `${Math.round(seconds / 60)} min` : `${seconds}s`;
}

/**
 * Outcome of a manual connection test.
 *
 * Three outcomes, not two: a credential can be accepted without proving it
 * carries the permission the target needs, and saying so is more useful than
 * rounding it up to a pass. Every failure carries its remedy, because "failed"
 * on its own leaves the user with nowhere to go.
 */
function ConnectionTestResult({ result }: { readonly result: BrowserConnectionTestView }) {
  const tone = !result.ok
    ? "text-destructive"
    : result.verified
      ? "text-emerald-700 dark:text-emerald-300"
      : "text-amber-700 dark:text-amber-300";
  const Icon = result.ok && result.verified ? CheckCircle2 : AlertTriangle;
  return (
    <div className="mt-3 rounded border bg-muted/40 px-2.5 py-2">
      <p className={`flex items-start gap-1.5 text-xs ${tone}`}>
        <Icon className="mt-px size-3.5 shrink-0" />
        <span className="min-w-0 break-words">{result.detail}</span>
      </p>
      {result.hint && (
        <p className="mt-1 break-words pl-5 text-xs text-muted-foreground">{result.hint}</p>
      )}
    </div>
  );
}

/**
 * What a real session did, as opposed to what a credential claims.
 *
 * The page title is shown because it is the part that cannot be faked by a
 * probe: something rendered HTML at the other end.
 */
function TrialRunResult({ result }: { readonly result: BrowserTrialRunView }) {
  const Icon = result.ok ? CheckCircle2 : AlertTriangle;
  return (
    <div className="mt-3 rounded border bg-muted/40 px-2.5 py-2">
      <p
        className={`flex items-start gap-1.5 text-xs ${
          result.ok ? "text-emerald-700 dark:text-emerald-300" : "text-destructive"
        }`}
      >
        <Icon className="mt-px size-3.5 shrink-0" />
        <span className="min-w-0 break-words">{result.detail}</span>
      </p>
      {result.ok && result.title && (
        <p className="mt-1 break-words pl-5 text-xs text-muted-foreground">
          Loaded &ldquo;{result.title}&rdquo;
          {result.url ? ` from ${result.url}` : ""}
        </p>
      )}
      {result.hint && (
        <p className="mt-1 break-words pl-5 text-xs text-muted-foreground">{result.hint}</p>
      )}
    </div>
  );
}

/**
 * What to do before filling the form in.
 *
 * Providers issue many kinds of token and only one kind works, so the exact
 * permission is stated rather than left for the user to guess and then
 * discover through a failed session.
 */
function SetupGuide({ provider }: { readonly provider: RemoteProvider }) {
  const setup = PROVIDER_SETUP[provider];
  return (
    <div className="grid gap-3 rounded-md border bg-muted/30 p-3">
      <ol className="grid list-decimal gap-1.5 pl-4 text-xs text-muted-foreground">
        {setup.steps.map((step) => (
          <li key={step.text} className="min-w-0">
            <span>{step.text}</span>
            {step.url && (
              <a
                href={step.url}
                target="_blank"
                rel="noreferrer"
                className="ml-1 inline-flex items-center gap-0.5 font-medium text-foreground underline underline-offset-2"
              >
                Open
                <ExternalLink className="size-3" />
              </a>
            )}
          </li>
        ))}
      </ol>
      {setup.permission && (
        <p className="text-xs">
          <span className="text-muted-foreground">Required permission: </span>
          <code className="rounded bg-muted px-1 py-0.5">{setup.permission}</code>
        </p>
      )}
      {setup.agentPrompt && (
        <div className="flex items-center justify-between gap-2 rounded border bg-background px-2.5 py-2">
          <span className="min-w-0 text-xs text-muted-foreground">
            {setup.agentPromptLabel || "Setup prompt for an agent"}
          </span>
          <CopyButton value={setup.agentPrompt} />
        </div>
      )}
    </div>
  );
}

function ProviderForm({
  provider,
  hostIdentity,
  onDone,
}: {
  readonly provider: RemoteProvider;
  /** This host carries an ambient credential for the provider. */
  readonly hostIdentity: boolean;
  readonly onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [allowAdvanced, setAllowAdvanced] = useState(true);
  const [allowPrivateNetwork, setAllowPrivateNetwork] = useState(false);
  const [fullAccess, setFullAccess] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [reuse, setReuse] = useState<ReusableCredentialView | null>(null);
  const [mint, setMint] = useState<ReusableCredentialView | null>(null);
  const [vercelAmbient, setVercelAmbient] = useState(false);
  const addProvider = useAtomSet(addProviderAtom, { mode: "promiseExit" });
  const reusable = useAtomValue(reusableCredentialsAtom(provider));
  const candidates = AsyncResult.isSuccess(reusable) ? reusable.value : [];
  const secretLabel = PROVIDER_SETUP[provider].credentialLabel;

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
      teamId: text("teamId"),
      projectId: text("projectId"),
      image: text("image"),
      ...(provider === "vercel-sandbox" ? { vercelAuth: vercelAmbient ? "ambient" : "token" } : {}),
      authHeaderName: text("authHeaderName"),
      authPrefix: text("authPrefix"),
      timeoutMs: number("timeoutMs"),
      idleTimeoutMinutes: number("idleTimeoutMinutes"),
      vcpus: number("vcpus"),
      keepAliveMs: number("keepAliveMs"),
      timeoutMinutes: number("timeoutMinutes"),
      profileId: text("profileId"),
      proxyCountryCode: text("proxyCountryCode"),
      enableRecording: recording,
      allowAdvanced,
      // Comma or whitespace separated, because both are what people type.
      allowedHosts: (text("allowedHosts") || "")
        .split(/[\s,]+/)
        .map((host) => host.trim())
        .filter(Boolean),
      allowPrivateNetwork,
      fullAccess,
      ...(reuse ? { reuseIntegration: reuse.integration, reuseConnection: reuse.connection } : {}),
      ...(mint ? { mintIntegration: mint.integration, mintConnection: mint.connection } : {}),
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
      <SetupGuide provider={provider} />
      {candidates.length > 0 && (
        <div className="grid gap-2 rounded-md border p-3">
          <p className="text-xs font-medium">Auth from Integration</p>
          {candidates.map((candidate) => {
            const chosen =
              candidate.usage === "mint"
                ? mint?.address === candidate.address
                : reuse?.address === candidate.address;
            // The two are mutually exclusive: a target gets one credential, and
            // choosing either has to clear the other or the request would carry
            // both and the server would have to pick.
            const choose = () => {
              if (candidate.usage === "mint") {
                setReuse(null);
                setMint(chosen ? null : candidate);
              } else {
                setMint(null);
                setReuse(chosen ? null : candidate);
              }
            };
            return (
              <div key={candidate.address} className="flex items-center gap-2">
                <Button
                  type="button"
                  variant={chosen ? "secondary" : "outline"}
                  size="sm"
                  onClick={choose}
                >
                  {candidate.usage === "mint"
                    ? chosen
                      ? "Will create token"
                      : "Create token using existing credentials"
                    : chosen
                      ? "Using"
                      : "Use"}
                </Button>
                <span className="min-w-0 truncate text-xs">
                  {candidate.integrationName} · {candidate.connection}
                  {candidate.identityLabel ? ` (${candidate.identityLabel})` : ""}
                </span>
              </div>
            );
          })}
          <p className="text-xs text-muted-foreground">
            {mint
              ? "Creates a new API token on your provider account, scoped to browser use only, and stores it here. Your existing credential is not copied."
              : "Copies the value now, so later changes to the original will not follow."}
          </p>
        </div>
      )}
      {provider === "vercel-sandbox" && (
        <>
          {/* Only offered where it can work. The host either has an ambient
              Vercel identity or it does not, and the server already knows
              which; asking the user to decide meant explaining OIDC to people
              on hosts where the option was guaranteed to fail. */}
          {hostIdentity && (
            <Label htmlFor="browser-vercel-ambient" className="flex items-center gap-2 text-sm">
              <Checkbox
                id="browser-vercel-ambient"
                checked={vercelAmbient}
                onCheckedChange={(checked) => setVercelAmbient(checked === true)}
              />
              <span>This host has its own Vercel identity. Use it instead of a token.</span>
            </Label>
          )}
          {!vercelAmbient && !reuse && !mint && (
            <SecretField name="credential" label={secretLabel!} />
          )}
        </>
      )}
      {provider === "cloudflare-browser-run" && !reuse && !mint && (
        <SecretField name="credential" label={secretLabel!} />
      )}
      {provider === "browser-use" && (
        <>
          {!reuse && !mint && <SecretField name="credential" label={secretLabel!} />}
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
          {/* Tuning and overrides live here rather than in the form proper.
              Every one of these has a working default, and a field with a
              default still reads as something to fill in when it sits next to
              the credential that genuinely is required. */}
          {provider === "vercel-sandbox" && !vercelAmbient && (
            <div className="mb-3 grid gap-3">
              <p className="text-xs text-muted-foreground">
                Team and project are read from the token. Set them only to override that choice.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field name="teamId" label="Team ID" placeholder="Inferred from token" />
                <Field name="projectId" label="Project ID" placeholder="Inferred from token" />
              </div>
              <Field
                name="image"
                label="Browser image"
                placeholder="Installed on first use if blank"
              />
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
            </div>
          )}
          {provider === "cloudflare-browser-run" && (
            <div className="mb-3 grid gap-3">
              <Field name="accountId" label="Account ID" placeholder="Inferred from token" />
              <Field
                name="keepAliveMs"
                label="Keep-alive (ms)"
                placeholder="600000"
                type="number"
                min={10000}
                max={1200000}
                step={10000}
              />
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field name="name" label="Display name" placeholder={providerLabels[provider]} />
            <Field name="connectionName" label="Connection" placeholder="default" />
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field name="slug" label="Tool namespace" placeholder="Generated automatically" />
            <Field
              name="idleTimeoutMinutes"
              label="Idle timeout (minutes)"
              placeholder="10"
              type="number"
              min={1}
              max={240}
              step={1}
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            An unused session is closed after the idle timeout so it stops costing money. The next
            browser call starts a fresh one, which does not keep open tabs or sign-ins.
          </p>
          {/* Left blank on purpose by most people: a remote browser already
              refuses private addresses, so nothing here is needed to be safe.
              Naming hosts is what turns per-action approvals into one. */}
          <div className="mt-3 grid gap-1.5">
            <Field
              name="allowedHosts"
              label="Allowed hosts"
              placeholder="example.com, docs.example.com — blank for any public site"
            />
            <p className="text-xs text-muted-foreground">
              Covers subdomains. Private and link-local addresses are always refused unless you
              allow them below. Name the hosts and this browser asks for approval once per session
              instead of once per click.
            </p>
          </div>
          <Label htmlFor="browser-full-access" className="mt-3 flex items-start gap-2 text-sm">
            <Checkbox
              id="browser-full-access"
              checked={fullAccess}
              onCheckedChange={(checked) => setFullAccess(checked === true)}
            />
            <span>
              Approve once per session
              <span className="block text-xs font-normal text-muted-foreground">
                Stops the prompt on every click. With no allowed-hosts list this browser may visit
                any public site, so approving the session approves wherever it goes. Private
                addresses are still refused, Advanced tools still ask, and you are asked again once
                the session closes. Naming hosts above does this on its own.
              </span>
            </span>
          </Label>
          <Label htmlFor="browser-allow-private" className="mt-3 flex items-start gap-2 text-sm">
            <Checkbox
              id="browser-allow-private"
              checked={allowPrivateNetwork}
              onCheckedChange={(checked) => setAllowPrivateNetwork(checked === true)}
            />
            <span>
              Reach private addresses
              <span className="block text-xs font-normal text-muted-foreground">
                For a target pointed at an internal app. Requires an allowed-hosts list, because a
                browser that can reach a private network and every public site is bounded by
                nothing.
              </span>
            </span>
          </Label>
          <Label htmlFor="browser-allow-advanced" className="mt-3 flex items-start gap-2 text-sm">
            <Checkbox
              id="browser-allow-advanced"
              checked={allowAdvanced}
              onCheckedChange={(checked) => setAllowAdvanced(checked !== false)}
            />
            <span>
              Advanced tools
              <span className="block text-xs font-normal text-muted-foreground">
                evaluate, PDF, console, network, dialogs, viewport. On by default for remote
                browsers, which are isolated and hold no personal session. Turning this off removes
                them from the tool catalog for this target.
              </span>
            </span>
          </Label>
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
    <div className="grid min-w-0 gap-2">
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
  const removeTarget = useAtomSet(removeTargetAtom, { mode: "promiseExit" });
  const testConnection = useAtomSet(testConnectionAtom, { mode: "promiseExit" });
  const trialRun = useAtomSet(trialRunAtom, { mode: "promiseExit" });
  const [adding, setAdding] = useState<RemoteProvider | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeErrors, setRemoveErrors] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, BrowserConnectionTestView>>({});
  const [trialling, setTrialling] = useState<string | null>(null);
  const [trials, setTrials] = useState<Record<string, BrowserTrialRunView>>({});
  const value = AsyncResult.isSuccess(overview) ? overview.value : null;
  const liveTargets = value?.targets.filter((target) => target.state === "live").length || 0;

  return (
    // The shell's <main> is overflow-hidden and every page owns its own
    // scrolling. Without this container the page could not scroll at all:
    // anything past the fold was clipped and unreachable.
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-8 px-5 py-7 md:px-8">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold">Browsers</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Local Chrome and isolated remote targets exposed as separate Executor tool addresses.
            </p>
          </div>
          <Button
            variant="outline"
            size="icon"
            onClick={() => refresh()}
            aria-label="Refresh browsers"
            title="Refresh browsers"
          >
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
            <h2 className="text-sm font-semibold uppercase text-muted-foreground">
              Browser targets
            </h2>
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
                      {target.failure && (
                        <div className="mt-2 border-l-2 border-destructive pl-2">
                          <p className="text-xs font-medium text-destructive">
                            {target.failure.hint}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Last start attempt {untilLabel(Date.now(), target.failure.failedAt)} ago
                          </p>
                        </div>
                      )}
                      {target.session && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Stops after {untilLabel(target.session.idleExpiresAt, Date.now())} idle
                        </p>
                      )}
                      {target.access && <AccessSummary access={target.access} />}
                      {target.address && (
                        <div className="mt-3 grid gap-1.5">
                          <div className="flex min-w-0 items-center rounded bg-muted pl-2">
                            <code className="min-w-0 flex-1 truncate py-1.5 text-xs">
                              {target.address}
                            </code>
                            <CopyButton value={target.address} className="mr-1" />
                          </div>
                          <p className="text-xs text-muted-foreground">
                            The tool address agents call. Paste it into a prompt to name this
                            browser.
                          </p>
                        </div>
                      )}
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        {target.address && (
                          <CopyButton
                            value={agentPromptFor(target)}
                            label="Copy prompt"
                            className="h-8 border px-2.5 text-foreground"
                          />
                        )}
                        {target.connection && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={testing === key}
                            onClick={async () => {
                              setTesting(key);
                              const exit = await testConnection({
                                params: {
                                  integration: target.integration,
                                  connection: target.connection!,
                                },
                              });
                              setTests((previous) => ({
                                ...previous,
                                [key]: Exit.isSuccess(exit)
                                  ? exit.value
                                  : {
                                      ok: false,
                                      detail: messageFromExit(exit, "Could not test this browser"),
                                      verified: false,
                                      checkedAt: Date.now(),
                                    },
                              }));
                              setTesting(null);
                            }}
                          >
                            <PlugZap className="size-3.5" />
                            {testing === key ? "Checking..." : "Check credential"}
                          </Button>
                        )}
                        {target.connection && target.provider !== "local-extension" && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={trialling === key}
                            /* Separate from the credential check because it
                               starts a real session and is billed like one. It
                               is also the only thing that answers "does this
                               actually browse?", which a probe cannot. */
                            title="Starts a real session, loads one page, then stops it"
                            onClick={async () => {
                              setTrialling(key);
                              const exit = await trialRun({
                                params: {
                                  integration: target.integration,
                                  connection: target.connection!,
                                },
                                reactivityKeys: ["browser-control"],
                              });
                              setTrials((previous) => ({
                                ...previous,
                                [key]: Exit.isSuccess(exit)
                                  ? exit.value
                                  : {
                                      ok: false,
                                      detail: messageFromExit(exit, "Could not run this browser"),
                                      ms: 0,
                                      ranAt: Date.now(),
                                    },
                              }));
                              setTrialling(null);
                            }}
                          >
                            <PlayCircle className="size-3.5" />
                            {trialling === key ? "Running..." : "Test run"}
                          </Button>
                        )}
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
                        {/* Local Chrome is not removable here: its lifecycle
                            belongs to the extension, and ensureChrome would
                            re-register it anyway, a Remove that undoes itself
                            reads as a bug. */}
                        {target.provider !== "local-extension" && target.connection && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            disabled={removing === key}
                            onClick={async () => {
                              if (
                                !window.confirm(
                                  `Remove "${target.name}"? Any running session is stopped and its credential is deleted.`,
                                )
                              ) {
                                return;
                              }
                              setRemoving(key);
                              const exit = await removeTarget({
                                params: {
                                  integration: target.integration,
                                  connection: target.connection!,
                                },
                                reactivityKeys: ["browser-control"],
                              });
                              setRemoveErrors((previous) => {
                                const next = { ...previous };
                                if (Exit.isSuccess(exit)) delete next[key];
                                else
                                  next[key] = messageFromExit(
                                    exit,
                                    "Could not remove this browser",
                                  );
                                return next;
                              });
                              setRemoving(null);
                            }}
                          >
                            <X className="size-3.5" />
                            {removing === key ? "Removing..." : "Remove"}
                          </Button>
                        )}
                      </div>
                      {removeErrors[key] && (
                        <p className="mt-2 text-xs text-destructive">{removeErrors[key]}</p>
                      )}
                      {tests[key] && <ConnectionTestResult result={tests[key]!} />}
                      {trials[key] && <TrialRunResult result={trials[key]!} />}
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
                    {/* Never disabled. This used to be greyed out for a provider
                        the host could not run, which hid the only instructions
                        for making it runnable behind the very state they fix. */}
                    <Button
                      variant={open ? "ghost" : "outline"}
                      size="sm"
                      onClick={() => setAdding(open ? null : provider.id)}
                    >
                      {open ? <X className="size-4" /> : <Plus className="size-4" />}
                      {open ? "Close" : provider.configured > 0 ? "Add target" : "Configure"}
                    </Button>
                  </div>
                  {open && (
                    <ProviderForm
                      provider={provider.id}
                      hostIdentity={provider.hostIdentity}
                      onDone={() => setAdding(null)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </div>
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
