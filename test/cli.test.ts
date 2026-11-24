import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { loadConfig, prepareBridge, resolveConfig } from "../src/cli.js";
import { createBridgeServer } from "../src/server.js";

describe("resolveConfig", () => {
  it("uses Claude Code's existing Gateway environment without storing another secret", () => {
    expect(
      resolveConfig([], {
        ANTHROPIC_BASE_URL: "https://s.eragon.ai/gw",
        ANTHROPIC_API_KEY: "test-token",
      }),
    ).toEqual({
      ok: true,
      gatewayUrl: "https://s.eragon.ai/gw",
      token: "test-token",
    });
  });

  it("lets an explicit URL override the model Gateway URL", () => {
    expect(
      resolveConfig(["--url", "https://preview.s.eragon.ai/gw"], {
        ERAGON_GATEWAY_URL: "https://s.eragon.ai/gw",
        ERAGON_API_KEY: "test-token",
      }),
    ).toEqual({
      ok: true,
      gatewayUrl: "https://preview.s.eragon.ai/gw",
      token: "test-token",
    });
  });

  it("uses the key the Connect page gives Claude Code in ANTHROPIC_AUTH_TOKEN", () => {
    expect(
      resolveConfig([], {
        ANTHROPIC_BASE_URL: "https://s.eragon.ai/gw",
        ANTHROPIC_AUTH_TOKEN: "model-key",
      }),
    ).toEqual({ ok: true, gatewayUrl: "https://s.eragon.ai/gw", token: "model-key" });
  });

  it("refuses to save Memory under a different key than the model calls use", () => {
    const resolved = resolveConfig([], {
      ANTHROPIC_BASE_URL: "https://s.eragon.ai/gw",
      ANTHROPIC_AUTH_TOKEN: "new-model-key",
      ERAGON_API_KEY: "old-memory-key",
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.error).toContain("ERAGON_API_KEY");
      expect(resolved.error).not.toContain("old-memory-key");
      expect(resolved.error).not.toContain("new-model-key");
    }
  });

  it("checks the key Claude Code sends, which is ANTHROPIC_API_KEY when both are set", () => {
    expect(
      resolveConfig([], {
        ANTHROPIC_BASE_URL: "https://s.eragon.ai/gw",
        ANTHROPIC_API_KEY: "model-key",
        ANTHROPIC_AUTH_TOKEN: "unused-token",
        ERAGON_API_KEY: "model-key",
      }),
    ).toEqual({ ok: true, gatewayUrl: "https://s.eragon.ai/gw", token: "model-key" });
  });

  it("accepts ERAGON_API_KEY beside the same model key", () => {
    expect(
      resolveConfig([], {
        ANTHROPIC_BASE_URL: "https://s.eragon.ai/gw",
        ANTHROPIC_AUTH_TOKEN: "one-key",
        ERAGON_API_KEY: "one-key",
      }),
    ).toEqual({ ok: true, gatewayUrl: "https://s.eragon.ai/gw", token: "one-key" });
  });

  it("does not compare keys when model calls do not go through a base URL", () => {
    expect(
      resolveConfig(["--url", "https://s.eragon.ai/gw"], {
        ANTHROPIC_API_KEY: "anthropic-direct-key",
        ERAGON_API_KEY: "memory-key",
      }),
    ).toEqual({ ok: true, gatewayUrl: "https://s.eragon.ai/gw", token: "memory-key" });
  });
});

/** A shell command that runs `code` in this Node, for a key command that works on every CI runner. */
const node = (code: string) => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`;
const GW = "https://acme.s.eragon.ai/gw";
const PATH_ONLY = { PATH: process.env.PATH };

describe("loadConfig: the key from a command when the environment has none", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("still refuses without a key or a key command", async () => {
    const resolved = await loadConfig(["--url", GW], PATH_ONLY);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error).toContain("--key-command");
  });

  it("reads the key a command prints, as Claude Desktop keeps it out of the environment", async () => {
    const command = node("process.stdout.write('esk_from_command\\n')");
    expect(await loadConfig(["--url", GW, "--key-command", command], PATH_ONLY)).toEqual({
      ok: true,
      gatewayUrl: GW,
      token: "esk_from_command",
    });
  });

  it("takes the command from ERAGON_API_KEY_COMMAND too, and the flag wins over it", async () => {
    const fromEnv = await loadConfig(["--url", GW], {
      ...PATH_ONLY,
      ERAGON_API_KEY_COMMAND: node("process.stdout.write('esk_env_command')"),
    });
    expect(fromEnv).toEqual({ ok: true, gatewayUrl: GW, token: "esk_env_command" });
    const both = await loadConfig(["--url", GW, `--key-command=${node("process.stdout.write('esk_flag')")}`], {
      ...PATH_ONLY,
      ERAGON_API_KEY_COMMAND: node("process.exit(9)"),
    });
    expect(both).toEqual({ ok: true, gatewayUrl: GW, token: "esk_flag" });
  });

  it("uses a key already in the environment and never runs the command", async () => {
    dir = mkdtempSync(join(tmpdir(), "eragon-key-command-"));
    const marker = join(dir, "ran");
    const command = node(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.stdout.write('esk_other')`);
    const resolved = await loadConfig(["--key-command", command], {
      ...PATH_ONLY,
      ANTHROPIC_BASE_URL: GW,
      ANTHROPIC_AUTH_TOKEN: "esk_model",
    });
    expect(resolved).toEqual({ ok: true, gatewayUrl: GW, token: "esk_model" });
    expect(existsSync(marker)).toBe(false);
  });

  it("reports a URL problem before running any command", async () => {
    dir = mkdtempSync(join(tmpdir(), "eragon-key-command-"));
    const marker = join(dir, "ran");
    const command = node(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.exit(7)`);
    const missing = await loadConfig(["--key-command", command], PATH_ONLY);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("--url");
    const invalid = await loadConfig(["--url", "not-a-url", "--key-command", command], PATH_ONLY);
    expect(invalid).toEqual({ ok: false, error: "The Eragon Gateway URL is invalid." });
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses a command that fails, without repeating what it printed", async () => {
    const resolved = await loadConfig(
      ["--url", GW, "--key-command", node("process.stdout.write('esk_leaked'); process.exit(3)")],
      PATH_ONLY,
    );
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.error).toContain("exit 3");
      expect(resolved.error).not.toContain("esk_leaked");
    }
  });

  it("refuses a command that prints no key, or more than one word, without repeating it", async () => {
    for (const printed of ["", "esk_one esk_two"]) {
      const resolved = await loadConfig(
        ["--url", GW, "--key-command", node(`process.stdout.write(${JSON.stringify(printed)})`)],
        PATH_ONLY,
      );
      expect(resolved.ok).toBe(false);
      if (!resolved.ok) {
        expect(resolved.error).toContain("did not print one key");
        expect(resolved.error).not.toContain("esk_one");
      }
    }
  });

  it("refuses output past its limit rather than keep the first part as the key", async () => {
    const resolved = await loadConfig(
      ["--url", GW, "--key-command", node("process.stdout.write('a'.repeat(20000)); process.stdout.write(' esk_second')")],
      PATH_ONLY,
    );
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.error).toContain("did not print one key");
      expect(resolved.error).not.toContain("aaaa");
    }
  });

  it.skipIf(process.platform === "win32")("stops what the command started too, so nothing outlives the deadline", async () => {
    dir = mkdtempSync(join(tmpdir(), "eragon-key-command-"));
    const pidFile = join(dir, "pid");
    // Two commands, so the shell cannot exec the first: it stays as the parent of a waiting child.
    const command = `${node(`require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 20000)`)}; echo esk_late`;
    const resolved = await loadConfig(["--url", GW, "--key-command", command], PATH_ONLY, { keyCommandTimeoutMs: 1000 });
    expect(resolved.ok).toBe(false);
    const pid = Number(readFileSync(pidFile, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("stops a command that does not finish", async () => {
    const started = Date.now();
    const resolved = await loadConfig(["--url", GW, "--key-command", node("setTimeout(() => {}, 20000)")], PATH_ONLY, {
      keyCommandTimeoutMs: 300,
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error).toContain("did not finish");
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("prepareBridge: a key command never holds the bridge's start, and its failure leaves Memory working", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** The Memory answers of a Gateway stand-in, and the keys it was called with. */
  function memoryGateway() {
    const keys: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      keys.push(String((init?.headers as Record<string, string>).authorization));
      const status = String(input).endsWith("/v1/memory/search") ? 200 : 404;
      return new Response(JSON.stringify(status === 200 ? { memories: [] } : {}), { status });
    };
    return { keys, fetchImpl };
  }

  async function connected(key: Parameters<typeof createBridgeServer>[0]["key"], fetchImpl: typeof fetch) {
    const server = createBridgeServer({ gatewayUrl: GW, key, fetchImpl, connectors: { cacheFile: null } });
    const client = new Client({ name: "test", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    return client;
  }

  it("--key-command failure keeps Memory listed, and the next Memory call reads the key again", async () => {
    dir = mkdtempSync(join(tmpdir(), "eragon-key-command-"));
    const marker = join(dir, "unlocked");
    // Fails the first time (a locked keychain), prints the key after.
    const command = node(
      `const fs = require('node:fs'); if (fs.existsSync(${JSON.stringify(marker)})) process.stdout.write('esk_unlocked'); else { fs.writeFileSync(${JSON.stringify(marker)}, 'x'); process.exit(4); }`,
    );
    const logged: string[] = [];
    const prepared = prepareBridge(["--url", GW, "--key-command", command], PATH_ONLY, { log: (message) => logged.push(message) });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const failed = await prepared.key();
    expect(failed.ok).toBe(false);
    expect(logged.join("\n")).toContain("exit 4");

    const gateway = memoryGateway();
    const client = await connected(prepared.key, gateway.fetchImpl);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["memory_search", "memory_save", "memory_share"]);

    const result = await client.callTool({ name: "memory_search", arguments: { query: "deploy" } });
    expect(result.isError).not.toBe(true);
    expect(gateway.keys).toContain("Bearer esk_unlocked");
    await client.close();
  });

  it("a command that keeps failing answers each Memory call with why, and the bridge stays up", async () => {
    const prepared = prepareBridge(["--url", GW, "--key-command", node("process.stdout.write('esk_leaked'); process.exit(3)")], PATH_ONLY, {
      log: () => undefined,
    });
    if (!prepared.ok) throw new Error(prepared.error);
    const gateway = memoryGateway();
    const client = await connected(prepared.key, gateway.fetchImpl);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["memory_search", "memory_save", "memory_share"]);

    const result = await client.callTool({ name: "memory_search", arguments: { query: "deploy" } });
    expect(result.isError).toBe(true);
    const message = (result.content as { text: string }[])[0]?.text ?? "";
    expect(message).toContain("exit 3");
    expect(message).not.toContain("esk_leaked");
    expect(gateway.keys).toEqual([]);
    await client.close();
  });

  it("runs the command once for many callers, and not again after it printed a key", async () => {
    dir = mkdtempSync(join(tmpdir(), "eragon-key-command-"));
    const counter = join(dir, "runs");
    const command = node(
      `const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(counter)}, 'x'); process.stdout.write('esk_once')`,
    );
    const prepared = prepareBridge(["--url", GW, "--key-command", command], PATH_ONLY);
    if (!prepared.ok) throw new Error(prepared.error);
    const answers = await Promise.all([prepared.key(), prepared.key(), prepared.key()]);
    expect(answers.every((answer) => answer.ok && answer.token === "esk_once")).toBe(true);
    await prepared.key();
    expect(readFileSync(counter, "utf8")).toBe("x");
  });

  it("uses an exported key at once and never runs the command; still refuses with no key and no command", async () => {
    dir = mkdtempSync(join(tmpdir(), "eragon-key-command-"));
    const marker = join(dir, "ran");
    const command = node(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`);
    const prepared = prepareBridge(["--url", GW, "--key-command", command], { ...PATH_ONLY, ERAGON_API_KEY: "esk_env" });
    if (!prepared.ok) throw new Error(prepared.error);
    expect(await prepared.key()).toEqual({ ok: true, token: "esk_env" });
    // A key given outright needs no cache index by source.
    expect(prepared.keySource).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(existsSync(marker)).toBe(false);
    // A key command names the cache entry its last run read, so a restart lists Connections before it prints (ERA-5056 review).
    const viaCommand = prepareBridge(["--url", GW, "--key-command", command], PATH_ONLY);
    expect(viaCommand.ok && viaCommand.keySource).toBe(`command:${command}`);
    const refused = prepareBridge(["--url", GW], PATH_ONLY);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain("Set ERAGON_API_KEY");
    expect(prepareBridge(["--url", "not-a-url", "--key-command", command], PATH_ONLY)).toEqual({
      ok: false,
      error: "The Eragon Gateway URL is invalid.",
    });
  });
});

describe("the bridge as an MCP client starts it, with no key in its environment", () => {
  /** Starts the real command, says hello over stdio, and returns its first answer or its exit and stderr. */
  function start(args: string[]): Promise<{ answer?: unknown; code?: number | null; stderr: string }> {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../bin/eragon-context-mcp.mjs", import.meta.url)), ...args], {
      env: PATH_ONLY,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve({ stderr });
      }, 10_000);
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        // A chunk is not a message: parse only a line the bridge has finished.
        const end = stdout.indexOf("\n");
        if (end === -1) return;
        const line = stdout.slice(0, end);
        clearTimeout(timer);
        child.kill();
        resolve({ answer: JSON.parse(line), stderr });
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve({ code, stderr });
      });
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "desktop-stand-in", version: "0" } },
        })}\n`,
      );
    });
  }

  /** Nothing listens here, so the bridge's background probe never leaves this machine. */
  const LOCAL_GW = "http://127.0.0.1:9/gw";

  it("answers initialize when a key command supplies the key", async () => {
    const started = await start(["--url", LOCAL_GW, "--key-command", node("process.stdout.write('esk_from_keychain')")]);
    expect(started.stderr).not.toContain("Set ERAGON_API_KEY");
    expect(started.answer).toMatchObject({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: expect.any(String) } } });
    expect(JSON.stringify(started.answer)).not.toContain("esk_from_keychain");
  });

  it("answers initialize at once while a slow key command is still running", async () => {
    const begun = Date.now();
    const started = await start(["--url", LOCAL_GW, "--key-command", node("setTimeout(() => process.stdout.write('esk_slow'), 3000)")]);
    expect(started.answer).toMatchObject({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: expect.any(String) } } });
    expect(Date.now() - begun).toBeLessThan(2_500);
  });

  it("exits with the same refusal as before when there is no key command", async () => {
    const started = await start(["--url", LOCAL_GW]);
    expect(started.code).toBe(1);
    expect(started.stderr).toContain("Set ERAGON_API_KEY");
  });
});
