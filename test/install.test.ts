import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { codexConfig, install, opencodeConfig, piMcpConfig, piModelsConfig } from "../src/install.js";

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
});
