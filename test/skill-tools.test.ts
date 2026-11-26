import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, onTestFinished } from "vitest";

import { createMemoryMcpServer } from "../src/server.js";
import { probeSkills } from "../src/skill-tools.js";

const token = "test-flux-key";
const memoryTools = ["memory_search", "memory_save", "memory_share"];
const skillTools = ["skill_list", "skill_get", "skill_propose", "skill_revise"];
const allTools = [...memoryTools, ...skillTools];
const readTools = [...memoryTools, "skill_list", "skill_get"];
const unknownRoute = {
  type: "error", error: { type: "not_found_error", message: "unknown gateway path" }, request_id: "req_skills",
};
const skillsUnavailable = { content: [{ type: "text", text: "Eragon Skills are unavailable on this server or for this key." }] };
const proposalsUnavailable = { content: [{ type: "text", text: "Eragon skill proposals are unavailable on this server or for this key." }] };
const skill = {
  id: "skl_1",
  name: "release-notes",
  description: "Prepare a change summary for deploys",
  version: 3,
  updatedAt: "2026-11-25T00:00:00.000Z",
  scope: "personal",
};
const skillBody = "---\nname: release-notes\ndescription: Prepare a change summary for deploys\n---\n# Release notes\n";
const filePath = "examples/Release #1?.json";
const fileContent = '{ "template": "Changes" }\n';
const companionFiles = [
  { path: filePath, bytes: Buffer.byteLength(fileContent) },
  { path: "empty.txt", bytes: 0 },
  { path: "oversized.txt", bytes: 262145 },
  { path: "binary.dat", bytes: 4 },
];
const installed = "https://tenant.example/skills/installed";
const receipt = { proposalId: "skl_2", status: "proposed", reviewUrl: installed, kind: "skill", skillId: "skl_2" };

// The ERA-5184 Gateway contract in the task brief, over real loopback HTTP.
async function gateway(state: {
  skills?: "on" | "flag off" | "old server" | "no grant" | "issued key" | "console key";
  memoryWrite?: boolean;
  empty?: boolean;
  truncated?: boolean;
  relativeReview?: boolean;
  afterRead?: "publish" | "disable";
  dropProposal?: "once" | "always";
  refuseProposal?: { status: number; body: { error: string; message?: string } };
} = {}) {
  const requests: { method: string | undefined; url: string | undefined; body: unknown }[] = [];
  const proposals: unknown[] = [];
  const drafts = new Map<string, { id: string; submittedBody: string; skillBody: string }>();
  let version = skill.version;
  const server = createServer(async (request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    };
    const { method, url } = request;
    const data: Buffer[] = [];
    for await (const chunk of request) data.push(chunk);
    const payload = Buffer.concat(data);
    const body = payload.length ? JSON.parse(payload.toString()) : undefined;
    requests.push({ method, url, body });
    if (request.headers.authorization !== `Bearer ${token}`) return send(401, { error: "invalid key" });
    if (method === "POST" && url === "/gw/v1/memory/search") return send(200, { memories: [{ id: "mem_1" }] });
    if (method === "POST" && url === "/gw/v1/memory") {
      return state.memoryWrite === false
        ? send(403, { error: "Memory write-back is disabled for this key." })
        : send(201, { id: "mem_2" });
    }
    if (method === "POST" && url === "/gw/v1/memory/share") {
      return state.memoryWrite === false
        ? send(403, { error: "Memory write-back is disabled for this key." })
        : send(202, { approval: { id: "approval_1", reviewPath: "/inbox" } });
    }
    if (state.skills !== undefined && state.skills !== "on") return send(404, unknownRoute);
    if (method === "GET" && url === "/gw/v1/skills") {
      if (state.truncated) {
        const capped = Array.from({ length: 500 }, (_, index) => ({
          ...skill, id: `skl_${index + 10}`, name: `skill-${String(index + 1).padStart(3, "0")}`,
        }));
        return send(200, { skills: capped, truncated: true });
      }
      return send(200, { skills: state.empty ? [] : [{ ...skill, version }] });
    }
    if (method === "POST" && url === "/gw/v1/skills/proposals") {
      if (state.memoryWrite === false) return send(404, unknownRoute);
      if (state.refuseProposal) return send(state.refuseProposal.status, state.refuseProposal.body);
      if (
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.name) || body.name.length > 100 ||
        body.description.length > 500 || Buffer.byteLength(body.body) > 64 * 1024 ||
        body.reason.length < 1 || body.reason.length > 2000 ||
        (body.files !== undefined && (body.files.length > 50 ||
          body.files.reduce((bytes: number, file: { content: string }) => bytes + Buffer.byteLength(file.content), 0) > 1024 * 1024)) ||
        payload.byteLength > 2 * 1024 * 1024
      ) return send(400, { error: "invalid_proposal" });
      const reply = (id: string) => {
        if (state.dropProposal) {
          if (state.dropProposal === "once") delete state.dropProposal;
          request.socket.destroy();
          return;
        }
        const result = {
          proposalId: id, status: "proposed", reviewUrl: state.relativeReview ? "/skills/installed" : installed,
          kind: body.baseSkillId ? "revision" : "skill", skillId: id,
          ...(body.baseSkillId ? { baseVersion: body.baseVersion } : {}),
        };
        send(201, result);
      };
      if (body.baseSkillId) {
        if (body.files !== undefined) return send(400, { error: "revision_files_unsupported" });
        if (body.baseSkillId !== skill.id) return send(404, { error: "skill_not_found" });
        if (body.baseVersion !== version) return send(409, { error: "skill_version_conflict", currentVersion: version });
        if (body.body === skillBody) return send(409, { error: "skill_revision_unchanged", currentVersion: version });
      } else if (body.name === skill.name) {
        return send(409, { error: "skill_name_taken" });
      }
      const existing = drafts.get(body.name);
      if (existing !== undefined) {
        if (body.baseSkillId) return send(409, { error: "skill_revision_waiting" });
        if (existing.submittedBody === body.body) return reply(existing.id);
        return send(409, { error: "skill_name_proposed" });
      }
      const id = body.baseSkillId ?? `skl_${drafts.size + 2}`;
      const name = body.baseSkillId ? skill.name : body.name;
      const description = body.baseSkillId ? skill.description : body.description;
      const withFrontmatter = body.body.startsWith("---\n")
        ? body.body
        : `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n${body.body}`;
      drafts.set(name, { id, submittedBody: body.body, skillBody: withFrontmatter });
      proposals.push(body);
      return reply(id);
    }
    if (method === "GET" && (url === "/gw/v1/skills/skl_1" || url === "/gw/v1/skills/release-notes")) {
      const detail = {
        id: skill.id, name: skill.name, description: skill.description, version,
        body: skillBody, files: companionFiles,
      };
      if (state.afterRead === "publish") version += 1;
      if (state.afterRead === "disable") state.skills = "flag off";
      delete state.afterRead;
      return send(200, detail);
    }
    if (method === "GET" && url === "/gw/v1/skills/skl_1/files/examples/Release%20%231%3F.json") {
      response.writeHead(200, { "content-type": "text/plain" }).end(fileContent);
      return;
    }
    if (method === "GET" && url === "/gw/v1/skills/skl_1/files/empty.txt") {
      response.writeHead(200, { "content-type": "text/plain" }).end();
      return;
    }
    if (method === "GET" && url === "/gw/v1/skills/skl_1/files/oversized.txt") {
      return send(413, { error: "skill_file_too_large", bytes: 262145, maxBytes: 262144 });
    }
    if (method === "GET" && url === "/gw/v1/skills/skl_1/files/binary.dat") {
      return send(415, { error: "skill_file_not_text" });
    }
    if (method === "GET" && url?.startsWith("/gw/v1/skills/")) return send(404, { error: "skill_not_found" });
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

  it("bounds discovery even if the Flux key re-read stalls before fetch sees the abort signal", async () => {
    const delayed = Promise.withResolvers<Response>();
    try {
      expect(await probeSkills({
        gatewayUrl: "https://tenant.example/gw",
        token,
        fetchImpl: () => delayed.promise,
      }, 10)).toBe("unknown");
    } finally {
      delayed.resolve(Response.json({ skills: [] }));
    }
  });

  it("hides only writers after a proposal's unknown-route 404 and keeps reads available", async () => {
    const state: Parameters<typeof gateway>[0] = { memoryWrite: false };
    const gw = await gateway(state);
    const client = await connect(gw);
    const changes: string[] = [];
    client.setNotificationHandler(ToolListChangedNotificationSchema, ({ method }) => { changes.push(method); });
    expect(await toolNames(client)).toEqual(allTools);
    expect(await client.callTool({ name: "skill_list" })).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining(skill.name) }],
    });
    expect(await client.callTool({ name: "memory_save", arguments: save })).toEqual({
      isError: true, content: [{ type: "text", text: "Memory write-back is disabled for this key." }],
    });
    expect(await client.callTool({ name: "skill_propose", arguments: proposal })).toEqual(proposalsUnavailable);
    expect(changes).toEqual(["notifications/tools/list_changed"]);
    expect(await toolNames(client)).toEqual(readTools);
    expect(await client.callTool({ name: "skill_revise", arguments: revision })).toEqual(proposalsUnavailable);
    expect(gw.requests.filter(({ url }) => url === "/gw/v1/skills/proposals")).toHaveLength(1);
    expect(gw.requests.some(({ url }) => url === "/gw/v1/skills/skl_1")).toBe(false);
    expect(await client.callTool({ name: "memory_search", arguments: { query: "release" } })).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("mem_1") }],
    });
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
    expect(await client.callTool({ name: "skill_get", arguments: { idOrName: name } })).toEqual({
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
      ["GET", "/gw/v1/skills/release-notes"],
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
    const gw = await gateway();
    const client = await connect(gw);
    expect(await client.callTool({ name: "skill_propose", arguments: proposal })).toEqual(jsonResult(receipt));
    expect(gw.drafts.get(proposal.name)?.skillBody).toBe(
      '---\nname: "triage-builds"\ndescription: "Find failed builds"\n---\n# Improved notes\n',
    );
    const { files, ...withoutFiles } = proposal;
    const other = { ...withoutFiles, name: "another-skill" };
    expect(await client.callTool({ name: "skill_propose", arguments: other })).toEqual(
      jsonResult({ ...receipt, proposalId: "skl_3", skillId: "skl_3" }),
    );
    expect(await client.callTool({ name: "skill_propose", arguments: { ...proposal, name: skill.name } })).toEqual(
      toolError("A published skill already uses that name. Use skill_get to see it or choose another name."),
    );
    expect(await client.callTool({ name: "skill_propose", arguments: { ...proposal, body: "Different instructions" } })).toEqual(
      toolError("A proposal for that skill name is already waiting for review on Skills → Installed."),
    );
    expect(gw.proposals).toEqual([proposal, other]);
  });

  it("replays a lost new proposal once with the identical payload and returns the original ID", async () => {
    const gw = await gateway({ dropProposal: "once", relativeReview: true });
    const client = await connect(gw);
    expect(await client.callTool({ name: "skill_propose", arguments: proposal })).toEqual(
      jsonResult({ ...receipt, reviewUrl: "/skills/installed" }),
    );
    const post = { method: "POST", url: "/gw/v1/skills/proposals", body: proposal };
    expect(gw.requests).toEqual([post, post]);
    expect(gw.proposals).toEqual([proposal]);
    expect(gw.drafts.get(proposal.name)?.id).toBe(receipt.proposalId);
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
      ["skill_propose", 400, { error: "invalid_proposal", message: "Check the fields.\nReduce the draft." },
        "Eragon rejected the skill proposal. Check the name, fields, and size limits. Check the fields. Reduce the draft."],
      ["skill_propose", 403, { error: "key_owner_unavailable" },
        "Eragon could not identify an owner for this key. Ask the user to check their Flux key."],
      ["skill_propose", 503, { error: "skills_unavailable" },
        "Eragon Skills are temporarily unavailable. Try again shortly."],
      ["skill_revise", 403, { error: "skill_cannot_be_revised" },
        "This skill cannot be revised with the current Eragon key."],
      ["skill_revise", 400, { error: "revision_files_unsupported" },
        "Skill revisions accept only SKILL.md changes. Remove files and submit the updated body."],
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

  it("rejects invalid names and proposal limits before sending the draft", async () => {
    const gw = await gateway();
    const client = await connect(gw);
    for (const name of ["", "Release-notes", "release notes", "release--notes", "release-notes ", "r".repeat(101)]) {
      expect(await client.callTool({ name: "skill_propose", arguments: { ...proposal, name } })).toEqual(
        toolError("The skill name must be kebab-case with at most 100 characters, such as release-notes."),
      );
    }
    const tooLarge = [
      [{ description: "a".repeat(501) }, "The skill description must be a string of at most 500 characters."],
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
    const valid = {
      name: "a".repeat(100), description: "a".repeat(500), body: "é".repeat(32_768), reason: "a".repeat(2000),
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

  it("handles unchanged and pending revisions and uses the published name and description", async () => {
    const gw = await gateway({ relativeReview: true });
    const client = await connect(gw);
    expect(await client.callTool({ name: "skill_revise", arguments: { ...revision, body: skillBody } })).toEqual(
      toolError("The revision matches the published skill. Current version is 3. Submit a revision only when the body changes."),
    );
    expect(await client.callTool({
      name: "skill_revise", arguments: { ...revision, name: "renamed-skill", description: "Changed description" },
    })).toEqual(jsonResult({
      proposalId: skill.id, status: "proposed", reviewUrl: "/skills/installed", kind: "revision", skillId: skill.id, baseVersion: 3,
    }));
    expect(gw.proposals).toEqual([{ ...draft, name: skill.name, description: skill.description, baseSkillId: skill.id, baseVersion: 3 }]);
    expect(await client.callTool({ name: "skill_revise", arguments: revision })).toEqual(
      toolError("A change to this skill is already waiting for review on Skills → Installed."),
    );
  });

  it("reports a stale revision, tells the agent to fetch and retry once, and preserves the supplied base version", async () => {
    const state: Parameters<typeof gateway>[0] = {};
    const gw = await gateway(state);
    const client = await connect(gw);
    const prior = await client.callTool({ name: "skill_get", arguments: { idOrName: skill.id } });
    expect(prior).toMatchObject({ content: [{ type: "text", text: expect.stringContaining('"version": 3') }] });
    state.afterRead = "publish";
    expect(await client.callTool({ name: "skill_revise", arguments: revision })).toEqual({
      isError: true,
      content: [{ type: "text", text: "The skill version changed. Current version is 4. Call skill_get again, reconcile your changes, and retry skill_revise once." }],
    });
    const postRequests = () => gw.requests.filter(({ method }) => method === "POST");
    expect(gw.proposals).toEqual([]);
    const revisionPost = { ...draft, name: skill.name, description: skill.description, baseSkillId: skill.id, baseVersion: 3 };
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

  it("handles a flag flip between a revision's metadata read and proposal POST", async () => {
    const gw = await gateway({ afterRead: "disable" });
    const client = await connect(gw);
    expect(await toolNames(client)).toEqual(allTools);
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
