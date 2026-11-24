import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CAPABILITY_CACHE_TTL_MS, CapabilityCache, type Capabilities } from "../src/capabilities.js";
import { CONNECTIONS_UNAVAILABLE } from "../src/connector-tools.js";
import { MEMORY_TOOLS } from "../src/memory-tools.js";
import {
  CONNECTIONS_LATE_NOTE,
  createBridgeServer,
  createMemoryMcpServer,
  staticKey,
  type BridgeOptions,
  type KeySource,
} from "../src/server.js";

const GW = "https://acme.s.eragon.ai/gw";
const TOKEN = "esk_test_token_0123456789";
const MEMORY_NAMES = ["memory_search", "memory_save", "memory_share"];
const CONNECTOR_NAMES = ["connector_tools", "connector_call", "connector_call_status", "connector_request_auth"];
const TOOL_IDS = ["slack.search_messages", "slack.list_channels", "slack.conversation_history", "slack.post_message"];
/** What the bridge keeps of an answer. */
const CAPABILITIES: Capabilities = { version: 1, apps: ["slack"], tools: TOOL_IDS };
/** What the Gateway answers (test/contract.test.ts cites the server's own shape). */
const ANSWER = { version: 1, workspace: true, apps: ["slack"], tools: TOOL_IDS };
/** What today's Gateway answers for a path it does not have (`plugin.ts` unknownGatewayRoute). */
const UNKNOWN_PATH = { type: "error", error: { type: "not_found_error", message: "unknown gateway path" } };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A Gateway stand-in: the capabilities probe answers as `probe` says, after `delayMs`; Memory answers at once. */
function gateway(probe: { delayMs?: number; answer?: () => Response }) {
  const calls: { url: string; method: string; authorization: string }[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    calls.push({ url, method: String(init?.method), authorization: String((init?.headers as Record<string, string>).authorization) });
    if (url.endsWith("/v1/connectors/capabilities")) {
      return new Promise<Response>((resolve, reject) => {
        const answer = probe.answer;
        if (answer === undefined) return; // never answers
        const timer = setTimeout(() => resolve(answer()), probe.delayMs ?? 0);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(init.signal?.reason);
        });
      });
    }
    if (url.endsWith("/v1/memory/search")) return json(200, { memories: [{ id: "mem_1", title: "Deploy window", content: "Friday" }] });
    if (url.endsWith("/v1/connectors/tools")) return json(404, UNKNOWN_PATH);
    return json(404, UNKNOWN_PATH);
  });
  return { fetchImpl, calls };
}

async function connect(options: BridgeOptions) {
  const server = createBridgeServer(options);
  const client = new Client({ name: "test", version: "0.0.0" });
  const changes: number[] = [];
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    changes.push(Date.now());
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const started = performance.now();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server, changes, initializeMs: performance.now() - started };
}

/** Lists tools while fake time runs, and says at which fake time the answer came. */
async function listAt(client: Client, advanceMs: number) {
  const startedAt = Date.now();
  let answeredAfter: number | undefined;
  const listing = client.listTools().then((answer) => {
    answeredAfter = Date.now() - startedAt;
    return answer;
  });
  await vi.advanceTimersByTimeAsync(advanceMs);
  const { tools } = await listing;
  return { names: tools.map((tool) => tool.name), tools, answeredAfter };
}

let dir: string;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  dir = mkdtempSync(join(tmpdir(), "eragon-capabilities-"));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("the first tools/list and the capabilities probe", () => {
  it("first tools/list waits for a probe answering in 1 s and includes connector tools", async () => {
    const { fetchImpl, calls } = gateway({ delayMs: 1_000, answer: () => json(200, ANSWER) });
    const { client } = await connect({ gatewayUrl: GW, key: staticKey(TOKEN), fetchImpl, connectors: { cacheFile: null } });

    const listed = await listAt(client, 6_000);

    expect(listed.names).toEqual([...MEMORY_NAMES, ...CONNECTOR_NAMES]);
    expect(listed.answeredAfter).toBeLessThanOrEqual(1_000);
    expect(calls[0]).toEqual({ url: `${GW}/v1/connectors/capabilities`, method: "GET", authorization: `Bearer ${TOKEN}` });
    await client.close();
  });

  it("probe slower than 5 s → Memory tools only, initialize answered < 100 ms", async () => {
    const { fetchImpl } = gateway({ delayMs: 8_000, answer: () => json(200, ANSWER) });
    const { client, initializeMs } = await connect({ gatewayUrl: GW, key: staticKey(TOKEN), fetchImpl, connectors: { cacheFile: null } });

    expect(initializeMs).toBeLessThan(100);
    const listed = await listAt(client, 5_000);

    expect(listed.names).toEqual(MEMORY_NAMES);
    expect(listed.answeredAfter).toBe(5_000);
    await client.close();
  });

  it("probe 404/incompatible → Memory tools only", async () => {
    const answers = [
      () => json(404, UNKNOWN_PATH),
      () => json(200, { ...ANSWER, version: 2 }),
      () => json(200, { version: 1, workspace: false, apps: ["slack"], tools: [] }),
      () => json(200, { version: 1, workspace: false, apps: [], tools: [] }),
      () => json(200, { version: 1, workspace: true, apps: ["slack"], tools: [] }),
      () => new Response("<html>not json</html>", { status: 200 }),
      () => json(401, { error: { message: "invalid key" } }),
    ];
    for (const answer of answers) {
      const { fetchImpl } = gateway({ delayMs: 10, answer });
      const { client } = await connect({ gatewayUrl: GW, key: staticKey(TOKEN), fetchImpl, connectors: { cacheFile: null } });
      const listed = await listAt(client, 100);
      expect(listed.names).toEqual(MEMORY_NAMES);
      expect(listed.answeredAfter).toBeLessThanOrEqual(10);
      await client.close();
    }
  });

  it("cached capability used when probe times out", async () => {
    const cacheFile = join(dir, "bridge-capabilities.json");
    new CapabilityCache(cacheFile).write(TOKEN, GW, CAPABILITIES);
    const { fetchImpl } = gateway({}); // never answers
    const { client } = await connect({ gatewayUrl: GW, key: staticKey(TOKEN), fetchImpl, connectors: { cacheFile } });

    const listed = await listAt(client, 5_000);

    expect(listed.names).toEqual([...MEMORY_NAMES, ...CONNECTOR_NAMES]);
    expect(listed.answeredAfter).toBe(5_000);
    await client.close();
  });

  it("a cache entry for another key or another Gateway is not used", async () => {
    const cacheFile = join(dir, "bridge-capabilities.json");
    new CapabilityCache(cacheFile).write("esk_someone_else", GW, CAPABILITIES);
    new CapabilityCache(cacheFile).write(TOKEN, "https://other.s.eragon.ai/gw", CAPABILITIES);
    const { fetchImpl } = gateway({});
    const { client } = await connect({ gatewayUrl: GW, key: staticKey(TOKEN), fetchImpl, connectors: { cacheFile } });

    expect((await listAt(client, 5_000)).names).toEqual(MEMORY_NAMES);
    await client.close();
  });

  it("a key command slower than 5 s cannot hold the first tools/list: Memory is listed at 5 s", async () => {
    const neverReads: KeySource = () => new Promise(() => undefined);
    const { fetchImpl, calls } = gateway({ answer: () => json(200, ANSWER) });
    const { client, initializeMs } = await connect({ gatewayUrl: GW, key: neverReads, fetchImpl, connectors: { cacheFile: null } });

    expect(initializeMs).toBeLessThan(100);
    const listed = await listAt(client, 5_000);

    expect(listed.names).toEqual(MEMORY_NAMES);
    expect(listed.answeredAfter).toBe(5_000);
    expect(calls).toEqual([]);
    await client.close();
  });

  it("a tools/list after the 5 s window answers at once", async () => {
    const { fetchImpl } = gateway({});
    const { client } = await connect({ gatewayUrl: GW, key: staticKey(TOKEN), fetchImpl, connectors: { cacheFile: null } });
    await vi.advanceTimersByTimeAsync(7_000);

    const listed = await listAt(client, 0);

    expect(listed.names).toEqual(MEMORY_NAMES);
    expect(listed.answeredAfter).toBe(0);
    await client.close();
  });
});

describe("against today's Gateway, with no capabilities endpoint", () => {
  it("lists exactly today's Memory tools and answers Memory exactly as the Memory-only bridge", async () => {
    const today = gateway({ answer: () => json(404, UNKNOWN_PATH) });
    const bridge = await connect({ gatewayUrl: GW, key: staticKey(TOKEN), fetchImpl: today.fetchImpl, connectors: { cacheFile: join(dir, "c.json") } });
    const before = gateway({ answer: () => json(404, UNKNOWN_PATH) });
    const memoryOnly = createMemoryMcpServer({ gatewayUrl: GW, token: TOKEN, fetchImpl: before.fetchImpl });
    const reference = new Client({ name: "test", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([memoryOnly.connect(b), reference.connect(a)]);

    const listed = await listAt(bridge.client, 100);
    expect(JSON.stringify(listed.tools)).toBe(JSON.stringify((await reference.listTools()).tools));
    expect(listed.tools).toEqual(MEMORY_TOOLS);
    expect(bridge.client.getInstructions()).toBe(reference.getInstructions());

    const search = { name: "memory_search", arguments: { query: "deploy" } };
    expect(JSON.stringify(await bridge.client.callTool(search))).toBe(JSON.stringify(await reference.callTool(search)));
    // The Memory request itself is the same request.
    const memoryRequest = (calls: typeof today.calls) => calls.find((call) => call.url.endsWith("/v1/memory/search"));
    expect(memoryRequest(today.calls)).toEqual(memoryRequest(before.calls));
    // Nothing waits on a restart either.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(bridge.changes).toEqual([]);
    expect(today.calls.filter((call) => call.url.endsWith("/capabilities"))).toHaveLength(1);
    await bridge.client.close();
    await reference.close();
  });
});

describe("Connections that answer after the first list", () => {
  it("sends tools/list_changed, and the first Memory result then says a restart loads them, once", async () => {
    const { fetchImpl } = gateway({ delayMs: 8_000, answer: () => json(200, ANSWER) });
    const { client, changes } = await connect({ gatewayUrl: GW, key: staticKey(TOKEN), fetchImpl, connectors: { cacheFile: null } });
    expect((await listAt(client, 5_000)).names).toEqual(MEMORY_NAMES);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(changes).toHaveLength(1);

    const first = await client.callTool({ name: "memory_search", arguments: { query: "deploy" } });
    const second = await client.callTool({ name: "memory_search", arguments: { query: "deploy" } });
    const texts = (result: typeof first) => (result.content as { text: string }[]).map((item) => item.text);
    expect(texts(first).at(-1)).toBe(CONNECTIONS_LATE_NOTE);
    expect(JSON.parse(texts(first)[0] ?? "")).toMatchObject({ memories: [{ id: "mem_1" }] });
    expect(texts(second)).not.toContain(CONNECTIONS_LATE_NOTE);
    await client.close();
  });

  it("a client that lists again after list_changed gets the connector tools and no note", async () => {
    const { fetchImpl } = gateway({ delayMs: 8_000, answer: () => json(200, ANSWER) });
    const { client } = await connect({ gatewayUrl: GW, key: staticKey(TOKEN), fetchImpl, connectors: { cacheFile: null } });
    await listAt(client, 5_000);
    await vi.advanceTimersByTimeAsync(3_000);

    expect((await listAt(client, 0)).names).toEqual([...MEMORY_NAMES, ...CONNECTOR_NAMES]);
    const result = await client.callTool({ name: "memory_search", arguments: { query: "deploy" } });
    expect((result.content as { text: string }[]).map((item) => item.text)).not.toContain(CONNECTIONS_LATE_NOTE);
    await client.close();
  });

  it("a probe answered 429 is no answer: the cache stands in and it is asked again", async () => {
    const cacheFile = join(dir, "bridge-capabilities.json");
    new CapabilityCache(cacheFile).write(TOKEN, GW, CAPABILITIES);
    let probes = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (!String(input).endsWith("/capabilities")) return json(404, UNKNOWN_PATH);
      probes += 1;
      return probes === 1
        ? new Response(JSON.stringify({ error: { code: "rate_limited", message: "too many connector requests; wait and try again" } }), { status: 429, headers: { "retry-after": "30" } })
        : json(200, ANSWER);
    });
    const { client } = await connect({ gatewayUrl: GW, key: staticKey(TOKEN), fetchImpl, connectors: { cacheFile } });
    expect((await listAt(client, 100)).names).toEqual([...MEMORY_NAMES, ...CONNECTOR_NAMES]);
    expect(new CapabilityCache(cacheFile).read(TOKEN, GW)).toEqual(CAPABILITIES);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(probes).toBe(2);
    await client.close();
  });

  it("a probe that could not reach Eragon is tried again a minute later", async () => {
    let attempt = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (!String(input).endsWith("/capabilities")) return json(404, UNKNOWN_PATH);
      attempt += 1;
      if (attempt === 1) throw new TypeError("fetch failed");
      return json(200, ANSWER);
    });
    const { client, changes } = await connect({ gatewayUrl: GW, key: staticKey(TOKEN), fetchImpl, connectors: { cacheFile: null } });
    expect((await listAt(client, 5_000)).names).toEqual(MEMORY_NAMES);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(attempt).toBe(2);
    expect(changes).toHaveLength(1);
    await client.close();
  });

  it("stops retrying after ten minutes of no answer", async () => {
    let attempts = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (!String(input).endsWith("/capabilities")) return json(404, UNKNOWN_PATH);
      attempts += 1;
      return json(503, { error: { message: "unavailable" } });
    });
    const { client } = await connect({ gatewayUrl: GW, key: staticKey(TOKEN), fetchImpl, connectors: { cacheFile: null } });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(attempts).toBe(11);
    await client.close();
  });
});

describe("through the MCP server", () => {
  it("connector_tools teaches a write, so connector_call refuses it without request_id; a held save's status is read from its own route", async () => {
    vi.useRealTimers();
    const paths: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname.replace(/^\/gw/, "");
      paths.push(`${String(init?.method)} ${path}`);
      if (path === "/v1/connectors/capabilities") return json(200, ANSWER);
      if (path === "/v1/connectors/tools") return json(200, { tools: [{ toolId: "slack.post_message", app: "slack", effect: "write", state: "ready" }] });
      if (path === "/v1/memory") return json(202, { approval: { id: "gwa_save", tool: "memory_save", status: "pending", reviewPath: "/inbox" } });
      if (path === "/v1/memory/saves/gwa_save") return json(200, { approval: { id: "gwa_save", tool: "memory_save", status: "executed", outcome: "executed" } });
      return json(404, UNKNOWN_PATH);
    });
    const { client } = await connect({ gatewayUrl: GW, key: staticKey(TOKEN), fetchImpl, connectors: { cacheFile: null } });
    await client.listTools();
    await client.callTool({ name: "connector_tools", arguments: {} });
    const refused = await client.callTool({ name: "connector_call", arguments: { tool: "slack.post_message", arguments: { channel: "#general", text: "hi" } } });
    expect(refused.isError).toBe(true);
    await client.callTool({ name: "memory_save", arguments: { kind: "fact", title: "t", content: "c" } });
    const status = await client.callTool({ name: "connector_call_status", arguments: { approval_id: "gwa_save" } });
    expect((status.content as { text: string }[])[0]?.text).toBe("Approval id: gwa_save. It was saved.");
    expect(paths).toEqual([
      "GET /v1/connectors/capabilities",
      "GET /v1/connectors/tools",
      "POST /v1/memory",
      "GET /v1/memory/saves/gwa_save",
    ]);
    await client.close();
  });
});

describe("a key command that failed at start", () => {
  it("is not run again in the background; the next tool call's key starts the probe, and Connections follow", async () => {
    let reads = 0;
    const key: KeySource = async () => {
      reads += 1;
      return reads === 1 ? { ok: false, error: "The key command failed (exit 1)." } : { ok: true, token: TOKEN };
    };
    const { fetchImpl, calls } = gateway({ delayMs: 10, answer: () => json(200, ANSWER) });
    const { client, changes } = await connect({ gatewayUrl: GW, key, fetchImpl, connectors: { cacheFile: null } });
    expect((await listAt(client, 100)).names).toEqual(MEMORY_NAMES);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(reads).toBe(1);
    expect(calls).toEqual([]);

    const first = await client.callTool({ name: "memory_search", arguments: { query: "deploy" } });
    expect(first.isError).not.toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(changes).toHaveLength(1);
    const second = await client.callTool({ name: "memory_search", arguments: { query: "deploy" } });
    expect((second.content as { text: string }[]).at(-1)?.text).toBe(CONNECTIONS_LATE_NOTE);
    await client.close();
  });
});

describe("the cache says yes, Eragon says no", () => {
  it("a connector call answers with a clear error, forgets the cache entry, and tells the client the list changed", async () => {
    const cacheFile = join(dir, "bridge-capabilities.json");
    new CapabilityCache(cacheFile).write(TOKEN, GW, CAPABILITIES);
    // The start-up probe hangs; asked again after the 404, Eragon says no.
    let probes = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (!String(input).endsWith("/capabilities")) return json(404, UNKNOWN_PATH);
      probes += 1;
      return probes === 1 ? new Promise<Response>(() => undefined) : json(404, UNKNOWN_PATH);
    });
    const { client, changes } = await connect({ gatewayUrl: GW, key: staticKey(TOKEN), fetchImpl, connectors: { cacheFile } });
    expect((await listAt(client, 5_000)).names).toContain("connector_tools");

    const result = await client.callTool({ name: "connector_tools", arguments: {} });

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text).toBe(CONNECTIONS_UNAVAILABLE);
    expect(new CapabilityCache(cacheFile).read(TOKEN, GW)).toBeUndefined();
    expect(changes).toHaveLength(1);
    expect((await listAt(client, 0)).names).toEqual(MEMORY_NAMES);
    await client.close();
  });

  it("a coded 404 (unknown_tool) keeps the tools and the cache: only an unknown path means Connections are off", async () => {
    const cacheFile = join(dir, "bridge-capabilities.json");
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith("/capabilities")) return json(200, ANSWER);
      return json(404, { error: { code: "unknown_tool", message: "slack.nope is not a reviewed connector tool" } });
    });
    const { client, changes } = await connect({ gatewayUrl: GW, key: staticKey(TOKEN), fetchImpl, connectors: { cacheFile } });
    expect((await listAt(client, 100)).names).toContain("connector_call");

    const result = await client.callTool({ name: "connector_call", arguments: { tool: "slack.nope" } });

    expect((result.content as { text: string }[])[0]?.text).toBe("slack.nope is not a reviewed connector tool.");
    expect(changes).toEqual([]);
    expect(new CapabilityCache(cacheFile).read(TOKEN, GW)).toEqual(CAPABILITIES);
    expect((await listAt(client, 0)).names).toContain("connector_call");
    await client.close();
  });

  it("a probe answering 404 removes the stale entry too", async () => {
    const cacheFile = join(dir, "bridge-capabilities.json");
    new CapabilityCache(cacheFile).write(TOKEN, GW, CAPABILITIES);
    const { fetchImpl } = gateway({ delayMs: 10, answer: () => json(404, UNKNOWN_PATH) });
    const { client } = await connect({ gatewayUrl: GW, key: staticKey(TOKEN), fetchImpl, connectors: { cacheFile } });

    expect((await listAt(client, 100)).names).toEqual(MEMORY_NAMES);
    expect(new CapabilityCache(cacheFile).read(TOKEN, GW)).toBeUndefined();
    await client.close();
  });
});

describe("the capabilities cache file", () => {
  it("names entries by the key's SHA-256 and the Gateway origin, never holds the key, and is private", async () => {
    const cacheFile = join(dir, "nested", "bridge-capabilities.json");
    const { fetchImpl } = gateway({ delayMs: 10, answer: () => json(200, ANSWER) });
    const { client } = await connect({ gatewayUrl: GW, key: staticKey(TOKEN), fetchImpl, connectors: { cacheFile } });
    await listAt(client, 100);

    const text = readFileSync(cacheFile, "utf8");
    expect(text).not.toContain(TOKEN);
    expect(Object.keys(JSON.parse(text).entries)).toEqual([CapabilityCache.entryName(TOKEN, GW)]);
    expect(CapabilityCache.entryName(TOKEN, GW)).toMatch(/^[0-9a-f]{64}@https:\/\/acme\.s\.eragon\.ai$/);
    if (process.platform !== "win32") expect(statSync(cacheFile).mode & 0o777).toBe(0o600);
    await client.close();
  });

  it("expires an entry after 24 hours", () => {
    const cacheFile = join(dir, "bridge-capabilities.json");
    let now = 1_000_000;
    const cache = new CapabilityCache(cacheFile, () => now);
    cache.write(TOKEN, GW, CAPABILITIES);
    now += CAPABILITY_CACHE_TTL_MS - 1;
    expect(cache.read(TOKEN, GW)).toEqual(CAPABILITIES);
    now += 1;
    expect(cache.read(TOKEN, GW)).toBeUndefined();
  });

  it("treats an unreadable file as an empty cache", () => {
    const cacheFile = join(dir, "bridge-capabilities.json");
    const cache = new CapabilityCache(cacheFile);
    expect(cache.read(TOKEN, GW)).toBeUndefined();
    rmSync(cacheFile, { force: true });
    writeFileSync(cacheFile, "{not json");
    expect(cache.read(TOKEN, GW)).toBeUndefined();
    cache.write(TOKEN, GW, CAPABILITIES);
    expect(cache.read(TOKEN, GW)).toEqual(CAPABILITIES);
  });
});
