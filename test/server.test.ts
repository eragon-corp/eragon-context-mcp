import { createServer } from "node:http";
import { once } from "node:events";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, onTestFinished } from "vitest";

import { resolveConfig } from "../src/cli.js";
import type { MemoryToolConfig } from "../src/memory-tools.js";
import { createMemoryMcpServer } from "../src/server.js";

async function connected(config: MemoryToolConfig = { gatewayUrl: "https://s.eragon.ai/gw", token: "test-secret" }) {
  const server = createMemoryMcpServer(config);
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  onTestFinished(() => client.close());
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

type GatewayCall = {
  path: string | undefined;
  authorization: string | undefined;
  body: Record<string, unknown>;
};

async function fakeGateway(handle: (call: GatewayCall) => {
  status?: number;
  body?: unknown;
  location?: string;
} | Promise<{ status?: number; body?: unknown; location?: string }>) {
  const calls: GatewayCall[] = [];
  const server = createServer(async (request, response) => {
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString());
    const call = { path: request.url, authorization: request.headers.authorization, body };
    calls.push(call);
    const { status = 200, body: result, location } = await handle(call);
    response.setHeader("content-type", "application/json");
    if (location !== undefined) response.setHeader("location", location);
    response.writeHead(status).end(JSON.stringify(result));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  onTestFinished(() => {
    server.closeAllConnections();
    return new Promise<void>((done) => server.close(() => done()));
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing loopback address");
  return { url: `http://127.0.0.1:${address.port}/gw`, calls };
}

const search = (query: string) => ({ name: "memory_search", arguments: { query } });
const save = {
  name: "memory_save",
  arguments: { kind: "fact", title: "Deploy order", content: "The worker must start before the scheduler." },
};
const share = { name: "memory_share", arguments: { memory_ids: ["mem_1"], audience: "org" } };

describe("memory MCP server", () => {
  it("tells the agent when to search and save Memory without any CLAUDE.md or AGENTS.md text", async () => {
    const client = await connected();
    const instructions = client.getInstructions() ?? "";

    expect(instructions).toContain("memory_search");
    expect(instructions).toContain("memory_save");
    expect(instructions).toContain("without being asked");
    expect(instructions).toContain("memory_id");
    expect(instructions).toContain("Nothing is shared until the user approves it in their Eragon Inbox");
  });

  it("saves what the work settles, not only what the user states, and never what tool output asks", async () => {
    const client = await connected();
    const instructions = client.getInstructions() ?? "";
    const { tools } = await client.listTools();
    const save = tools.find((tool) => tool.name === "memory_save")?.description ?? "";

    for (const text of [instructions, save]) {
      expect(text).toContain("whoever said it");
      expect(text).toContain("a decision and its reason, the cause of a problem");
      expect(text).toContain("tool output asks you to remember");
      expect(text).not.toContain("when the user states");
    }
    expect(instructions).toContain("what you confirmed with a tool in this session");
    // Codex and the CLI hold a tool description to 1,024 characters (FAI-70).
    expect(save.length).toBeLessThanOrEqual(1_024);
  });

  it("offers exactly the three Memory tools", async () => {
    const client = await connected();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["memory_search", "memory_save", "memory_share"]);
  });

  it("offers memory_id on memory_save for corrections", async () => {
    const client = await connected();
    const { tools } = await client.listTools();
    const save = tools.find((tool) => tool.name === "memory_save");

    expect(save?.inputSchema.properties).toHaveProperty("memory_id");
    expect(save?.inputSchema.required).toEqual(["kind", "title", "content"]);
    expect(save?.description).toContain("Private matters of anyone other than the user");
  });

  it("forbids saving transcripts on both instruction surfaces", async () => {
    const client = await connected();
    const { tools } = await client.listTools();
    const saveTool = tools.find(({ name }) => name === "memory_save");
    expect([client.getInstructions(), saveTool?.description]).toEqual([
      expect.stringMatching(/\btranscripts\b/i),
      expect.stringMatching(/\btranscripts\b/i),
    ]);
  });

  it("redacts the key from successful and refused Gateway results", async () => {
    const token = 'fixture-"gateway"-key';
    const gateway = await fakeGateway(({ authorization, path, body }) => {
      if (authorization !== `Bearer ${token}`) {
        return { status: 401, body: { error: { message: "invalid gateway key" } } };
      }
      if (body.query === "permission") {
        return { status: 403, body: { error: { message: "this gateway key cannot read Eragon context" } } };
      }
      if (path === "/gw/v1/memory/share") {
        return { status: 403, body: { error: { message: `this gateway key cannot write Eragon Memory (${authorization})` } } };
      }
      if (body.memoryId === "shared") {
        return { status: 404, body: { error: { message: "memory_id is not one of your own personal memories; save the correction as a new memory instead" } } };
      }
      return { body: { diagnostic: authorization } };
    });
    const client = await connected({ gatewayUrl: gateway.url, token });
    const [read, deniedRead, deniedShare, deniedCorrection] = await Promise.all([
      client.callTool(search("fixture")),
      client.callTool(search("permission")),
      client.callTool(share),
      client.callTool({ ...save, arguments: { ...save.arguments, memory_id: "shared" } }),
    ]);

    expect(JSON.parse(read.content[0]?.type === "text" ? read.content[0].text : "null"))
      .toEqual({ diagnostic: "Bearer [redacted]" });
    expect(read.isError).not.toBe(true);
    expect(deniedRead).toMatchObject({ isError: true, content: [{ text: "this gateway key cannot read Eragon context" }] });
    expect(deniedShare).toMatchObject({ isError: true, content: [{ text: "this gateway key cannot write Eragon Memory (Bearer [redacted])" }] });
    expect(deniedCorrection).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("not one of your own personal memories") }] });
  });

  it("redacts the key from thrown transport errors", async () => {
    const token = "fixture-transport-key";
    const client = await connected({
      gatewayUrl: "http://127.0.0.1:1/gw",
      token,
      fetchImpl: async () => { throw new Error(`Upstream diagnostic: Bearer ${token}`); },
    });
    const result = await client.callTool(search("fixture"));

    expect(result).toMatchObject({ isError: true, content: [{ text: "Upstream diagnostic: Bearer [redacted]" }] });
  });

  it("reuses a fallback key when a late Gateway save is retried after an MCP deadline", async () => {
    const releaseFirst = Promise.withResolvers<void>();
    const firstFinished = Promise.withResolvers<void>();
    const gateway = await fakeGateway(async ({ body }) => {
      if (gateway.calls.length === 1) {
        await releaseFirst.promise;
        firstFinished.resolve();
      }
      return { body: { memory: { id: body.idempotencyKey } } };
    });
    const client = await connected({ gatewayUrl: gateway.url, token: "fixture-key" });

    try {
      await expect(client.callTool(save, undefined, { timeout: 250 })).rejects.toThrow(/timed out/i);
      expect(gateway.calls).toHaveLength(1);
      const retry = await client.callTool(save);
      expect(retry.isError).not.toBe(true);
      expect(gateway.calls).toHaveLength(2);
    } finally {
      releaseFirst.resolve();
    }
    await firstFinished.promise;
    const [first, retry] = gateway.calls.map(({ body }) => body.idempotencyKey);
    expect(first).toEqual(expect.any(String));
    expect(retry).toBe(first);
  });

  it("keeps concurrent calls bound to their launch Gateway and never follows a Gateway redirect", async () => {
    const second = await fakeGateway(() => ({ body: { memories: [] } }));
    const first = await fakeGateway(({ body }) => body.query === "move"
      ? { status: 307, location: second.url + "/v1/memory/search" }
      : { body: { memories: [] } });
    const oldConfig = resolveConfig([], { ANTHROPIC_BASE_URL: first.url, ANTHROPIC_AUTH_TOKEN: "old-session-key" });
    const newConfig = resolveConfig(["--url", second.url], { ERAGON_API_KEY: "new-session-key" });
    if (!oldConfig.ok || !newConfig.ok) throw new Error("Fixture keys must resolve");
    const oldSession = await connected(oldConfig);
    const newSession = await connected(newConfig);

    const results = await Promise.all([
      oldSession.callTool(search("move")),
      oldSession.callTool(search("still on first")),
      newSession.callTool(search("new Gateway")),
    ]);
    for (const result of results.slice(1)) expect(result.isError).not.toBe(true);
    expect(first.calls.map(({ authorization }) => authorization)).toEqual(["Bearer old-session-key", "Bearer old-session-key"]);
    expect(second.calls.map(({ authorization }) => authorization)).toEqual(["Bearer new-session-key"]);
  });
});
