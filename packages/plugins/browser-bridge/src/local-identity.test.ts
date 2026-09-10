import { describe, expect, it } from "@effect/vitest";

import {
  allocateConnectionName,
  DEFAULT_LOCAL_CONNECTION,
  localBrowserDisplayName,
  localToolAddress,
  parseLocalBrowserIdentity,
  preferredConnectionName,
} from "./local-identity";

describe("parseLocalBrowserIdentity", () => {
  it("reads instance, browser, and label from the client payload", () => {
    expect(
      parseLocalBrowserIdentity({
        client: { instanceId: "inst-1", browser: "Brave", label: "Lab Brave" },
        connection: { name: "brave" },
      }),
    ).toEqual({
      instanceId: "inst-1",
      browser: "Brave",
      label: "Lab Brave",
      requestedConnection: "brave",
    });
  });

  it("treats an older extension that only asked for desktop as empty identity", () => {
    expect(
      parseLocalBrowserIdentity({
        client: { name: "executor-browser", version: "0.11.2" },
        connection: { integration: "chrome", name: "desktop", owner: "user" },
      }),
    ).toEqual({ requestedConnection: "desktop" });
  });
});

describe("preferredConnectionName", () => {
  it("keeps unlabeled Chrome on desktop so existing agents keep working", () => {
    expect(preferredConnectionName({ browser: "Chrome" })).toBe(DEFAULT_LOCAL_CONNECTION);
    expect(preferredConnectionName({})).toBe(DEFAULT_LOCAL_CONNECTION);
  });

  it("names a non-Chrome browser after itself", () => {
    expect(preferredConnectionName({ browser: "Brave" })).toBe("brave");
    expect(preferredConnectionName({ browser: "Edge" })).toBe("edge");
  });

  it("prefers a user label over the product name", () => {
    expect(preferredConnectionName({ browser: "Chrome", label: "Work" })).toBe("work");
  });

  it("honours a requested name other than desktop", () => {
    expect(
      preferredConnectionName({
        browser: "Chrome",
        requestedConnection: "herdrChrome",
      }),
    ).toBe("herdrChrome");
  });
});

describe("allocateConnectionName", () => {
  it("gives Chrome desktop and Brave its own name", () => {
    const chrome = allocateConnectionName({ browser: "Chrome", instanceId: "a" }, []);
    const brave = allocateConnectionName({ browser: "Brave", instanceId: "b" }, [chrome]);
    expect(chrome).toBe("desktop");
    expect(brave).toBe("brave");
  });

  it("uniquifies a second Chrome instead of stealing desktop", () => {
    expect(allocateConnectionName({ browser: "Chrome", instanceId: "b" }, ["desktop"])).toBe(
      "chrome",
    );
    expect(
      allocateConnectionName({ browser: "Chrome", instanceId: "c" }, ["desktop", "chrome"]),
    ).toBe("chrome2");
  });

  it("uniquifies two Braves", () => {
    expect(allocateConnectionName({ browser: "Brave", instanceId: "b" }, ["brave"])).toBe("brave2");
  });
});

describe("localToolAddress", () => {
  it("is the execute path agents already call", () => {
    expect(localToolAddress("desktop")).toBe("tools.browser.user.desktop");
    expect(localToolAddress("brave")).toBe("tools.browser.user.brave");
  });
});

describe("localBrowserDisplayName", () => {
  it("prefers the label, then the product", () => {
    expect(localBrowserDisplayName({ label: "Work", browser: "Chrome" })).toBe("Work");
    expect(localBrowserDisplayName({ browser: "Brave" })).toBe("Brave");
    expect(localBrowserDisplayName({ connectionName: "desktop" })).toBe("desktop");
  });
});
