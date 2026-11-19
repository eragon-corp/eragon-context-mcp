import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

const BIN = fileURLToPath(new URL("../bin/eragon-context-mcp.mjs", import.meta.url));
const TOKEN = "fake-gateway-key";
const TEXT = "<eragon_memory_context>\n[Memory: Review]\n</eragon_memory_context>";
const EVENT = { hook_event_name: "UserPromptSubmit", prompt: "How do we review this?" };
/** The Gateway's recall reply, exactly as `POST /gw/v1/memory/recall` sends it (Eragon_s PR #5796): no `ok` field. */
const REPLY = { text: TEXT, count: 2, status: "ok" };
/** The client kills the hook at this many milliseconds after spawn and reports a timeout error. */
const CLIENT_TIMEOUT_MS = 3000;

describe("recall-hook executable", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server === undefined) return;
    const current = server;
    server = undefined;
    current.closeAllConnections();
    await new Promise<void>((resolve, reject) => current.close((error) => error ? reject(error) : resolve()));
  });

  async function gateway(respond: (response: ServerResponse, request: IncomingMessage) => void) {
    const calls: { method?: string; url?: string; headers: IncomingMessage["headers"]; body: string }[] = [];
    server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request.setEncoding("utf8")) body += chunk;
      calls.push({ method: request.method, url: request.url, headers: request.headers, body });
      respond(response, request);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected a TCP address");
    return { url: `http://127.0.0.1:${address.port}/gw`, calls };
  }

  function runHook(input: string | undefined, gatewayEnv: NodeJS.ProcessEnv, args: string[] = []) {
    const env = {
      ...process.env,
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
      ANTHROPIC_BASE_URL: undefined,
      ERAGON_API_KEY: undefined,
      ERAGON_GATEWAY_URL: undefined,
      ...gatewayEnv,
    };
    return new Promise<{ code: number | string | undefined; stdout: string; stderr: string; elapsed: number }>((resolve) => {
      const started = performance.now();
      const child = execFile(BIN, ["recall-hook", ...args], { env, timeout: 6500 }, (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : error.code ?? undefined, stdout, stderr, elapsed: performance.now() - started });
      });
      child.stdin?.on("error", () => { /* The hook can exit without consuming stdin. */ });
      if (input !== undefined) child.stdin?.end(input);
    });
  }

  it.each(["Claude Code", "Codex"])("sends one authenticated POST for a %s hook event and emits the rendered block verbatim", async (agent) => {
    const { url, calls } = await gateway((response) => response.end(JSON.stringify(REPLY)));
    const common = { ...EVENT, prompt: "  How do we review this?\n", cwd: "/workspace", session_id: "session-id" };
    const input = agent === "Claude Code"
      ? { ...common, transcript_path: "/workspace/claude.jsonl", permission_mode: "default" }
      : { ...common, transcript_path: "/workspace/codex.jsonl", turn_id: "turn-id", permission_mode: "default" };
    const result = agent === "Claude Code"
      ? await runHook(JSON.stringify(input), { ANTHROPIC_BASE_URL: url, ANTHROPIC_AUTH_TOKEN: TOKEN })
      : await runHook(JSON.stringify(input), { ERAGON_API_KEY: TOKEN }, ["--url", url]);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "/gw/v1/memory/recall",
      headers: { authorization: `Bearer ${TOKEN}`, "user-agent": `eragon-context-mcp/${VERSION}` },
      body: JSON.stringify({ query: input.prompt }),
    });
    expect(result).toMatchObject({
      code: 0,
      stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: EVENT.hook_event_name, additionalContext: TEXT } })}\n`,
      stderr: "",
    });
  });

  it("accepts the Gateway's exact recall reply, which has no ok field", async () => {
    const body = '{"text":"<eragon_memory_context>…</eragon_memory_context>","count":2,"status":"ok"}';
    const { url, calls } = await gateway((response) => {
      response.writeHead(200, { "content-type": "application/json" }).end(body);
    });
    const result = await runHook(JSON.stringify(EVENT), { ERAGON_GATEWAY_URL: url, ERAGON_API_KEY: TOKEN });
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "<eragon_memory_context>…</eragon_memory_context>",
      },
    });
  });

  it("stays silent for an old gateway returning 404, even if its body looks successful", async () => {
    const { url, calls } = await gateway((response) => {
      response.writeHead(404).end(JSON.stringify(REPLY));
    });
    const result = await runHook(JSON.stringify(EVENT), { ERAGON_GATEWAY_URL: url, ERAGON_API_KEY: TOKEN });
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
  });

  it("ignores malformed, blank, multiple and wrong-event inputs without calling the gateway", async () => {
    const { url, calls } = await gateway((response) => response.end());
    const env = { ERAGON_GATEWAY_URL: url, ERAGON_API_KEY: TOKEN };
    for (const input of ["{", '{"prompt":"  "}', '[]', '{"prompt":42}', '{"prompt":"one"}\n{"prompt":"two"}', '{"hook_event_name":"Stop","prompt":"x"}']) {
      expect(await runHook(input, env)).toMatchObject({ code: 0, stdout: "", stderr: "" });
    }
    expect(calls).toHaveLength(0);
  });

  it("is silent with missing configuration, empty recall, or a malformed or unsuccessful response", async () => {
    const bodies = ["", '{"text":"  ","count":0,"status":"ok"}', '{"text":42,"count":1,"status":"ok"}', '{"count":0,"status":"ok"}', "invalid json", JSON.stringify(TEXT), JSON.stringify([REPLY])];
    const { url, calls } = await gateway((response) => response.end(bodies.shift()));
    const input = JSON.stringify(EVENT);
    expect(await runHook(input, { ERAGON_GATEWAY_URL: url })).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(calls).toHaveLength(0);
    const count = bodies.length;
    for (let index = 0; index < count; index += 1) {
      expect(await runHook(input, { ERAGON_GATEWAY_URL: url, ERAGON_API_KEY: TOKEN })).toMatchObject({ code: 0, stdout: "", stderr: "" });
    }
    expect(calls).toHaveLength(count);
  });

  it("exits successfully and silently when the gateway disconnects", async () => {
    const { url, calls } = await gateway((response) => response.destroy());
    const result = await runHook(JSON.stringify(EVENT), { ERAGON_GATEWAY_URL: url, ERAGON_API_KEY: TOKEN });
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
  });

  it("exits silently before the client's three-second timeout when the Gateway never answers", async () => {
    const { url, calls } = await gateway(() => { /* Never answers. */ });
    const result = await runHook(JSON.stringify(EVENT), { ERAGON_GATEWAY_URL: url, ERAGON_API_KEY: TOKEN });
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(result.elapsed).toBeLessThan(CLIENT_TIMEOUT_MS);
  }, 7500);

  it("gives up before the client's timeout even when headers arrived, and emits nothing for a late body", async () => {
    let sentLateBody = false;
    const { url, calls } = await gateway((response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"count":2,"status":"ok",');
      const late = setTimeout(() => {
        sentLateBody = true;
        response.end(`"text":${JSON.stringify(TEXT)}}`);
      }, 4500);
      response.on("close", () => clearTimeout(late));
    });
    const result = await runHook(JSON.stringify(EVENT), { ERAGON_GATEWAY_URL: url, ERAGON_API_KEY: TOKEN });
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(result.elapsed).toBeLessThan(CLIENT_TIMEOUT_MS);
    expect(sentLateBody).toBe(false);
  }, 7500);

  it("applies the same deadline to stdin that never closes", async () => {
    const { url, calls } = await gateway((response) => response.end());
    const result = await runHook(undefined, { ERAGON_GATEWAY_URL: url, ERAGON_API_KEY: TOKEN });
    expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(result.elapsed).toBeLessThan(CLIENT_TIMEOUT_MS);
    expect(calls).toHaveLength(0);
  }, 7500);
});
