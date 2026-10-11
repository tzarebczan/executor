import assert from "node:assert/strict";
import { test } from "node:test";
import { createBridge } from "./bridge.ts";
import { renderBrowsersPage } from "./page.ts";

const principal = { userId: "user-1" };

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://executor.test${path}`, init);
}

test("an anonymous probe names the browser channel", async () => {
  const bridge = createBridge();
  const response = await bridge.handle(request("/api/browser-bridge/sessions"), null);
  assert.equal(response.status, 401);
  assert.match(await response.text(), /browser bridge/);
});

test("a connected browser receives a call and returns its result", async () => {
  const bridge = createBridge();
  const opened = await bridge.handle(
    request("/api/browser-bridge/session", {
      method: "POST",
      body: JSON.stringify({ client: { browser: "Chrome", instanceId: "one" } }),
    }),
    principal,
  );
  const session = await opened.json() as { id: string; connection: string };
  assert.equal(session.connection, "desktop");

  const call = bridge.callTool({ userId: principal.userId, tool: "snapshot", args: {} });
  const jobsResponse = await bridge.handle(
    request(`/api/browser-bridge/session/${session.id}/jobs?waitMs=1000`),
    principal,
  );
  const jobs = await jobsResponse.json() as { jobs: Array<{ id: string; tool: string }> };
  assert.equal(jobs.jobs[0]?.tool, "snapshot");
  const posted = await bridge.handle(
    request(`/api/browser-bridge/session/${session.id}/result`, {
      method: "POST",
      body: JSON.stringify({ jobId: jobs.jobs[0]?.id, result: { title: "Example" } }),
    }),
    principal,
  );
  assert.equal(posted.status, 200);
  const result = await call;
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.result, { title: "Example" });
});

test("the status page lists a live browser and its developer-tools mode", async () => {
  const bridge = createBridge();
  await bridge.handle(
    request("/api/browser-bridge/session", {
      method: "POST",
      body: JSON.stringify({
        client: { browser: "Chrome", label: "Work", instanceId: "work" },
        capabilities: { access: { cdpMode: "always", advanced: true } },
      }),
    }),
    principal,
  );
  const listed = bridge.listPublic(principal.userId);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.label, "Work");
  const access = listed[0]?.capabilities as { access?: { cdpMode?: string } };
  assert.equal(access.access?.cdpMode, "always");
  const html = renderBrowsersPage({
    signedIn: true,
    sessions: listed,
    origin: "https://executor.example",
  });
  assert.match(html, /CDP always on/);
  assert.match(html, /1 connected/);
  assert.match(html, /tools\.browser\.user\.work/);
  assert.doesNotMatch(html, /https?:\/\/[^"']+\.(?:woff2|css|js)/);
});

test("mcp tools/call waits on the connected browser", async () => {
  const bridge = createBridge();
  const opened = await bridge.handle(
    request("/api/browser-bridge/session", {
      method: "POST",
      body: JSON.stringify({ client: { instanceId: "mcp" } }),
    }),
    principal,
  );
  const session = await opened.json() as { id: string };
  const call = bridge.handle(
    request("/api/browser-bridge/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ping", arguments: {} } }),
    }),
    principal,
  );
  const jobsResponse = await bridge.handle(
    request(`/api/browser-bridge/session/${session.id}/jobs?waitMs=1000`),
    principal,
  );
  const jobs = await jobsResponse.json() as { jobs: Array<{ id: string }> };
  await bridge.handle(
    request(`/api/browser-bridge/session/${session.id}/result`, {
      method: "POST",
      body: JSON.stringify({ jobId: jobs.jobs[0]?.id, result: { ok: true } }),
    }),
    principal,
  );
  const response = await call;
  const body = await response.json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
  assert.equal(body.result.isError, undefined);
  assert.match(body.result.content[0]?.text ?? "", /"ok":true/);
});
