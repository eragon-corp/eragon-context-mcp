import { execFile, execFileSync, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  codexConfig,
  install,
  opencodeConfig,
  piMcpConfig,
  piModelsConfig,
  recallHandler,
  windowsArgument,
} from "../src/install.js";

const GW = "https://acme.s.eragon.ai/gw";
const BIN = fileURLToPath(new URL("../bin/eragon-context-mcp.mjs", import.meta.url));

describe("codexConfig", () => {
  it("adds the bridge with the key forwarded by name, never by value", () => {
    const next = codexConfig('model = "x"\n', GW);
    expect(next).toContain('model = "x"');
    expect(next).toContain("[mcp_servers.eragon]");
    expect(next).toContain('command = "eragon-context-mcp"');
    expect(next).toContain(`args = ["--url", "${GW}"]`);
    // Codex forwards only the variables an entry names; without this the bridge has no key.
    expect(next).toContain('env_vars = ["ERAGON_API_KEY"]');
  });

  it("replaces an earlier eragon entry and its subtables, and keeps every other table", () => {
    const current = [
      "[profiles.other]",
      'model = "y"',
      "",
      "[mcp_servers.eragon]",
      'command = "eragon"',
      'args = ["mcp"]',
      "",
      "[mcp_servers.eragon.env]",
      'ERAGON_API_KEY = "esk_old"',
      "",
      "[mcp_servers.github]",
      'command = "gh-mcp"',
      "",
    ].join("\n");
    const next = codexConfig(current, GW);
    expect(next.match(/^\[mcp_servers\.eragon\]$/gm)).toHaveLength(1);
    expect(next).not.toContain("[mcp_servers.eragon.env]");
    expect(next).not.toContain("esk_old");
    expect(next).toContain('[mcp_servers.github]\ncommand = "gh-mcp"');
    expect(next).toContain('[profiles.other]\nmodel = "y"');
  });

  it("gives the same file when run twice", () => {
    const once = codexConfig("", GW);
    expect(codexConfig(once, GW)).toBe(once);
  });

  it("refuses an eragon entry written as an inline table rather than guess how to remove it", () => {
    expect(() => codexConfig('[mcp_servers]\neragon = { command = "x" }\n', GW)).toThrow(/mcp_servers\.eragon/);
    expect(() => codexConfig('mcp_servers.eragon.command = "x"\n', GW)).toThrow(/mcp_servers\.eragon/);
  });
});

describe("piMcpConfig", () => {
  it("declares the bridge's two tools directly and reads the key from the environment", () => {
    const next = JSON.parse(piMcpConfig('{"mcpServers":{"fs":{"command":"fs-mcp"}}}', GW));
    expect(next.mcpServers.fs).toEqual({ command: "fs-mcp" });
    expect(next.mcpServers.eragon).toEqual({
      command: "eragon-context-mcp",
      args: ["--url", GW],
      env: { ERAGON_API_KEY: "${ERAGON_API_KEY}" },
      // Pi's default exposure hides MCP tools behind codemode search; two small
      // tools are the case Pi's docs recommend declaring directly.
      exposure: "direct",
    });
  });

  it("starts a file that does not exist", () => {
    expect(JSON.parse(piMcpConfig(undefined, GW)).mcpServers.eragon.command).toBe("eragon-context-mcp");
  });
});

describe("piModelsConfig", () => {
  it("adds an Eragon provider beside the others and keeps its other models", () => {
    const current = JSON.stringify({ providers: { ollama: { baseUrl: "http://localhost:11434/v1" }, eragon: { models: [{ id: "old" }] } } });
    const next = JSON.parse(piModelsConfig(current, GW, "claude-sonnet-5-5"));
    expect(next.providers.ollama).toEqual({ baseUrl: "http://localhost:11434/v1" });
    expect(next.providers.eragon).toMatchObject({ baseUrl: GW, api: "anthropic-messages", apiKey: "$ERAGON_API_KEY" });
    expect(next.providers.eragon.models.map((m: { id: string }) => m.id)).toEqual(["old", "claude-sonnet-5-5"]);
  });
});

describe("opencodeConfig", () => {
  it("adds the bridge and an Eragon provider without touching the user's own providers", () => {
    const current = JSON.stringify({ provider: { anthropic: { options: { apiKey: "{env:MY_KEY}" } } }, theme: "dark" });
    const next = JSON.parse(opencodeConfig(current, GW, "claude-sonnet-5-5"));
    expect(next.theme).toBe("dark");
    expect(next.provider.anthropic).toEqual({ options: { apiKey: "{env:MY_KEY}" } });
    expect(next.provider.eragon).toMatchObject({
      npm: "@ai-sdk/anthropic",
      options: { baseURL: `${GW}/v1`, apiKey: "{env:ERAGON_API_KEY}" },
      models: { "claude-sonnet-5-5": {} },
    });
    expect(next.mcp.eragon).toEqual({
      type: "local",
      command: ["eragon-context-mcp", "--url", GW],
      environment: { ERAGON_API_KEY: "{env:ERAGON_API_KEY}" },
      enabled: true,
    });
  });

  it("adds only the bridge when no model is named", () => {
    const next = JSON.parse(opencodeConfig(undefined, GW, undefined));
    expect(next.provider).toBeUndefined();
    expect(next.mcp.eragon.type).toBe("local");
  });
});

describe("install", () => {
  let home: string;
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  /** A temp HOME with stand-ins for each agent's CLI on PATH; `claude` logs its calls. */
  function sandbox(agents: string[]) {
    home = mkdtempSync(join(tmpdir(), "eragon-install-"));
    const bin = join(home, "bin");
    mkdirSync(bin);
    for (const agent of agents) {
      const script = agent === "claude"
        ? `#!/bin/sh\nprintf '%s\\n' "$*" >> "${home}/claude.log"\n`
        : "#!/bin/sh\nexit 0\n";
      writeFileSync(join(bin, agent), script);
      chmodSync(join(bin, agent), 0o755);
    }
    return { HOME: home, PATH: `${bin}:/usr/bin:/bin` };
  }

  it("configures every agent it finds, and writes no key anywhere", async () => {
    const env = { ...sandbox(["claude", "codex", "pi", "opencode"]), ERAGON_API_KEY: "esk_secret", ANTHROPIC_AUTH_TOKEN: "esk_secret" };
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "config.toml"), '[profiles.other]\nmodel = "y"\n');

    const report = await install({ agents: "detect", gatewayUrl: GW, model: "claude-sonnet-5-5", env, dryRun: false });

    expect(report.map((r) => r.agent)).toEqual(["claude-code", "codex", "pi", "opencode"]);
    expect(readFileSync(join(home, "claude.log"), "utf8").trim().split("\n")).toEqual([
      "mcp remove eragon --scope user",
      "mcp add --scope user eragon -- eragon-context-mcp",
    ]);
    const files = [
      join(home, ".codex", "config.toml"),
      join(home, ".pi", "agent", "mcp.json"),
      join(home, ".pi", "agent", "models.json"),
      join(home, ".config", "opencode", "opencode.json"),
    ];
    for (const file of files) expect(readFileSync(file, "utf8")).not.toContain("esk_secret");
    // The file it changed is kept as it was.
    expect(readFileSync(join(home, ".codex", "config.toml.eragon-backup"), "utf8")).toBe('[profiles.other]\nmodel = "y"\n');
  });

  it("skips agents that are not installed", async () => {
    const env = sandbox(["codex"]);
    const report = await install({ agents: "detect", gatewayUrl: GW, model: undefined, env, dryRun: false });
    expect(report.map((r) => r.agent)).toEqual(["codex"]);
  });

  it("changes nothing on a dry run", async () => {
    const env = sandbox(["claude", "pi"]);
    const report = await install({ agents: ["pi", "claude-code"], gatewayUrl: GW, model: "claude-sonnet-5-5", env, dryRun: true });
    expect(report.map((r) => r.agent)).toEqual(["claude-code", "pi"]);
    expect(() => readFileSync(join(home, ".pi", "agent", "mcp.json"))).toThrow();
    expect(() => readFileSync(join(home, "claude.log"))).toThrow();
  });

  it("names a missing key in its report, so a working config is not mistaken for a working setup", async () => {
    const env = sandbox(["codex"]);
    const [codex] = await install({ agents: ["codex"], gatewayUrl: GW, model: undefined, env, dryRun: true });
    expect(codex?.notes.join(" ")).toContain("ERAGON_API_KEY");
  });

  it("runs as a command", () => {
    const env = sandbox(["pi"]);
    const out = execFileSync(process.execPath, [BIN, "install", "--agent", "pi", "--url", GW, "--model", "claude-sonnet-5-5"], {
      encoding: "utf8",
      env: { ...env, PATH: `${env.PATH}:${process.env.PATH}` },
    });
    expect(out).toContain("pi");
    expect(JSON.parse(readFileSync(join(home, ".pi", "agent", "mcp.json"), "utf8")).mcpServers.eragon.exposure).toBe("direct");
  });

  it("merges one hook per client and restores byte-identical files on uninstall", () => {
    const env = {
      ...sandbox(["claude", "codex"]),
      CLAUDE_CONFIG_DIR: join(home, "claude settings"),
      CODEX_HOME: join(home, "codex settings"),
      ANTHROPIC_AUTH_TOKEN: "fake-key",
      ERAGON_API_KEY: "fake-key",
    };
    const userPrompt = { hooks: [{ type: "command", command: "/user/script recall-hook" }] };
    const stop = [{ hooks: [{ type: "command", command: "/user/stop" }] }];
    const claudeFile = join(env.CLAUDE_CONFIG_DIR, "settings.json");
    const codexFile = join(env.CODEX_HOME, "hooks.json");
    const originals = [
      { file: claudeFile, original: `{ "hooks": { "Stop": ${JSON.stringify(stop)}, "UserPromptSubmit": [${JSON.stringify(userPrompt)}] } }\n\n` },
      { file: codexFile, original: JSON.stringify({ description: "User hooks", hooks: { UserPromptSubmit: [userPrompt] } }, null, "\t") },
    ];
    mkdirSync(env.CLAUDE_CONFIG_DIR);
    mkdirSync(env.CODEX_HOME);
    for (const { file, original } of originals) writeFileSync(file, original, { mode: 0o600 });

    const run = (...args: string[]) => execFileSync(process.execPath, [BIN, ...args], { env });
    const installArgs = ["install", "--agent", "claude", "--agent", "codex", "--url"];
    run(...installArgs, "https://previous.s.eragon.ai/gw");
    run(...installArgs, GW);

    for (const { file, original } of originals) {
      const raw = readFileSync(file, "utf8");
      const parsed = JSON.parse(raw);
      expect(parsed.hooks.UserPromptSubmit).toHaveLength(2);
      expect(parsed.hooks.UserPromptSubmit[0]).toEqual(userPrompt);
      const handler = parsed.hooks.UserPromptSubmit[1].hooks[0];
      expect(handler).toMatchObject({ type: "command", timeout: 3 });
      expect(handler.command).toContain(BIN);
      expect(handler.command).toContain(" recall-hook");
      if (file === codexFile) {
        expect(handler.command).toContain(` --url ${GW}`);
        expect(handler.additionalContextLimit).toBe(0);
        expect(parsed.description).toBe("User hooks");
      } else {
        expect(handler.command).toMatch(/ recall-hook$/);
        expect(parsed.hooks.Stop).toEqual(stop);
      }
      expect(raw).not.toContain("fake-key");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readFileSync(`${file}.eragon-backup`, "utf8")).toBe(original);
    }

    run("uninstall");
    run("uninstall");
    for (const { file, original } of originals) expect(readFileSync(file, "utf8")).toBe(original);
    expect(readFileSync(join(env.CODEX_HOME, "config.toml"), "utf8")).toContain("[mcp_servers.eragon]");
  });

  it("preserves user handlers edited after install and removes a file created only for recall", () => {
    const env = sandbox(["claude", "codex"]);
    const run = (...args: string[]) => execFileSync(process.execPath, [BIN, ...args], { env });
    run("install", "--agent", "claude-code", "--agent", "codex", "--url", GW);
    const claudeFile = join(home, ".claude", "settings.json");
    const codexFile = join(home, ".codex", "hooks.json");
    const config = JSON.parse(readFileSync(codexFile, "utf8"));
    const userHandler = { type: "command", command: "user-prompt-hook" };
    config.hooks.UserPromptSubmit[0].hooks.push(userHandler);
    config.description = "Added after install";
    writeFileSync(codexFile, JSON.stringify(config));

    run("uninstall", "--agent", "claude");
    expect(() => readFileSync(claudeFile)).toThrow(/ENOENT/);
    expect(JSON.parse(readFileSync(codexFile, "utf8"))).toEqual(config);
    run("uninstall", "--agent", "codex");
    expect(JSON.parse(readFileSync(codexFile, "utf8"))).toEqual({
      description: "Added after install",
      hooks: { UserPromptSubmit: [{ hooks: [userHandler] }] },
    });
  });

  /** A stub Gateway that answers every recall with the server's reply shape and counts the calls. */
  async function recallGateway(): Promise<{ url: string; calls: string[]; server: Server }> {
    const calls: string[] = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request.setEncoding("utf8")) body += chunk;
      calls.push(`${request.method} ${request.url} ${body}`);
      response.end(JSON.stringify({ text: "<eragon_memory_context>recalled</eragon_memory_context>", count: 1, status: "ok" }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected a TCP address");
    return { url: `http://127.0.0.1:${address.port}/gw`, calls, server };
  }

  const EXPECTED_HOOK_OUTPUT = {
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "<eragon_memory_context>recalled</eragon_memory_context>" },
  };

  it("names the bridge on PATH when it is this binary, and runs that installed command against a Gateway", async () => {
    const env = { ...sandbox(["claude", "codex"]), ERAGON_API_KEY: "fake-key" };
    // `npm install -g` links the command to the package's entry point.
    symlinkSync(BIN, join(home, "bin", "eragon-context-mcp"));
    const { url, calls, server } = await recallGateway();
    try {
      const out = spawnSync(process.execPath, [BIN, "install", "--agent", "claude", "--agent", "codex", "--url", url], { env, encoding: "utf8" });
      expect(out.status).toBe(0);
      const claude = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")).hooks.UserPromptSubmit[0].hooks[0];
      const codex = JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8")).hooks.UserPromptSubmit[0].hooks[0];
      expect(claude.command).toBe("eragon-context-mcp recall-hook");
      expect(codex.command).toBe(`eragon-context-mcp recall-hook --url ${url}`);

      // Run each entry the way the client does: its command through a shell,
      // with node and the bridge found on PATH.
      const hookEnv = { PATH: `${join(home, "bin")}${delimiter}${dirname(process.execPath)}${delimiter}/usr/bin:/bin`, ERAGON_API_KEY: "fake-key", ERAGON_GATEWAY_URL: url };
      for (const handler of [claude, codex]) {
        // Asynchronous, so this process can answer as the Gateway meanwhile.
        const ran = await new Promise<{ status: number; stdout: string }>((resolve) => {
          const child = execFile("/bin/sh", ["-c", handler.command], { env: hookEnv, encoding: "utf8" }, (error, stdout) => {
            resolve({ status: error === null ? 0 : Number(error.code), stdout });
          });
          child.stdin?.end(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "deploy day?" }));
        });
        expect(ran.status).toBe(0);
        expect(JSON.parse(ran.stdout)).toEqual(EXPECTED_HOOK_OUTPUT);
      }
      expect(calls).toEqual(Array(2).fill('POST /gw/v1/memory/recall {"query":"deploy day?"}'));
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("uses the absolute entry point when the eragon-context-mcp on PATH is another copy", () => {
    const env = sandbox(["claude"]);
    writeFileSync(join(home, "bin", "eragon-context-mcp"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(home, "bin", "eragon-context-mcp"), 0o755);
    execFileSync(process.execPath, [BIN, "install", "--agent", "claude", "--url", GW], { env });
    const handler = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")).hooks.UserPromptSubmit[0].hooks[0];
    expect(handler.command).toBe(`${BIN} recall-hook`);
  });

  it("keeps symlinked settings files as symlinks through install and uninstall", () => {
    const env = sandbox(["claude", "codex"]);
    const dotfiles = join(home, "dotfiles");
    mkdirSync(dotfiles);
    mkdirSync(join(home, ".claude"));
    mkdirSync(join(home, ".codex"));
    const links = [
      { link: join(home, ".claude", "settings.json"), target: join(dotfiles, "claude-settings.json"), original: '{"theme":"dark"}\n' },
      { link: join(home, ".codex", "hooks.json"), target: join(dotfiles, "codex-hooks.json"), original: '{"hooks":{"Stop":[]}}' },
      { link: join(home, ".codex", "config.toml"), target: join(dotfiles, "codex-config.toml"), original: 'model = "x"\n' },
    ];
    for (const { link, target, original } of links) {
      writeFileSync(target, original, { mode: 0o644 });
      // Relative, as a dotfiles manager writes them.
      symlinkSync(join("..", "dotfiles", target.slice(dotfiles.length + 1)), link);
    }
    const run = (...args: string[]) => execFileSync(process.execPath, [BIN, ...args], { env });
    run("install", "--agent", "claude", "--agent", "codex", "--url", GW);
    for (const { link, target } of links) {
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(target, "utf8")).toContain(link.endsWith(".toml") ? "[mcp_servers.eragon]" : "recall-hook");
      expect(statSync(target).mode & 0o777).toBe(0o644);
    }
    run("uninstall");
    for (const { link, target, original } of links) {
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(join("..", "dotfiles", target.slice(dotfiles.length + 1)));
      if (!link.endsWith(".toml")) expect(readFileSync(target, "utf8")).toBe(original);
    }
  });

  it("names a malformed settings file, skips that client, and still configures the other", () => {
    const env = sandbox(["claude", "codex"]);
    const claudeFile = join(home, ".claude", "settings.json");
    mkdirSync(join(home, ".claude"));
    writeFileSync(claudeFile, '{ "hooks": { ,');
    const installed = spawnSync(process.execPath, [BIN, "install", "--agent", "claude", "--agent", "codex", "--url", GW], { env, encoding: "utf8" });
    expect(installed.status).toBe(1);
    expect(installed.stderr).toContain(`claude-code: not configured. ${claudeFile} is not valid JSON`);
    expect(installed.stderr).not.toMatch(/^\s+at /m);
    expect(installed.stdout).toContain("codex: configured");
    expect(readFileSync(claudeFile, "utf8")).toBe('{ "hooks": { ,');
    // Nothing for Claude Code ran: its MCP registration waits for a readable file.
    expect(() => readFileSync(join(home, "claude.log"))).toThrow(/ENOENT/);
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain("[mcp_servers.eragon]");
    expect(readFileSync(join(home, ".codex", "hooks.json"), "utf8")).toContain("recall-hook");

    const removed = spawnSync(process.execPath, [BIN, "uninstall"], { env, encoding: "utf8" });
    expect(removed.status).toBe(1);
    expect(removed.stderr).toContain(`${claudeFile} is not valid JSON`);
    expect(removed.stdout).toContain(`Removed Eragon recall hook from ${join(home, ".codex", "hooks.json")}`);
    expect(() => readFileSync(join(home, ".codex", "hooks.json"))).toThrow(/ENOENT/);
  });
});

describe("recallHandler on Windows", () => {
  const WIN_BIN = "C:\\Users\\Ada Lovelace\\AppData\\Roaming\\npm\\node_modules\\eragon-context-mcp\\bin\\eragon-context-mcp.mjs";
  const SLASHED = WIN_BIN.replaceAll("\\", "/");

  it("gives Claude Code its exec form, so no shell parses the command", () => {
    expect(recallHandler("claude-code", GW, { platform: "win32", byName: true, bin: WIN_BIN })).toMatchObject({
      command: "node",
      args: [SLASHED, "recall-hook"],
      timeout: 3,
    });
  });

  it("gives Codex one commandWindows line that cmd, PowerShell and Git Bash read alike", () => {
    const handler = recallHandler("codex", GW, { platform: "win32", byName: false, bin: WIN_BIN });
    expect(handler.commandWindows).toBe(`node "${SLASHED}" recall-hook --url ${GW}`);
    // cmd /C strips only the outer quotes Codex adds; nothing here is special to cmd.
    expect(handler.commandWindows).not.toMatch(/[&|<>^%]/);
  });

  it("refuses a value that one of those shells would expand inside double quotes", () => {
    for (const value of ["C:/100%/x.mjs", "C:/$HOME/x.mjs", "C:/a`b/x.mjs", 'C:/"/x.mjs']) {
      expect(() => windowsArgument(value)).toThrow(/every Windows shell/);
    }
    expect(windowsArgument("C:/Program Files/x.mjs")).toBe('"C:/Program Files/x.mjs"');
  });

  // The commandWindows line, run for real by the two POSIX-available shells
  // Codex may use on Windows (Git Bash's sh and PowerShell), against a Gateway.
  // cmd is not available here; its reading is covered by the line's shape above.
  const pwsh = (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, "pwsh")).find((file) => {
    try {
      return statSync(file).isFile();
    } catch {
      return false;
    }
  });

  async function runWindowsLine(argv: readonly string[]) {
    const dir = mkdtempSync(join(tmpdir(), "eragon win path "));
    // The same file reached through a path with a space, like a Windows profile.
    const spaced = join(dir, "bin", "eragon-context-mcp.mjs");
    mkdirSync(dirname(spaced));
    symlinkSync(BIN, spaced);
    const server = createServer((_request, response) => {
      response.end(JSON.stringify({ text: "<eragon_memory_context>recalled</eragon_memory_context>", count: 1, status: "ok" }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Expected a TCP address");
      const handler = recallHandler("codex", `http://127.0.0.1:${address.port}/gw`, { platform: "win32", byName: false, bin: spaced });
      expect(handler.commandWindows).toContain(`"${spaced}"`);
      const [program, ...args] = argv;
      const ran = await new Promise<{ status: number | null; stdout: string }>((resolve) => {
        const child = execFile(program, [...args, String(handler.commandWindows)], {
          env: { PATH: `${dirname(process.execPath)}${delimiter}/usr/bin:/bin`, HOME: dir, ERAGON_API_KEY: "fake-key" },
          encoding: "utf8",
        }, (error, stdout) => resolve({ status: error === null ? 0 : Number(error.code), stdout }));
        child.stdin?.end(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "deploy day?" }));
      });
      expect(ran.status).toBe(0);
      expect(JSON.parse(ran.stdout)).toEqual({
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "<eragon_memory_context>recalled</eragon_memory_context>" },
      });
    } finally {
      server.closeAllConnections();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("runs the Codex Windows line through sh, as Git Bash would", () => runWindowsLine(["/bin/sh", "-c"]), 20000);

  // GitHub's ubuntu runners ship pwsh; elsewhere this is reported as skipped.
  it.skipIf(pwsh === undefined)(
    "runs the Codex Windows line through PowerShell",
    () => runWindowsLine([pwsh ?? "pwsh", "-NoProfile", "-NonInteractive", "-Command"]),
    20000,
  );
});
