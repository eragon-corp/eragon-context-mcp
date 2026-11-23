import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig, resolveConfig } from "../src/cli.js";

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

  it("answers initialize when a key command supplies the key", async () => {
    const started = await start(["--url", GW, "--key-command", node("process.stdout.write('esk_from_keychain')")]);
    expect(started.stderr).not.toContain("Set ERAGON_API_KEY");
    expect(started.answer).toMatchObject({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: expect.any(String) } } });
    expect(JSON.stringify(started.answer)).not.toContain("esk_from_keychain");
  });

  it("exits with the same refusal as before when there is no key command", async () => {
    const started = await start(["--url", GW]);
    expect(started.code).toBe(1);
    expect(started.stderr).toContain("Set ERAGON_API_KEY");
  });
});
