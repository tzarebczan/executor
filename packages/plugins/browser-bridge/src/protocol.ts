/* oxlint-disable executor/no-error-constructor, executor/no-try-catch-or-throw, executor/no-switch-statement -- boundary: this is the untrusted-input parser for the tool protocol; it throws precise caller errors that every call site converts into typed failures, and dispatches on JSON Schema's `type` string rather than a tagged union */

export const BROWSER_PROTOCOL_VERSION = 2 as const;

export type BrowserModifier = "Alt" | "Control" | "Meta" | "Shift";
export type BrowserMouseButton = "left" | "middle" | "right";

export interface BrowserTabTarget {
  readonly tabId?: number;
}

export interface BrowserElementTarget extends BrowserTabTarget {
  readonly frameId?: number;
  readonly selector?: string;
  readonly nodeIndex?: number;
}

export interface BrowserPointTarget extends BrowserElementTarget {
  readonly x?: number;
  readonly y?: number;
}

export interface BrowserToolInputMap {
  readonly ping: Record<string, never>;
  readonly "tabs.list": Record<string, never>;
  readonly "tabs.open": { readonly url: string; readonly active?: boolean };
  readonly "tabs.activate": { readonly tabId: number };
  readonly "tabs.close": { readonly tabId: number };
  readonly navigate: BrowserTabTarget & { readonly url: string; readonly newTab?: boolean };
  readonly back: BrowserTabTarget;
  readonly forward: BrowserTabTarget;
  readonly reload: BrowserTabTarget & { readonly bypassCache?: boolean };
  readonly snapshot: BrowserTabTarget & {
    readonly maxNodes?: number;
    readonly includeHidden?: boolean;
  };
  readonly find: BrowserTabTarget & {
    readonly text?: string;
    readonly role?: string;
    readonly selector?: string;
    readonly limit?: number;
  };
  readonly wait: BrowserTabTarget & {
    readonly selector?: string;
    readonly text?: string;
    readonly url?: string;
    readonly state?: "attached" | "visible" | "hidden" | "gone" | "load" | "idle";
    readonly timeoutMs?: number;
  };
  readonly click: BrowserPointTarget & {
    readonly button?: BrowserMouseButton;
    readonly clickCount?: number;
    readonly modifiers?: readonly BrowserModifier[];
  };
  readonly dblclick: BrowserPointTarget & { readonly modifiers?: readonly BrowserModifier[] };
  readonly hover: BrowserPointTarget;
  readonly focus: BrowserElementTarget;
  readonly type: BrowserElementTarget & {
    readonly text: string;
    readonly clear?: boolean;
    readonly submit?: boolean;
  };
  readonly press: BrowserElementTarget & {
    readonly key: string;
    readonly modifiers?: readonly BrowserModifier[];
  };
  readonly select: BrowserElementTarget & { readonly values: readonly string[] };
  readonly check: BrowserElementTarget & { readonly checked: boolean };
  readonly scroll: BrowserElementTarget & {
    readonly x?: number;
    readonly y?: number;
    readonly deltaX?: number;
    readonly deltaY?: number;
  };
  readonly screenshot: BrowserTabTarget & {
    readonly fullPage?: boolean;
    readonly format?: "jpeg" | "png";
    readonly quality?: number;
  };
  readonly upload: BrowserElementTarget & {
    readonly files: readonly {
      readonly name: string;
      readonly mimeType?: string;
      readonly dataBase64: string;
    }[];
  };
  readonly "downloads.list": {
    readonly limit?: number;
    readonly state?: "in_progress" | "complete" | "interrupted";
  };
  readonly "dialog.handle": { readonly accept: boolean; readonly promptText?: string };
  readonly "console.list": BrowserTabTarget & {
    readonly level?: "all" | "error" | "warning" | "info" | "debug";
    readonly clear?: boolean;
  };
  readonly "network.list": BrowserTabTarget & {
    readonly filter?: string;
    readonly limit?: number;
    readonly clear?: boolean;
  };
  readonly evaluate: BrowserTabTarget & {
    readonly expression: string;
    readonly awaitPromise?: boolean;
  };
  readonly pdf: BrowserTabTarget & {
    readonly landscape?: boolean;
    readonly printBackground?: boolean;
  };
  readonly "viewport.set": BrowserTabTarget & {
    readonly width: number;
    readonly height: number;
    readonly deviceScaleFactor?: number;
  };
  readonly drag: BrowserTabTarget & {
    readonly from: BrowserPointTarget;
    readonly to: BrowserPointTarget;
  };
  readonly "cookies.list": BrowserTabTarget & { readonly domain?: string };
  readonly "cookies.clear": BrowserTabTarget & { readonly domain?: string };
  readonly "storage.clear": BrowserTabTarget & {
    readonly local?: boolean;
    readonly session?: boolean;
  };
  readonly "tabs.waitForNew": { readonly timeoutMs?: number };
}

export type BrowserToolName = keyof BrowserToolInputMap;

export type BrowserToolCall<Name extends BrowserToolName = BrowserToolName> = {
  readonly tool: Name;
  readonly args: BrowserToolInputMap[Name];
};

export interface BrowserTab {
  readonly id: number;
  readonly windowId?: number;
  readonly groupId?: number;
  readonly active?: boolean;
  readonly title?: string;
  readonly url?: string;
  readonly controlled?: boolean;
}

export interface BrowserSnapshotNode {
  readonly index: number;
  readonly frameId?: number;
  readonly role?: string;
  readonly name?: string;
  readonly tag?: string;
  readonly text?: string;
  readonly selector?: string;
  readonly disabled?: boolean;
  readonly checked?: boolean;
  readonly value?: string;
}

/**
 * Stable machine-readable reasons a browser tool call failed.
 *
 * Prose changes; these do not. An agent deciding whether to retry, ask the user
 * to widen access, or give up needs to tell "the tab is gone" from "you are not
 * allowed to touch it", and a message string cannot carry that reliably.
 */
export const BROWSER_ERROR_CODES = Object.freeze({
  /** Advanced mode is off in the extension's settings. */
  advancedDisabled: "ADVANCED_MODE_DISABLED",
  /** A control session must be running before this tool is permitted. */
  sessionRequired: "CONTROL_SESSION_REQUIRED",
  /** The tab exists but is outside the Executor tab group. */
  outsideGroup: "TAB_OUTSIDE_EXECUTOR_GROUP",
  /** The tab's host is not in the Limited-mode allowlist. */
  hostNotAllowed: "HOST_NOT_IN_ALLOWLIST",
  /** No tab matched, genuinely absent, as opposed to refused. */
  noTab: "NO_TARGET_TAB",
  /** This target does not publish the requested tool. */
  unsupported: "TOOL_NOT_SUPPORTED",
  /** The tool ran and the browser reported a failure. */
  failed: "TOOL_FAILED",
});

export type BrowserErrorCode = (typeof BROWSER_ERROR_CODES)[keyof typeof BROWSER_ERROR_CODES];

export type BrowserToolError = {
  readonly ok: false;
  readonly error: string;
  /** Optional only for compatibility with older extensions; always sent now. */
  readonly code?: BrowserErrorCode | (string & {});
  readonly supported?: readonly BrowserToolName[];
};

/**
 * Captured page telemetry. Spelled out rather than left as an untyped bag: the
 * shapes are a contract with agents, and `Record<string, unknown>[]` told them
 * nothing about what they would get or what had been redacted out of it.
 */
export interface BrowserConsoleEntry {
  readonly level: string;
  /** Redacted before capture, see the extension's `redact` module. */
  readonly text: string;
  readonly timestamp: number;
  readonly tabId: number;
}

export interface BrowserNetworkEntry {
  readonly method: string;
  /** Origin and path only; query and fragment are stripped at capture time. */
  readonly url: string;
  readonly resourceType: string;
  readonly timestamp: number;
  readonly tabId: number;
  readonly status?: number;
}

export interface BrowserDownloadEntry {
  readonly id: string;
  readonly filename: string;
  readonly state: "in_progress" | "complete" | "interrupted";
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly bytes?: number;
}

export interface BrowserToolSuccessMap {
  readonly ping: {
    readonly ok: true;
    readonly mode: string;
    readonly ts: number;
    readonly protocolVersion: number;
  };
  readonly "tabs.list": { readonly ok: true; readonly tabs: readonly BrowserTab[] };
  readonly "tabs.open": { readonly ok: true; readonly tab: BrowserTab };
  readonly "tabs.activate": { readonly ok: true; readonly tab: BrowserTab };
  readonly "tabs.close": { readonly ok: true; readonly tabId: number };
  readonly navigate: { readonly ok: true; readonly tab: BrowserTab };
  readonly back: { readonly ok: true; readonly tab: BrowserTab };
  readonly forward: { readonly ok: true; readonly tab: BrowserTab };
  readonly reload: { readonly ok: true; readonly tab: BrowserTab };
  readonly snapshot: {
    readonly ok: true;
    readonly tab: BrowserTab;
    readonly snapshot: {
      readonly title?: string;
      readonly url?: string;
      readonly nodes: readonly BrowserSnapshotNode[];
      readonly truncated?: boolean;
    };
  };
  readonly find: {
    readonly ok: true;
    readonly tab: BrowserTab;
    readonly matches: readonly BrowserSnapshotNode[];
  };
  readonly wait: { readonly ok: true; readonly matched: true; readonly elapsedMs: number };
  /**
   * `url` is where the tab ended up, and `navigated` says the action moved it
   * there. Both are optional so an implementation that cannot tell may omit
   * them, but reporting them is what lets a caller verify a click without a
   * second call — and that second call is the one that used to race the
   * navigation the click had just started.
   */
  readonly click: {
    readonly ok: true;
    readonly tabId: number;
    readonly url?: string;
    readonly navigated?: boolean;
  };
  readonly dblclick: {
    readonly ok: true;
    readonly tabId: number;
    readonly url?: string;
    readonly navigated?: boolean;
  };
  readonly hover: { readonly ok: true; readonly tabId: number };
  readonly focus: { readonly ok: true; readonly tabId: number };
  readonly type: { readonly ok: true; readonly tabId: number };
  readonly press: {
    readonly ok: true;
    readonly tabId: number;
    readonly url?: string;
    readonly navigated?: boolean;
  };
  readonly select: {
    readonly ok: true;
    readonly tabId: number;
    readonly values: readonly string[];
  };
  readonly check: { readonly ok: true; readonly tabId: number; readonly checked: boolean };
  readonly scroll: { readonly ok: true; readonly tabId: number };
  readonly screenshot: {
    readonly ok: true;
    readonly tab: BrowserTab;
    readonly dataUrl: string;
    readonly bytes: number;
    readonly mime: "image/jpeg" | "image/png";
  };
  readonly upload: { readonly ok: true; readonly tabId: number; readonly files: readonly string[] };
  readonly "downloads.list": {
    readonly ok: true;
    readonly downloads: readonly BrowserDownloadEntry[];
  };
  readonly "dialog.handle": { readonly ok: true; readonly handled: true };
  readonly "console.list": {
    readonly ok: true;
    readonly messages: readonly BrowserConsoleEntry[];
  };
  readonly "network.list": {
    readonly ok: true;
    readonly requests: readonly BrowserNetworkEntry[];
  };
  readonly evaluate: { readonly ok: true; readonly value: unknown; readonly type?: string };
  readonly pdf: {
    readonly ok: true;
    readonly dataBase64: string;
    readonly bytes: number;
    readonly mime: "application/pdf";
  };
  readonly "viewport.set": {
    readonly ok: true;
    readonly width: number;
    readonly height: number;
    readonly deviceScaleFactor: number;
  };
  readonly drag: { readonly ok: true; readonly tabId: number };
  /**
   * Cookie metadata without values.
   *
   * A session cookie is the sign-in it belongs to. Reading one out of a browser
   * and into a transcript hands over the account, so the shape of the jar is
   * reported and its contents are not. Clearing needs no value at all.
   */
  readonly "cookies.list": {
    readonly ok: true;
    readonly cookies: readonly {
      readonly name: string;
      readonly domain: string;
      readonly path: string;
      readonly expires?: number;
      readonly httpOnly: boolean;
      readonly secure: boolean;
      readonly sameSite?: string;
    }[];
  };
  readonly "cookies.clear": { readonly ok: true; readonly cleared: number };
  readonly "storage.clear": { readonly ok: true; readonly tabId: number };
  readonly "tabs.waitForNew": { readonly ok: true; readonly tab: BrowserTab };
}

export type BrowserToolResult<Name extends BrowserToolName> =
  | BrowserToolSuccessMap[Name]
  | BrowserToolError;

export interface BrowserCapabilityAdvertisement {
  readonly protocolVersion: typeof BROWSER_PROTOCOL_VERSION;
  readonly mode: "extension-reverse" | "cloud";
  readonly tools: readonly BrowserToolName[];
  /**
   * What the extension will actually let through, as it sees it. Declared in
   * full, the console shows this to the user, so a field the extension sends
   * and this type omits is a scope the user cannot see.
   */
  readonly access?: {
    readonly mode: "limited" | "full";
    readonly sessionActive: boolean;
    readonly advanced: boolean;
    /** Hosts reachable in limited mode. Empty or absent means no host limit. */
    readonly allowedHosts?: readonly string[];
    /** Epoch ms when the control session lapses; null when none is running. */
    readonly expiresAt?: number | null;
  };
}

export type BrowserToolRisk = "read" | "write" | "sensitive";

export type BrowserToolDefinition = {
  readonly description: string;
  readonly risk: BrowserToolRisk;
  readonly advanced?: boolean;
  readonly inputSchema: Record<string, unknown>;
};

const empty = { type: "object", additionalProperties: false } as const;
const tabId = { type: "integer", minimum: 0 } as const;
const frameId = { type: "integer", minimum: 0 } as const;
const selector = { type: "string", minLength: 1 } as const;
const nodeIndex = { type: "integer", minimum: 0, maximum: 999 } as const;
const httpUrl = { type: "string", pattern: "^https?://" } as const;
const tabProperties = { tabId } as const;
const elementProperties = { ...tabProperties, frameId, selector, nodeIndex } as const;
const pointProperties = {
  ...elementProperties,
  x: { type: "number" },
  y: { type: "number" },
} as const;
const modifiers = {
  type: "array",
  items: { type: "string", enum: ["Alt", "Control", "Meta", "Shift"] },
  uniqueItems: true,
} as const;

const objectSchema = (
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): Record<string, unknown> => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

export const BROWSER_TOOL_DEFINITIONS = {
  ping: { description: "Check extension liveness.", risk: "read", inputSchema: empty },
  "tabs.list": {
    description: "List tabs visible to the active control session.",
    risk: "read",
    inputSchema: empty,
  },
  "tabs.open": {
    description: "Open an HTTP(S) URL in a controlled tab.",
    risk: "write",
    inputSchema: objectSchema({ url: httpUrl, active: { type: "boolean" } }, ["url"]),
  },
  "tabs.activate": {
    description: "Activate a controlled tab.",
    risk: "write",
    inputSchema: objectSchema({ tabId }, ["tabId"]),
  },
  "tabs.close": {
    description: "Close a controlled tab.",
    risk: "write",
    inputSchema: objectSchema({ tabId }, ["tabId"]),
  },
  navigate: {
    description: "Navigate a controlled tab to an HTTP(S) URL.",
    risk: "write",
    inputSchema: objectSchema({ ...tabProperties, url: httpUrl, newTab: { type: "boolean" } }, [
      "url",
    ]),
  },
  back: {
    description: "Go back in a controlled tab.",
    risk: "write",
    inputSchema: objectSchema(tabProperties),
  },
  forward: {
    description: "Go forward in a controlled tab.",
    risk: "write",
    inputSchema: objectSchema(tabProperties),
  },
  reload: {
    description: "Reload a controlled tab.",
    risk: "write",
    inputSchema: objectSchema({ ...tabProperties, bypassCache: { type: "boolean" } }),
  },
  snapshot: {
    description:
      "Read the page: a structured snapshot of visible elements and text across frames, with a node index for each element that click, type, and the other actions accept.",
    risk: "read",
    inputSchema: objectSchema({
      ...tabProperties,
      maxNodes: { type: "integer", minimum: 1, maximum: 1000 },
      includeHidden: { type: "boolean" },
    }),
  },
  find: {
    description: "Find page elements by text, role, or selector.",
    risk: "read",
    inputSchema: objectSchema({
      ...tabProperties,
      text: { type: "string", minLength: 1 },
      role: { type: "string", minLength: 1 },
      selector,
      limit: { type: "integer", minimum: 1, maximum: 100 },
    }),
  },
  wait: {
    description:
      "Wait for a condition instead of sleeping: an element to appear or disappear, text to show up, the URL to match, or the page to finish loading. Always prefer this over a delay.",
    risk: "read",
    inputSchema: objectSchema({
      ...tabProperties,
      selector,
      text: { type: "string", minLength: 1 },
      url: { type: "string", minLength: 1 },
      // "load" and "idle" describe the page rather than an element, which is
      // what someone reaches for after a click when they do not know which
      // element proves the new page arrived.
      state: {
        type: "string",
        enum: ["attached", "visible", "hidden", "gone", "load", "idle"],
      },
      timeoutMs: { type: "integer", minimum: 100, maximum: 120000 },
    }),
  },
  click: {
    description: "Click by element handle, selector, or viewport coordinates.",
    risk: "write",
    inputSchema: objectSchema({
      ...pointProperties,
      button: { type: "string", enum: ["left", "middle", "right"] },
      clickCount: { type: "integer", minimum: 1, maximum: 3 },
      modifiers,
    }),
  },
  dblclick: {
    description: "Double-click an element.",
    risk: "write",
    inputSchema: objectSchema({ ...pointProperties, modifiers }),
  },
  hover: {
    description: "Hover an element or viewport point.",
    risk: "write",
    inputSchema: objectSchema(pointProperties),
  },
  focus: {
    description: "Focus an element.",
    risk: "write",
    inputSchema: objectSchema(elementProperties),
  },
  type: {
    description: "Fill or type text into an editable element.",
    risk: "sensitive",
    inputSchema: objectSchema(
      {
        ...elementProperties,
        text: { type: "string" },
        clear: { type: "boolean" },
        submit: { type: "boolean" },
      },
      ["text"],
    ),
  },
  press: {
    // Named for the words someone searches with. A review of this surface
    // reported keyboard input as missing while `press` was published the whole
    // time, because nothing in its description said "Enter" or "shortcut".
    description:
      "Press a keyboard key or keyboard shortcut: Enter, Escape, Tab, Backspace, Delete, arrow keys, F-keys, or a letter with Control, Alt, Shift, or Meta held. Optionally targets an element first.",
    risk: "write",
    inputSchema: objectSchema(
      { ...elementProperties, key: { type: "string", minLength: 1 }, modifiers },
      ["key"],
    ),
  },
  select: {
    description:
      "Choose an option in a native select dropdown or combo box, including multi-select lists.",
    risk: "write",
    inputSchema: objectSchema(
      {
        ...elementProperties,
        values: { type: "array", items: { type: "string" }, minItems: 1 },
      },
      ["values"],
    ),
  },
  check: {
    description: "Set a checkbox or radio control state.",
    risk: "write",
    inputSchema: objectSchema({ ...elementProperties, checked: { type: "boolean" } }, ["checked"]),
  },
  scroll: {
    description: "Scroll the page or an element.",
    risk: "write",
    inputSchema: objectSchema({
      ...elementProperties,
      x: { type: "number" },
      y: { type: "number" },
      deltaX: { type: "number" },
      deltaY: { type: "number" },
    }),
  },
  screenshot: {
    description: "Capture the visible viewport or, in Advanced mode, the full page.",
    risk: "sensitive",
    inputSchema: objectSchema({
      ...tabProperties,
      fullPage: { type: "boolean" },
      format: { type: "string", enum: ["jpeg", "png"] },
      quality: { type: "integer", minimum: 1, maximum: 100 },
    }),
  },
  upload: {
    description:
      "Upload a file: attach in-memory file contents to a file input or attachment control on the page.",
    risk: "sensitive",
    inputSchema: objectSchema(
      {
        ...elementProperties,
        files: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          items: objectSchema(
            {
              name: { type: "string", minLength: 1 },
              mimeType: { type: "string" },
              dataBase64: { type: "string", minLength: 1 },
            },
            ["name", "dataBase64"],
          ),
        },
      },
      ["files"],
    ),
  },
  "downloads.list": {
    // Kept alongside the others so a search for "download" lands somewhere,
    // even though this lists rather than fetches.
    description:
      "List downloaded files and their progress. Names and states only; file contents are not read.",
    risk: "read",
    inputSchema: objectSchema({
      limit: { type: "integer", minimum: 1, maximum: 100 },
      state: { type: "string", enum: ["in_progress", "complete", "interrupted"] },
    }),
  },
  "dialog.handle": {
    description:
      "Accept or dismiss a JavaScript dialog: alert, confirm, prompt, or an onbeforeunload leave-site popup.",
    risk: "sensitive",
    advanced: true,
    inputSchema: objectSchema({ accept: { type: "boolean" }, promptText: { type: "string" } }, [
      "accept",
    ]),
  },
  "console.list": {
    description:
      "Read console output and page errors captured for this tab: console.log, warnings, uncaught exceptions, and stack traces. Values are redacted. Advanced mode.",
    risk: "read",
    advanced: true,
    inputSchema: objectSchema({
      ...tabProperties,
      level: { type: "string", enum: ["all", "error", "warning", "info", "debug"] },
      clear: { type: "boolean" },
    }),
  },
  "network.list": {
    description:
      "Inspect network activity for this tab: requests, response status codes, and failed or blocked requests. Metadata only, redacted, no bodies. Advanced mode.",
    risk: "sensitive",
    advanced: true,
    inputSchema: objectSchema({
      ...tabProperties,
      filter: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 500 },
      clear: { type: "boolean" },
    }),
  },
  evaluate: {
    description: "Evaluate JavaScript in a controlled tab in Advanced mode.",
    risk: "sensitive",
    advanced: true,
    inputSchema: objectSchema(
      {
        ...tabProperties,
        expression: { type: "string", minLength: 1 },
        awaitPromise: { type: "boolean" },
      },
      ["expression"],
    ),
  },
  pdf: {
    description: "Print the current page to PDF in Advanced mode.",
    risk: "sensitive",
    advanced: true,
    inputSchema: objectSchema({
      ...tabProperties,
      landscape: { type: "boolean" },
      printBackground: { type: "boolean" },
    }),
  },
  "viewport.set": {
    description:
      "Set the viewport: window width, height, and device pixel ratio, for responsive or mobile-sized rendering. Advanced mode.",
    risk: "write",
    advanced: true,
    inputSchema: objectSchema(
      {
        ...tabProperties,
        width: { type: "integer", minimum: 200, maximum: 7680 },
        height: { type: "integer", minimum: 200, maximum: 4320 },
        deviceScaleFactor: { type: "number", minimum: 0.5, maximum: 4 },
      },
      ["width", "height"],
    ),
  },
  drag: {
    description:
      "Drag and drop: press the mouse on one element or point, move to another, and release. For sliders, reorderable lists, and drag-to-upload targets.",
    risk: "write",
    inputSchema: objectSchema(
      {
        ...tabProperties,
        from: { type: "object" },
        to: { type: "object" },
      },
      ["from", "to"],
    ),
  },
  "cookies.list": {
    // Values are never returned. A session cookie is the sign-in it belongs to,
    // so reading one into a transcript hands over the account.
    description:
      "List cookies for the current page: names, domains, paths, expiry, and flags. Values are never returned.",
    risk: "sensitive",
    advanced: true,
    inputSchema: objectSchema({ ...tabProperties, domain: { type: "string", minLength: 1 } }),
  },
  "cookies.clear": {
    description:
      "Clear cookies for the current page or a domain, to sign out or start a clean session.",
    risk: "write",
    inputSchema: objectSchema({ ...tabProperties, domain: { type: "string", minLength: 1 } }),
  },
  "storage.clear": {
    description:
      "Clear localStorage and sessionStorage for the current page, to reset stored app state.",
    risk: "write",
    inputSchema: objectSchema({
      ...tabProperties,
      local: { type: "boolean" },
      session: { type: "boolean" },
    }),
  },
  "tabs.waitForNew": {
    description:
      "Wait for a popup or new tab to open, such as an OAuth or payment window, and return it once it has.",
    risk: "read",
    inputSchema: objectSchema({ timeoutMs: { type: "integer", minimum: 100, maximum: 120000 } }),
  },
} as const satisfies Record<BrowserToolName, BrowserToolDefinition>;

export const BROWSER_TOOL_NAMES = Object.freeze(
  Object.keys(BROWSER_TOOL_DEFINITIONS) as BrowserToolName[],
);

/**
 * Tools the local extension gates behind Advanced mode, and that a remote
 * target may withhold. Read through this rather than off the frozen literal,
 * whose per-tool types only carry `advanced` where it is set.
 */
export const isAdvancedBrowserTool = (name: BrowserToolName): boolean =>
  (BROWSER_TOOL_DEFINITIONS[name] as BrowserToolDefinition).advanced === true;

export const browserToolCatalogName = (name: BrowserToolName): string => name.replaceAll(".", "_");

export const browserToolNameFromCatalog = (name: string): BrowserToolName | undefined =>
  BROWSER_TOOL_NAMES.find((candidate) => browserToolCatalogName(candidate) === name);

export const isBrowserToolName = (value: string): value is BrowserToolName =>
  Object.hasOwn(BROWSER_TOOL_DEFINITIONS, value);

type JsonSchema = {
  readonly type?: string;
  readonly enum?: readonly unknown[];
  readonly pattern?: string;
  readonly minLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly items?: JsonSchema;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
};

function validateSchema(value: unknown, schema: JsonSchema, path: string): void {
  if (schema.enum && !schema.enum.includes(value)) {
    throw new Error(`${path} must be one of: ${schema.enum.join(", ")}`);
  }

  switch (schema.type) {
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${path} must be an object`);
      }
      const record = value as Record<string, unknown>;
      for (const required of schema.required || []) {
        if (!(required in record)) throw new Error(`${path}.${required} is required`);
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(record)) {
          if (!Object.hasOwn(schema.properties || {}, key)) {
            throw new Error(`Unexpected argument ${path}.${key}`);
          }
        }
      }
      for (const [key, child] of Object.entries(schema.properties || {})) {
        if (record[key] !== undefined) validateSchema(record[key], child, `${path}.${key}`);
      }
      return;
    }
    case "array": {
      if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
      if (schema.minItems != null && value.length < schema.minItems) {
        throw new Error(`${path} must contain at least ${schema.minItems} item(s)`);
      }
      if (schema.maxItems != null && value.length > schema.maxItems) {
        throw new Error(`${path} must contain at most ${schema.maxItems} item(s)`);
      }
      if (schema.uniqueItems && new Set(value).size !== value.length) {
        throw new Error(`${path} must contain unique items`);
      }
      if (schema.items)
        value.forEach((item, index) => validateSchema(item, schema.items!, `${path}[${index}]`));
      return;
    }
    case "string":
      if (typeof value !== "string") throw new Error(`${path} must be a string`);
      if (schema.minLength != null && value.length < schema.minLength) {
        throw new Error(`${path} must not be empty`);
      }
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
        throw new Error(`${path} has an invalid format`);
      }
      return;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new Error(`${path} must be an integer`);
      }
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${path} must be a finite number`);
      }
      break;
    case "boolean":
      if (typeof value !== "boolean") throw new Error(`${path} must be boolean`);
      return;
    default:
      return;
  }

  // Only the integer/number cases fall through to here, and both already
  // rejected non-numbers, so this narrow always holds.
  if (typeof value !== "number") return;
  if (schema.minimum != null && value < schema.minimum) {
    throw new Error(`${path} must be at least ${schema.minimum}`);
  }
  if (schema.maximum != null && value > schema.maximum) {
    throw new Error(`${path} must be at most ${schema.maximum}`);
  }
}

function assertHttpUrl(value: unknown, path: string): void {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${path} must be a valid HTTP(S) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${path} must use HTTP or HTTPS`);
  }
}

function hasElementTarget(args: Record<string, unknown>): boolean {
  return typeof args.selector === "string" || Number.isInteger(args.nodeIndex);
}

function hasPointTarget(args: Record<string, unknown>): boolean {
  return hasElementTarget(args) || (typeof args.x === "number" && typeof args.y === "number");
}

export function validateBrowserToolCall(toolRaw: unknown, argsRaw: unknown): BrowserToolCall {
  const tool = String(toolRaw || "");
  if (!isBrowserToolName(tool)) {
    throw new Error(`Unknown browser tool "${tool}". Use one of: ${BROWSER_TOOL_NAMES.join(", ")}`);
  }
  const args = argsRaw == null ? {} : argsRaw;
  validateSchema(args, BROWSER_TOOL_DEFINITIONS[tool].inputSchema as JsonSchema, "args");
  const record = args as Record<string, unknown>;

  if (tool === "tabs.open" || tool === "navigate") assertHttpUrl(record.url, "args.url");
  if (["click", "dblclick", "hover"].includes(tool) && !hasPointTarget(record)) {
    throw new Error(`${tool} requires selector, nodeIndex, or x and y`);
  }
  if (["focus", "select", "check", "upload"].includes(tool) && !hasElementTarget(record)) {
    throw new Error(`${tool} requires selector or nodeIndex`);
  }
  if (tool === "find" && !record.text && !record.role && !record.selector) {
    throw new Error("find requires text, role, or selector");
  }
  // A load state waits on the page rather than on anything named, so it is a
  // complete instruction by itself.
  const loadState = record.state === "load" || record.state === "idle";
  if (tool === "wait" && !record.text && !record.url && !record.selector && !loadState) {
    throw new Error("wait requires text, url, selector, or state: load or idle");
  }
  if (tool === "upload") {
    const files = record.files as readonly { readonly dataBase64: string }[];
    const encodedBytes = files.reduce((total, file) => total + file.dataBase64.length, 0);
    if (encodedBytes > 14_000_000)
      throw new Error("upload payload exceeds the 10 MB decoded limit");
  }

  return { tool, args } as BrowserToolCall;
}
