import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { createMemoryMcpServer } from "../src/server.js";
import { probeSkills } from "../src/skill-tools.js";

const token = "test-flux-key";
const memoryTools = ["memory_search", "memory_save", "memory_share"];
const skillTools = ["skill_list", "skill_get", "skill_propose", "skill_revise"];
const allTools = [...memoryTools, ...skillTools];
const unknownRoute = {
  type: "error", error: { type: "not_found_error", message: "unknown gateway path" }, request_id: "req_skills",
};
const skillsUnavailable = { content: [{ type: "text", text: "Eragon Skills are unavailable on this server or for this key." }] };
const proposalsUnavailable = { content: [{
  type: "text",
  text: "This key needs Memory write-back to propose Eragon skills, or this server does not accept proposals. " +
    "The proposal tools return automatically on the next tool listing. Retry once the key and server allow proposals.",
}] };
const skill = {
  id: "skl_1",
  name: "release-notes",
  description: "Prepare a change summary for deploys",
  version: 3,
  updatedAt: "2026-11-25T00:00:00.000Z",
  scope: "personal",
};
const skillBody = "---\nname: release-notes\ndescription: Prepare a change summary for deploys\n---\n\n# Release notes";
const filePath = "examples/Release #1?.json";
const fileContent = '{ "template": "Changes" }\n';
const companionFiles = [
  { path: filePath, bytes: Buffer.byteLength(fileContent) },
  { path: "empty.txt", bytes: 0 },
  { path: "oversized.txt", bytes: 262145 },
  { path: "binary.dat", bytes: 4 },
].sort((a, b) => a.path.localeCompare(b.path));
const installed = "https://tenant.example/skills/installed";
const receipt = { proposalId: "skl_2", status: "proposed", reviewUrl: installed, kind: "skill", skillId: "skl_2" };

// The ERA-5184 Gateway contract in the task brief, over real loopback HTTP.
async function gateway(state: {
  skills?: "on" | "flag off" | "old server" | "no grant" | "issued key" | "console key";
  memoryWrite?: boolean;
  empty?: boolean;
  truncated?: boolean;
  relativeReview?: boolean;
  version?: number;
  skillName?: string;
  dropProposal?: "once" | "always";
  pendingRevision?: boolean;
  refuseProposal?: { status: number; body: { error: string; message?: string } };
} = {}) {
  const requests: { method: string | undefined; url: string | undefined; body: unknown }[] = [];
  const proposals: unknown[] = [];
  const drafts = new Map<string, { id: string; skillBody: string; files: Map<string, Buffer>; status: "proposed" | "review" }>();
  const currentSkill = { ...skill, name: state.skillName ?? skill.name };
  const server = createServer(async (request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    };
    const { method, url } = request;
    const target = /^\/gw\/v1\/skills\/([^/]+)(?:\/files\/(.*))?$/.exec(url ?? "");
    response.setHeader("request-id", unknownRoute.request_id);
    const data: Buffer[] = [];
    for await (const chunk of request) data.push(chunk);
    const payload = Buffer.concat(data);
    const body = payload.length ? JSON.parse(payload.toString()) : undefined;
    const version = state.version ?? skill.version;
    requests.push({ method, url, body });
    if (request.headers.authorization !== `Bearer ${token}`) return send(401, {
      type: "error", error: { type: "authentication_error", message: "invalid API key" }, request_id: unknownRoute.request_id,
    });
    if (method === "POST" && url === "/gw/v1/memory/search") {
      if (state.skills === "no grant") return send(403, { error: { message: "this gateway key cannot read Eragon context" } });
      return send(200, { memories: [{ id: "mem_1" }] });
    }
    if (method === "POST" && url === "/gw/v1/memory") {
      return state.memoryWrite === false
        ? send(403, { error: { message: "this gateway key cannot write Eragon Memory" } })
        : send(200, { memory: { id: "mem_2" } });
    }
    if (method === "POST" && url === "/gw/v1/memory/share") {
      return state.memoryWrite === false
        ? send(403, { error: { message: "this gateway key cannot write Eragon Memory" } })
        : send(202, {
          approval: {
            id: "approval_1", status: "pending", description: "Share one memory", expiresAt: "2026-11-27T00:00:00.000Z",
            reviewPath: "/inbox",
          },
        });
    }
    const isProposal = method === "POST" && url === "/gw/v1/skills/proposals";
    if (isProposal && payload.byteLength > 2 * 1024 * 1024 && (state.skills === undefined || state.skills === "on")) {
      return send(413, {
        type: "error", error: { type: "invalid_request_error", message: "The request body is larger than the 2 MiB limit." },
        request_id: unknownRoute.request_id,
      });
    }
    if (state.skills !== undefined && state.skills !== "on") return send(404, unknownRoute);
    if (isProposal && state.memoryWrite === false) return send(404, unknownRoute);
    if (isProposal || (method === "GET" && (url === "/gw/v1/skills" || target !== null))) {
      response.setHeader("cache-control", "no-store");
    }
    if (method === "GET" && url === "/gw/v1/skills") {
      if (state.truncated) {
        const capped = Array.from({ length: 500 }, (_, index) => ({
          ...skill, id: `skl_${index + 10}`, name: `skill-${String(index + 1).padStart(3, "0")}`,
        }));
        return send(200, { skills: capped, truncated: true });
      }
      return send(200, { skills: state.empty ? [] : [{ ...currentSkill, version }] });
    }
    if (isProposal) {
      if (state.refuseProposal) return send(state.refuseProposal.status, state.refuseProposal.body);
      const revising = body.baseSkillId !== undefined;
      const name = body.name?.trim() ?? (revising ? currentSkill.name : "");
      const description = body.description?.trim() ?? (revising ? currentSkill.description : "");
      const submitted = body.body.trim();
      if (
        ((!revising || body.name !== undefined) && (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 100)) ||
        ((!revising || body.description !== undefined) && (description.length < 1 || description.length > 500)) ||
        !submitted || Buffer.byteLength(body.body) > 64 * 1024 ||
        body.reason.trim().length < 1 || body.reason.trim().length > 2000 ||
        (body.baseVersion !== undefined && (!body.baseSkillId || !Number.isInteger(body.baseVersion) || body.baseVersion < 1)) ||
        (body.files !== undefined && (body.files.length > 50 ||
          body.files.some(({ path }: { path: string }) => path.length < 1 || path.length > 500) ||
          body.files.reduce((bytes: number, file: { content: string }) => bytes + Buffer.byteLength(file.content), 0) > 1024 * 1024))
      ) return send(400, { error: "invalid_proposal" });
      const reply = (id: string) => {
        if (state.dropProposal) {
          if (state.dropProposal === "once") delete state.dropProposal;
          request.socket.destroy();
          return;
        }
        const result = {
          proposalId: id, status: "proposed", reviewUrl: state.relativeReview ? "/skills/installed" : installed,
          kind: revising ? "revision" : "skill", skillId: id,
          ...(revising ? { baseVersion: version } : {}),
        };
        send(201, result);
      };
      const files: { path: string; content: string }[] = body.files ?? [];
      const fileContents = new Map(files.map(({ path, content }) => [path, Buffer.from(content, "utf8")]));
      const draftName = revising ? currentSkill.name : name;
      const withFrontmatter = submitted.startsWith("---")
        ? submitted.replace(/^(---\n)name: [^\n]+/, `$1name: ${draftName}`)
        : `---\nname: ${draftName}\ndescription: ${description}\n---\n\n${submitted}`;
      if (Buffer.byteLength(withFrontmatter) > 64 * 1024) {
        return send(400, { error: "invalid_proposal", message: "SKILL.md with its frontmatter is over the size limit" });
      }
      if (revising) {
        if (files.length > 0) return send(400, {
          error: "revision_files_unsupported", message: "a revision proposes SKILL.md only; its other files stay as they are",
        });
        if (body.baseSkillId !== skill.id) return send(404, { error: "skill_not_found", message: "skill not found" });
        if (body.baseVersion !== undefined && body.baseVersion !== version) return send(409, {
          error: "skill_version_conflict", currentVersion: version,
          message: `the skill changed to v${version} after this was written for v${body.baseVersion}`,
        });
        if (withFrontmatter === skillBody) return send(409, {
          error: "skill_revision_unchanged", currentVersion: version, message: "the skill already says this",
        });
        if (state.pendingRevision) return send(409, {
          error: "skill_revision_waiting", message: "another change to this skill is being applied; propose again after it lands",
        });
      } else {
        const paths = new Set(["SKILL.md"]);
        for (const { path } of files) {
          if (path.includes("\\") || path.includes("\0") || path.split("/").some((part) => !part || part === "." || part === "..")) {
            return send(400, { error: "invalid_proposal", message: `unsafe path in skill bundle: ${path}` });
          }
          if (paths.has(path)) return send(400, {
            error: "invalid_proposal", message: `file ${path} is given twice, or is SKILL.md (send it as body)`,
          });
          paths.add(path);
        }
        const existing = drafts.get(name);
        if (
          existing?.status === "proposed" && existing.skillBody === withFrontmatter &&
          existing.files.size === fileContents.size &&
          [...fileContents].every(([path, content]) => existing.files.get(path)?.equals(content) === true)
        ) return reply(existing.id);
        if (name === currentSkill.name || existing !== undefined) return send(409, {
          error: "skill_name_taken", message: "skill name already exists in this visibility scope",
        });
      }
      const id = body.baseSkillId ?? `skl_${drafts.size + 2}`;
      drafts.set(draftName, { id, skillBody: withFrontmatter, files: fileContents, status: revising ? "review" : "proposed" });
      proposals.push(body);
      return reply(id);
    }
    const ref = target?.[1] === undefined ? undefined : decodeURIComponent(target[1]);
    const path = target?.[2] === undefined ? undefined : decodeURIComponent(target[2]);
    if (method === "GET" && (ref === skill.id || ref?.toLowerCase() === currentSkill.name.toLowerCase()) && path === undefined) {
      const detail = {
        id: skill.id, name: currentSkill.name, description: skill.description, version,
        body: skillBody, files: companionFiles,
      };
      return send(200, detail);
    }
    if (method === "GET" && (ref === skill.id || ref?.toLowerCase() === currentSkill.name.toLowerCase())) {
      if (path === filePath || path === "empty.txt") {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(path === filePath ? fileContent : "");
        return;
      }
      if (path === "oversized.txt") return send(413, { error: "skill_file_too_large", bytes: 262145, maxBytes: 262144 });
      if (path === "binary.dat") return send(415, { error: "skill_file_not_text" });
    }
    if (method === "GET" && target !== null) return send(404, { error: "skill_not_found" });
    return send(404, unknownRoute);
  });
  server.listen(0, "127.0.0.1");
  onTestFinished(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing Gateway port");
  return { gatewayUrl: `http://127.0.0.1:${address.port}/gw`, token, requests, proposals, drafts };
}

function testClient() {
  const client = new Client({ name: "skill-contract-test", version: "0.0.0" });
  onTestFinished(() => client.close());
  return client;
}

async function connect(config: { gatewayUrl: string; token: string; fetchImpl?: typeof fetch }) {
  const server = createMemoryMcpServer(config);
  const client = testClient();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function toolNames(client: Client) {
  return (await client.listTools()).tools.map(({ name }) => name);
}

const draft = { body: "# Improved notes\n", reason: "Record the release checklist" };
const revision = { skillId: skill.id, baseVersion: skill.version, ...draft };
const proposal = { name: "triage-builds", description: "Find failed builds", ...draft, files: [{ path: filePath, content: fileContent }] };
const save = { kind: "fact", title: "Release day", content: "Friday" };
const jsonResult = (body: unknown) => ({ content: [{ type: "text", text: JSON.stringify(body, null, 2) }] });
const toolError = (text: string) => ({ isError: true, content: [{ type: "text", text }] });
const nameTaken = toolError("A skill already uses that name. Your earlier proposal may still be waiting for review on Skills → Installed. Check there before proposing under another name. skill name already exists in this visibility scope");

describe("Flux Skills MCP contract", () => {
  it("hides Skills on both an old Gateway and a flag-off Gateway while all Memory tools still work", async () => {
    for (const skills of ["flag off", "old server"] as const) {
      const gw = await gateway({ skills });
      const client = await connect(gw);
      expect(await toolNames(client)).toEqual(memoryTools);
      expect(await client.callTool({ name: "memory_search", arguments: { query: "release" } })).toMatchObject({
        content: [{ type: "text", text: expect.stringContaining("mem_1") }],
      });
      expect(await client.callTool({ name: "memory_save", arguments: save })).toMatchObject({
        content: [{ type: "text", text: expect.stringContaining("mem_2") }],
      });
      expect(await client.callTool({ name: "memory_share", arguments: { memory_ids: ["mem_1"], audience: "org" } })).toMatchObject({
        content: [{ type: "text", text: expect.stringContaining("approval_1") }],
      });
      expect(gw.requests).toEqual([
        { method: "GET", url: "/gw/v1/skills", body: undefined },
        { method: "POST", url: "/gw/v1/memory/search", body: { query: "release", limit: 8 } },
        { method: "POST", url: "/gw/v1/memory", body: { ...save, idempotencyKey: expect.stringMatching(/^mcp:/) } },
        { method: "POST", url: "/gw/v1/memory/share", body: { memoryIds: ["mem_1"], audience: "org" } },
      ]);
    }
  });

  it.each(["no grant", "issued key", "console key"] as const)("hides and skips Skills on an unknown-route 404 for %s", async (skills) => {
    const gw = await gateway({ skills });
    const client = await connect(gw);
    expect(await toolNames(client)).toEqual(memoryTools);
    expect(await client.callTool({ name: "skill_list" })).toEqual(skillsUnavailable);
    expect(await client.callTool({ name: "skill_propose", arguments: proposal })).toEqual(skillsUnavailable);
    expect(gw.requests).toEqual([{ method: "GET", url: "/gw/v1/skills", body: undefined }]);
  });

  it("keeps the normal Memory listing and context refusal for a personal key without the Skills read grant", async () => {
    const gw = await gateway({ skills: "no grant" });
    const client = await connect(gw);
    expect(await toolNames(client)).toEqual(memoryTools);
    expect(await client.callTool({ name: "memory_search", arguments: { query: "release" } })).toEqual(
      toolError("this gateway key cannot read Eragon context"),
    );
    expect(gw.requests).toEqual([
      { method: "GET", url: "/gw/v1/skills", body: undefined },
      { method: "POST", url: "/gw/v1/memory/search", body: { query: "release", limit: 8 } },
    ]);
  });

  it("requires a valid list response to advertise Skills, and accepts an empty list", async () => {
    const gw = await gateway({ empty: true });
    let malformed = true;
    const client = await connect({
      ...gw,
      fetchImpl: (url, init) => malformed ? Promise.resolve(Response.json({ status: "ok" })) : fetch(url, init),
    });
    expect(await toolNames(client)).toEqual(memoryTools);
    malformed = false;
    expect(await toolNames(client)).toEqual(allTools);
    expect(await client.callTool({ name: "skill_list" })).toEqual({ content: [{ type: "text", text: '{\n  "skills": []\n}' }] });
  });

  it("keeps Memory usable if the Skills probe cannot reach the Gateway", async () => {
    const gw = await gateway();
    const client = await connect({
      ...gw,
      fetchImpl: async (url, init) => {
        if (String(url).endsWith("/v1/skills")) throw new Error("probe network failure");
        return fetch(url, init);
      },
    });
    expect(await toolNames(client)).toEqual(memoryTools);
    expect(await client.callTool({ name: "memory_search", arguments: { query: "release" } })).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("mem_1") }],
    });
  });

  it("recovers the initial Skills list in the background after Retry-After and notifies the client once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      let probes = 0;
      const client = await connect({
        gatewayUrl: "https://tenant.example/gw", token,
        fetchImpl: async () => ++probes === 1
          ? Response.json({ error: "skills_unavailable" }, { status: 503, headers: { "retry-after": "6" } })
          : Response.json({ skills: [] }),
      });
      const changes: string[] = [];
      client.setNotificationHandler(ToolListChangedNotificationSchema, ({ method }) => { changes.push(method); });
      expect(await toolNames(client)).toEqual(memoryTools);
      await vi.advanceTimersByTimeAsync(5_999);
      expect(await toolNames(client)).toEqual(memoryTools);
      expect(probes).toBe(1);
      expect(changes).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(probes).toBe(2);
      expect(changes).toEqual(["notifications/tools/list_changed"]);
      expect(await toolNames(client)).toEqual(allTools);
      expect(changes).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors a short Retry-After within the first list for clients that only list at startup", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      let probes = 0;
      const retryAt = new Date(Date.now() + 2_000).toUTCString();
      const client = await connect({
        gatewayUrl: "https://tenant.example/gw", token,
        fetchImpl: async () => ++probes === 1
          ? Response.json({ error: "skills_unavailable" }, { status: 503, headers: { "retry-after": retryAt } })
          : Response.json({ skills: [] }),
      });
      const listing = toolNames(client);
      await vi.advanceTimersByTimeAsync(1);
      expect(probes).toBe(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await listing).toEqual(allTools);
      expect(probes).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries once within the first list when a fast probe fails before returning headers", async () => {
    let probes = 0;
    const client = await connect({
      gatewayUrl: "https://tenant.example/gw", token,
      fetchImpl: async () => {
        if (++probes === 1) throw new TypeError("fetch failed");
        return Response.json({ skills: [] });
      },
    });
    expect(await toolNames(client)).toEqual(allTools);
    expect(probes).toBe(2);
  });

  it("backs off after network and HTTP failures, then stops retrying an unknown route", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      let probes = 0;
      const client = await connect({
        gatewayUrl: "https://tenant.example/gw", token,
        fetchImpl: async () => {
          probes += 1;
          if (probes <= 2) throw new TypeError("fetch failed");
          if (probes === 3) return new Response(null, { status: 502 });
          if (probes === 4) return new Response(null, { status: 429 });
          return Response.json(unknownRoute, { status: 404 });
        },
      });
      expect(await toolNames(client)).toEqual(memoryTools);
      expect(probes).toBe(2);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(probes).toBe(3);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(probes).toBe(4);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(probes).toBe(5);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(probes).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels scheduled Skills probes when the MCP session closes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      let probes = 0;
      const client = await connect({
        gatewayUrl: "https://tenant.example/gw", token,
        fetchImpl: async () => {
          probes += 1;
          return Response.json({ error: "skills_unavailable" }, { status: 503, headers: { "retry-after": "8" } });
        },
      });
      expect(await toolNames(client)).toEqual(memoryTools);
      await client.close();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(probes).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains the last visible tools when a refresh gets a temporary Gateway error", async () => {
    let probes = 0;
    const client = await connect({
      gatewayUrl: "https://tenant.example/gw", token,
      fetchImpl: async () => ++probes === 1
        ? Response.json({ skills: [] })
        : Response.json({ error: "skills_unavailable" }, { status: 503 }),
    });
    expect(await toolNames(client)).toEqual(allTools);
    expect(await toolNames(client)).toEqual(allTools);
  });

  it("bounds discovery even if the Flux key re-read stalls before fetch sees the abort signal", async () => {
    const delayed = Promise.withResolvers<Response>();
    try {
      expect(await probeSkills({
        gatewayUrl: "https://tenant.example/gw",
        token,
        fetchImpl: () => delayed.promise,
      }, 10)).toEqual({ kind: "unknown", retry: true });
    } finally {
      delayed.resolve(Response.json({ skills: [] }));
    }
  });

  it("re-lists both writers and accepts a proposal after Memory write-back is enabled in the same session", async () => {
    const state: Parameters<typeof gateway>[0] = { memoryWrite: false };
    const gw = await gateway(state);
    const client = await connect(gw);
    const changes: string[] = [];
    client.setNotificationHandler(ToolListChangedNotificationSchema, ({ method }) => { changes.push(method); });
    expect(await toolNames(client)).toEqual(allTools);
    expect(await client.callTool({ name: "skill_list" })).toEqual(jsonResult({ skills: [skill] }));
    expect(await client.callTool({ name: "memory_save", arguments: save })).toEqual({
      isError: true, content: [{ type: "text", text: "this gateway key cannot write Eragon Memory" }],
    });
    expect(await client.callTool({ name: "skill_propose", arguments: proposal })).toEqual(proposalsUnavailable);
    expect(changes).toEqual(["notifications/tools/list_changed"]);
    expect(await client.callTool({ name: "skill_list" })).toEqual(jsonResult({ skills: [skill] }));
    expect(await client.callTool({ name: "skill_get", arguments: { idOrName: skill.id, path: filePath } })).toEqual({
      content: [{ type: "text", text: fileContent }],
    });
    expect(await client.callTool({ name: "memory_search", arguments: { query: "release" } })).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("mem_1") }],
    });
    state.memoryWrite = true;
    expect(await toolNames(client)).toEqual(allTools);
    expect(await client.callTool({ name: "skill_propose", arguments: proposal })).toEqual(jsonResult(receipt));
    expect(await client.callTool({ name: "skill_list" })).toEqual(jsonResult({ skills: [skill] }));
    expect(gw.requests.filter(({ url }) => url === "/gw/v1/skills/proposals")).toHaveLength(2);
  });

  it("retries writers before and after re-listing while the Gateway still refuses proposals", async () => {
    const gw = await gateway({ memoryWrite: false });
    const client = await connect(gw);
    const changes: string[] = [];
    client.setNotificationHandler(ToolListChangedNotificationSchema, ({ method }) => { changes.push(method); });
    const postRequests = () => gw.requests.filter(({ url }) => url === "/gw/v1/skills/proposals");

    expect(await toolNames(client)).toEqual(allTools);
    expect(await client.callTool({ name: "skill_propose", arguments: proposal })).toEqual(proposalsUnavailable);
    expect(await client.callTool({ name: "skill_revise", arguments: revision })).toEqual(proposalsUnavailable);
    expect(postRequests()).toHaveLength(2);
    expect(changes).toEqual(["notifications/tools/list_changed"]);

    expect(await toolNames(client)).toEqual(allTools);
    expect(await client.callTool({ name: "skill_propose", arguments: proposal })).toEqual(proposalsUnavailable);
    expect(postRequests()).toHaveLength(3);
    expect(changes).toHaveLength(2);
    expect(await client.callTool({ name: "skill_list" })).toEqual(jsonResult({ skills: [skill] }));
  });

  it("ignores stale proposal refusals after Skills reads recover and applies fresh refusals", async () => {
    const proposalStarted = Promise.withResolvers<void>();
    const delayedRefusal = Promise.withResolvers<Response>();
    const refuse = () => Response.json(unknownRoute, { status: 404 });
    let readsAvailable = true;
    let firstProposal = true;
    const client = await connect({
      gatewayUrl: "https://tenant.example/gw", token,
      fetchImpl: async (_url, init) => {
        if (init?.method === "GET") return readsAvailable ? Response.json({ skills: [] }) : refuse();
        if (!firstProposal) return refuse();
        firstProposal = false;
        proposalStarted.resolve();
        return delayedRefusal.promise;
      },
    });
    const changes: string[] = [];
    client.setNotificationHandler(ToolListChangedNotificationSchema, ({ method }) => { changes.push(method); });
    expect(await toolNames(client)).toEqual(allTools);
    const pending = client.callTool({ name: "skill_propose", arguments: proposal });
    let result;
    try {
      await proposalStarted.promise;
      readsAvailable = false;
      expect(await client.callTool({ name: "skill_list" })).toEqual(skillsUnavailable);
      expect(changes).toEqual(["notifications/tools/list_changed"]);
      readsAvailable = true;
      expect(await toolNames(client)).toEqual(allTools);
    } finally {
      delayedRefusal.resolve(refuse());
      result = await pending;
    }
    expect(result).toEqual(proposalsUnavailable);
    expect(changes).toHaveLength(1);

    expect(await client.callTool({ name: "skill_revise", arguments: revision })).toEqual(proposalsUnavailable);
    expect(changes).toHaveLength(2);
  });

  it("matches every query word across the skill name and description", async () => {
    const client = await connect(await gateway());
    for (const query of ["release notes", "-- DEPLOYS_Notes\trelease -_", "- _ -"]) {
      expect(await client.callTool({ name: "skill_list", arguments: { query } })).toEqual(jsonResult({ skills: [skill] }));
    }
    expect(await client.callTool({ name: "skill_list", arguments: { query: "release-notes_missing" } })).toEqual(
      jsonResult({ skills: [] }),
    );
  });

  it("filters the list locally and reads a skill by name or an exact text file by ID", async () => {
    const gw = await gateway();
    const client = await connect(gw);
    expect(await client.callTool({ name: "skill_list", arguments: { query: " DEPLOYS " } })).toEqual({
      content: [{ type: "text", text: JSON.stringify({ skills: [skill] }, null, 2) }],
    });
    expect(await client.callTool({ name: "skill_list", arguments: { query: "unrelated" } })).toMatchObject({
      content: [{ type: "text", text: '{\n  "skills": []\n}' }],
    });
    const { id, name, description, version } = skill;
    expect(await client.callTool({ name: "skill_get", arguments: { idOrName: "Release-Notes" } })).toEqual({
      content: [{ type: "text", text: JSON.stringify({
        id, name, description, version, body: skillBody, files: companionFiles,
      }, null, 2) }],
    });
    for (const [path, content] of [[filePath, fileContent], ["empty.txt", ""]]) {
      expect(await client.callTool({ name: "skill_get", arguments: { idOrName: id, path } })).toEqual({
        content: [{ type: "text", text: content }],
      });
    }
    expect(gw.requests.map(({ method, url }) => [method, url])).toEqual([
      ["GET", "/gw/v1/skills"],
      ["GET", "/gw/v1/skills"],
      ["GET", "/gw/v1/skills/Release-Notes"],
      ["GET", "/gw/v1/skills/skl_1/files/examples/Release%20%231%3F.json"],
      ["GET", "/gw/v1/skills/skl_1/files/empty.txt"],
    ]);
  });

  it("keeps the truncation marker after a local filter removes every result", async () => {
    const gw = await gateway({ truncated: true });
    const client = await connect(gw);
    const result = await client.callTool({ name: "skill_list" });
    expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringContaining('"skill-500"') }] });
    expect(await client.callTool({ name: "skill_list", arguments: { query: "skill-501" } })).toEqual(
      jsonResult({ skills: [], truncated: true }),
    );
    expect(gw.requests.every(({ url }) => url === "/gw/v1/skills")).toBe(true);
  });

  it("returns the Skills Installed receipt and distinguishes published and proposed name clashes", async () => {
    const state: Parameters<typeof gateway>[0] = {};
    const gw = await gateway(state);
    const client = await connect(gw);
    expect(await client.callTool({ name: "skill_propose", arguments: proposal })).toEqual(jsonResult(receipt));
    expect(gw.drafts.get(proposal.name)?.skillBody).toBe(
      "---\nname: triage-builds\ndescription: Find failed builds\n---\n\n# Improved notes",
    );
    const { files, ...withoutFiles } = proposal;
    const other = { ...withoutFiles, name: "another-skill" };
    expect(await client.callTool({ name: "skill_propose", arguments: other })).toEqual(
      jsonResult({ ...receipt, proposalId: "skl_3", skillId: "skl_3" }),
    );
    expect(await client.callTool({ name: "skill_propose", arguments: { ...proposal, name: skill.name } })).toEqual(
      nameTaken,
    );
    expect(await client.callTool({ name: "skill_propose", arguments: { ...proposal, body: "Different instructions" } })).toEqual(
      nameTaken,
    );
    state.refuseProposal = {
      status: 409, body: { error: "skill_name_proposed", message: "A skill with this name is waiting for a team lead to publish." },
    };
    expect(await client.callTool({ name: "skill_propose", arguments: { ...proposal, name: "team-draft" } })).toEqual(
      toolError("A proposal for that skill name is already waiting for review on Skills → Installed. A skill with this name is waiting for a team lead to publish."),
    );
    expect(gw.proposals).toEqual([proposal, other]);
  });

  it("replays a lost new proposal once with the identical payload and returns the original ID", async () => {
    const gw = await gateway({ dropProposal: "once", relativeReview: true });
    const client = await connect(gw);
    expect(await client.callTool({ name: "skill_propose", arguments: proposal })).toEqual(
      jsonResult({ ...receipt, reviewUrl: new URL("/skills/installed", gw.gatewayUrl).href }),
    );
    const post = { method: "POST", url: "/gw/v1/skills/proposals", body: proposal };
    expect(gw.requests).toEqual([post, post]);
    expect(gw.proposals).toEqual([proposal]);
    expect(gw.drafts.get(proposal.name)?.id).toBe(receipt.proposalId);
  });

  it("returns 409 when the name and body match a pending proposal but its companion files differ", async () => {
    const gw = await gateway();
    const statuses: number[] = [];
    const client = await connect({
      ...gw,
      fetchImpl: async (url, init) => {
        const response = await fetch(url, init);
        statuses.push(response.status);
        return response;
      },
    });
    expect(await client.callTool({ name: "skill_propose", arguments: proposal })).toEqual(jsonResult(receipt));
    const conflict = await client.callTool({
      name: "skill_propose", arguments: { ...proposal, files: [{ path: filePath, content: "Updated companion text" }] },
    });
    expect(statuses).toEqual([201, 409]);
    expect(conflict).toEqual(nameTaken);
    expect(gw.proposals).toEqual([proposal]);
  });

  it("points the agent to Skills Installed when its own waiting proposal already uses the name", async () => {
    const gw = await gateway();
    const client = await connect(gw);
    expect(await client.callTool({ name: "skill_propose", arguments: proposal })).toEqual(jsonResult(receipt));
    expect(await client.callTool({ name: "skill_propose", arguments: { ...proposal, body: "A different body" } })).toEqual(nameTaken);
  });

  it("stops replaying a new proposal after one retry and never replays a revision", async () => {
    const gw = await gateway({ dropProposal: "always" });
    const client = await connect(gw);
    const unconfirmed = toolError("Could not confirm the Eragon skill proposal. Check Skills → Installed before submitting again.");
    expect(await client.callTool({ name: "skill_propose", arguments: proposal })).toEqual(unconfirmed);
    expect(gw.requests.filter(({ method }) => method === "POST")).toHaveLength(2);
    expect(await client.callTool({ name: "skill_revise", arguments: revision })).toEqual(unconfirmed);
    expect(gw.requests.filter(({ method }) => method === "POST")).toHaveLength(3);
    expect(gw.drafts.get(skill.name)?.id).toBe(skill.id);
  });

  it("does not replay a proposal if response headers arrived before the connection failed", async () => {
    let calls = 0;
    const client = await connect({
      gatewayUrl: "https://tenant.example/gw",
      token,
      fetchImpl: async () => {
        calls += 1;
        const stream = new ReadableStream({
          start(controller) { controller.error(new TypeError("fetch failed")); },
        });
        return new Response(stream, { status: 201 });
      },
    });
    expect(await client.callTool({ name: "skill_propose", arguments: proposal })).toEqual(
      toolError("Could not confirm the Eragon skill proposal. Check Skills → Installed before submitting again."),
    );
    expect(calls).toBe(1);
  });

  it("surfaces one-line messages for validation, owner, availability, and revision-only refusals", async () => {
    const state: Parameters<typeof gateway>[0] = {};
    const gw = await gateway(state);
    const client = await connect(gw);
    const errors = [
      ["skill_propose", 400, { error: "invalid_proposal" },
        "Eragon rejected the skill proposal. Check the name, fields, and size limits."],
      ["skill_propose", 403, { error: "key_owner_unavailable", message: "the gateway key owner is no longer available" },
        "Eragon could not identify an owner for this key. Ask the user to check their Flux key. the gateway key owner is no longer available"],
      ["skill_propose", 503, { error: "skills_unavailable" },
        "Eragon Skills are temporarily unavailable. Try again shortly."],
      ["skill_revise", 403, { error: "skill_cannot_be_revised", message: "the key's owner cannot change this skill" },
        "This skill cannot be revised with the current Eragon key. the key's owner cannot change this skill"],
      ["skill_revise", 400, { error: "revision_files_unsupported", message: "a revision proposes SKILL.md only; its other files stay as they are" },
        "Skill revisions accept only SKILL.md changes. Remove files and submit the updated body. a revision proposes SKILL.md only; its other files stay as they are"],
    ] as const;
    for (const [name, status, body, message] of errors) {
      state.refuseProposal = { status, body };
      expect(await client.callTool({ name, arguments: name === "skill_propose" ? proposal : revision })).toEqual(toolError(message));
    }
    expect(gw.requests.filter(({ method }) => method === "POST")).toHaveLength(errors.length);
    expect(gw.proposals).toEqual([]);
  });

  it("reports oversized and binary file refusals with the appropriate guidance", async () => {
    const client = await connect(await gateway());
    expect(await client.callTool({ name: "skill_get", arguments: { idOrName: skill.id, path: "oversized.txt" } })).toEqual(
      toolError("This skill file is 262145 bytes and exceeds the 262144-byte read limit."),
    );
    expect(await client.callTool({ name: "skill_get", arguments: { idOrName: skill.id, path: "binary.dat" } })).toEqual(
      toolError("This skill file is binary. Open it in Eragon."),
    );
  });

  it("includes the nested Gateway error message in a one-line Skills result", async () => {
    const client = await connect({
      gatewayUrl: "https://tenant.example/gw", token,
      fetchImpl: async () => Response.json({
        type: "error", error: { type: "rate_limit_error", message: "Gateway limit reached.\nTry again shortly." },
        request_id: "req_rate",
      }, { status: 429 }),
    });
    expect(await client.callTool({ name: "skill_list" })).toEqual(
      toolError("Eragon Skills request failed (HTTP 429). Gateway limit reached. Try again shortly."),
    );
  });

  it("keeps Skills listed when a non-route 404 uses the Anthropic error envelope", async () => {
    const client = await connect({
      gatewayUrl: "https://tenant.example/gw", token,
      fetchImpl: async (url) => String(url).endsWith("/v1/skills") ? Response.json({ skills: [] }) : Response.json({
        type: "error", error: { type: "not_found_error", message: "A requested resource was not found." },
        request_id: "req_other_404",
      }, { status: 404 }),
    });
    const changes: string[] = [];
    client.setNotificationHandler(ToolListChangedNotificationSchema, ({ method }) => { changes.push(method); });
    expect(await toolNames(client)).toEqual(allTools);
    expect(await client.callTool({ name: "skill_get", arguments: { idOrName: "missing" } })).toEqual(
      toolError("Eragon Skills request failed (HTTP 404). A requested resource was not found."),
    );
    expect(changes).toEqual([]);
    expect(await toolNames(client)).toEqual(allTools);
  });

  it("rejects blank descriptions, reserved and repeated companion paths, and a zero base version locally", async () => {
    const gw = await gateway();
    const client = await connect(gw);
    const forbidden = [
      { ...proposal, description: " " },
      { ...proposal, files: [{ path: "SKILL.md", content: "" }] },
      { ...proposal, files: [...proposal.files, ...proposal.files] },
      { ...proposal, files: [{ path: "bad\0path", content: "" }] },
      { ...proposal, files: [{ path: "a".repeat(501), content: "" }] },
    ];
    for (const args of forbidden) {
      expect(await client.callTool({ name: "skill_propose", arguments: args })).toMatchObject({ isError: true });
    }
    expect(await client.callTool({ name: "skill_revise", arguments: { ...revision, baseVersion: 0 } })).toMatchObject({ isError: true });
    expect(gw.requests).toEqual([]);
  });

  it("rejects invalid names and proposal limits before sending the draft", async () => {
    const gw = await gateway();
    const client = await connect(gw);
    for (const name of ["", "Release-notes", "release notes", "release--notes", "release-notes ", "r".repeat(101)]) {
      expect(await client.callTool({ name: "skill_propose", arguments: { ...proposal, name } })).toEqual(
        toolError("The skill name must be kebab-case with at most 100 characters, such as release-notes."),
      );
    }
    const tooLarge = [
      [{ description: "a".repeat(501) }, "The skill description must contain 1 to 500 characters."],
      [{ body: "é".repeat(32_769) }, "The skill body must be at most 64 KiB of UTF-8 text."],
      [{ reason: "a".repeat(2001) }, "The proposal reason must be at most 2000 characters."],
      [{ files: Array.from({ length: 51 }, (_, index) => ({ path: `${index}.txt`, content: "" })) },
        "Provide at most 50 files with bundle-relative paths and text content."],
      [{ files: [{ path: "too-heavy.txt", content: "é".repeat(524_289) }] },
        "The proposed files must total at most 1 MiB of UTF-8 text."],
      [{ files: [{ path: "escaped.txt", content: "\0".repeat(400_000) }] },
        "The JSON skill proposal must be at most 2 MiB."],
    ] as const;
    for (const [overrides, message] of tooLarge) {
      expect(await client.callTool({ name: "skill_propose", arguments: { ...proposal, ...overrides } })).toEqual(toolError(message));
    }
    expect(await client.callTool({ name: "skill_propose", arguments: { ...proposal, reason: "" } })).toMatchObject({ isError: true });
    expect(gw.requests).toEqual([]);
    expect(await client.callTool({ name: "skill_propose", arguments: { ...proposal, body: "é".repeat(32_768) } })).toEqual(
      toolError("Eragon rejected the skill proposal. Check the name, fields, and size limits. SKILL.md with its frontmatter is over the size limit"),
    );
    const name = "a".repeat(100);
    const header = `---\nname: ${name}\n---\n\n`;
    const valid = {
      name, description: "a".repeat(500), body: header + "a".repeat(64 * 1024 - header.length), reason: "a".repeat(2000),
      files: Array.from({ length: 50 }, (_, index) => ({
        path: `${index}.txt`, content: index === 0 ? "é".repeat(524_288) : "",
      })),
    };
    expect(await client.callTool({ name: "skill_propose", arguments: valid })).toEqual(jsonResult(receipt));
    expect(gw.proposals).toEqual([valid]);
  });

  it("omits files from the revision schema and refuses supplied files before contacting the Gateway", async () => {
    const gw = await gateway();
    const client = await connect(gw);
    const tool = (await client.listTools()).tools.find(({ name }) => name === "skill_revise");
    expect(tool?.inputSchema.properties).not.toHaveProperty("files");
    for (const files of [[], proposal.files]) {
      expect(await client.callTool({ name: "skill_revise", arguments: { ...revision, files } })).toEqual(
        toolError("skill_revise accepts only SKILL.md changes. Remove files and submit the updated body."),
      );
    }
    expect(gw.requests).toEqual([{ method: "GET", url: "/gw/v1/skills", body: undefined }]);
  });

  it("tells the agent to re-read after an in-progress change lands before retrying the revision", async () => {
    const client = await connect(await gateway({ pendingRevision: true }));
    expect(await client.callTool({ name: "skill_revise", arguments: revision })).toEqual(
      toolError("Another change to this skill is being applied. Call skill_get after it lands, then retry skill_revise. another change to this skill is being applied; propose again after it lands"),
    );
  });

  it("sends a body-only revision as a single POST with no metadata read", async () => {
    const gw = await gateway();
    const client = await connect(gw);
    expect(await client.callTool({ name: "skill_revise", arguments: revision })).toEqual(
      jsonResult({ ...receipt, proposalId: skill.id, skillId: skill.id, kind: "revision", baseVersion: skill.version }),
    );
    expect(gw.requests).toEqual([{
      method: "POST", url: "/gw/v1/skills/proposals",
      body: { ...draft, baseSkillId: skill.id, baseVersion: skill.version },
    }]);
  });

  it("revises a legacy non-kebab skill while the create route still refuses a non-kebab name", async () => {
    const skillName = "Release Notes Legacy";
    const gw = await gateway({ skillName });
    const client = await connect(gw);
    const refused = await fetch(`${gw.gatewayUrl}/v1/skills/proposals`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...proposal, name: skillName }),
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "invalid_proposal" });
    expect(await client.callTool({ name: "skill_revise", arguments: revision })).toEqual(
      jsonResult({ ...receipt, proposalId: skill.id, skillId: skill.id, kind: "revision", baseVersion: skill.version }),
    );
    expect(gw.drafts.get(skillName)?.skillBody).toContain(`name: ${skillName}`);
  });

  it("excludes name and description from the revision schema and request", async () => {
    const gw = await gateway();
    const client = await connect(gw);
    const tool = (await client.listTools()).tools.find(({ name }) => name === "skill_revise");
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual(
      ["baseVersion", "body", "reason", "skillId"],
    );
    for (const metadata of [{ name: "renamed-skill" }, { description: "Changed description" }]) {
      expect(await client.callTool({ name: "skill_revise", arguments: { ...revision, ...metadata } })).toEqual(
        toolError("skill_revise accepts only SKILL.md changes. Remove name and description and submit the updated body."),
      );
    }
    expect(await client.callTool({ name: "skill_revise", arguments: revision })).toEqual(
      jsonResult({ ...receipt, proposalId: skill.id, skillId: skill.id, kind: "revision", baseVersion: skill.version }),
    );
    expect(gw.requests).toEqual([
      { method: "GET", url: "/gw/v1/skills", body: undefined },
      { method: "POST", url: "/gw/v1/skills/proposals", body: { ...draft, baseSkillId: skill.id, baseVersion: skill.version } },
    ]);
  });

  it("submits a revision with its own SKILL.md frontmatter", async () => {
    const gw = await gateway();
    const client = await connect(gw);
    const body = "---\nname: different-name\ndescription: Updated instructions\n---\n\nNew release steps.";
    expect(await client.callTool({ name: "skill_revise", arguments: { ...revision, body } })).toEqual(
      jsonResult({ ...receipt, proposalId: skill.id, skillId: skill.id, kind: "revision", baseVersion: skill.version }),
    );
    expect(gw.requests).toEqual([{
      method: "POST", url: "/gw/v1/skills/proposals",
      body: { ...draft, body, baseSkillId: skill.id, baseVersion: skill.version },
    }]);
    expect(gw.drafts.get(skill.name)?.skillBody).toBe(body.replace("name: different-name", `name: ${skill.name}`));
  });

  it("handles unchanged and pending revisions and allows another review draft to replace the first", async () => {
    const state: Parameters<typeof gateway>[0] = { relativeReview: true };
    const gw = await gateway(state);
    const client = await connect(gw);
    expect(await client.callTool({ name: "skill_revise", arguments: { ...revision, body: skillBody } })).toEqual(
      toolError("The revision matches the published skill. Current version is 3. Submit a revision only when the body changes. the skill already says this"),
    );
    const revisionReceipt = jsonResult({
      proposalId: skill.id, status: "proposed", reviewUrl: new URL("/skills/installed", gw.gatewayUrl).href,
      kind: "revision", skillId: skill.id, baseVersion: 3,
    });
    expect(await client.callTool({ name: "skill_revise", arguments: revision })).toEqual(revisionReceipt);
    expect(gw.proposals).toEqual([{ ...draft, baseSkillId: skill.id, baseVersion: 3 }]);
    expect(await client.callTool({ name: "skill_revise", arguments: { ...revision, body: "Replaced draft" } })).toEqual(revisionReceipt);
    expect(gw.drafts.get(skill.name)).toMatchObject({ status: "review", skillBody: expect.stringContaining("Replaced draft") });
    state.pendingRevision = true;
    expect(await client.callTool({ name: "skill_revise", arguments: revision })).toEqual(
      toolError("Another change to this skill is being applied. Call skill_get after it lands, then retry skill_revise. another change to this skill is being applied; propose again after it lands"),
    );
  });

  it("reports a stale revision, tells the agent to fetch and retry once, and preserves the supplied base version", async () => {
    const state: Parameters<typeof gateway>[0] = {};
    const gw = await gateway(state);
    const client = await connect(gw);
    const prior = await client.callTool({ name: "skill_get", arguments: { idOrName: skill.id } });
    expect(prior).toMatchObject({ content: [{ type: "text", text: expect.stringContaining('"version": 3') }] });
    state.version = 4;
    expect(await client.callTool({ name: "skill_revise", arguments: revision })).toEqual({
      isError: true,
      content: [{ type: "text", text: "The skill version changed. Current version is 4. Call skill_get again, reconcile your changes, and retry skill_revise once. the skill changed to v4 after this was written for v3" }],
    });
    const postRequests = () => gw.requests.filter(({ method }) => method === "POST");
    expect(gw.proposals).toEqual([]);
    const revisionPost = { ...draft, baseSkillId: skill.id, baseVersion: 3 };
    expect(postRequests()).toEqual([{ method: "POST", url: "/gw/v1/skills/proposals", body: revisionPost }]);

    const latest = await client.callTool({ name: "skill_get", arguments: { idOrName: skill.id } });
    expect(latest).toMatchObject({ content: [{ type: "text", text: expect.stringContaining('"version": 4') }] });
    expect(await client.callTool({ name: "skill_revise", arguments: { ...revision, baseVersion: 4 } })).toEqual(
      jsonResult({ ...receipt, proposalId: skill.id, kind: "revision", skillId: skill.id, baseVersion: 4 }),
    );
    expect(postRequests()).toHaveLength(2);
    expect(gw.proposals).toEqual([{ ...revisionPost, baseVersion: 4 }]);
    expect(await client.callTool({ name: "skill_get", arguments: { idOrName: skill.id } })).toEqual(latest);
  });

  it("handles a flag flip after listing and independently handles a missing skill", async () => {
    const state: Parameters<typeof gateway>[0] = {};
    const client = await connect(await gateway(state));
    const changes: string[] = [];
    client.setNotificationHandler(ToolListChangedNotificationSchema, ({ method }) => { changes.push(method); });
    expect(await toolNames(client)).toEqual(allTools);
    expect(await client.callTool({ name: "skill_get", arguments: { idOrName: "missing" } })).toEqual({
      isError: true, content: [{ type: "text", text: "Eragon could not find that skill or file. Use skill_list or skill_get to check the name, ID, or path." }],
    });
    expect(changes).toEqual([]);
    state.skills = "flag off";
    expect(await client.callTool({ name: "skill_get", arguments: { idOrName: skill.id, path: filePath } })).toEqual(skillsUnavailable);
    expect(changes).toEqual(["notifications/tools/list_changed"]);
    expect(await toolNames(client)).toEqual(memoryTools);
    state.skills = "on";
    expect(await toolNames(client)).toEqual(allTools);
  });

  it("handles a flag flip between listing Skills and posting a revision", async () => {
    const state: Parameters<typeof gateway>[0] = {};
    const gw = await gateway(state);
    const client = await connect(gw);
    expect(await toolNames(client)).toEqual(allTools);
    state.skills = "flag off";
    expect(await client.callTool({ name: "skill_revise", arguments: revision })).toEqual(proposalsUnavailable);
    expect(gw.proposals).toEqual([]);
    expect(await toolNames(client)).toEqual(memoryTools);
  });

  it("rejects an invalid version and paths that could escape the skill route before sending requests", async () => {
    const gw = await gateway();
    const client = await connect(gw);
    expect(await client.callTool({ name: "skill_revise", arguments: { ...revision, baseVersion: 3.5 } })).toMatchObject({ isError: true });
    expect(await client.callTool({ name: "skill_get", arguments: { idOrName: ".." } })).toMatchObject({ isError: true });
    expect(await client.callTool({ name: "skill_get", arguments: { idOrName: skill.id, path: "examples/../SKILL.md" } })).toMatchObject({ isError: true });
    expect(gw.requests).toEqual([]);
  });

  it.each(["Flux runner", "Claude Code environment"] as const)("serves Skills over stdio with the %s key and URL", async (launcher) => {
    const { gatewayUrl } = await gateway();
    const client = testClient();
    const entry = fileURLToPath(new URL("../bin/eragon-context-mcp.mjs", import.meta.url));
    const claudeEnv = launcher === "Claude Code environment";
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: claudeEnv ? [entry] : [entry, "--url", gatewayUrl],
      env: claudeEnv ? { ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_BASE_URL: gatewayUrl } : { ERAGON_API_KEY: token },
    }));
    expect(await toolNames(client)).toEqual(allTools);
    expect(await client.callTool({ name: "skill_list" })).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining(skill.name) }],
    });
  });
});
