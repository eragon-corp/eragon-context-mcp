import { spawn } from "node:child_process";

import { AGENTS, install, type Agent } from "./install.js";
import { runMemoryMcp } from "./server.js";

const USAGE = `eragon-context-mcp — Eragon Memory for coding agents

Usage:
  eragon-context-mcp [--url https://<your-eragon>/gw] [--key-command COMMAND]
  eragon-context-mcp install [--agent claude-code|codex|pi|opencode]... [--url URL] [--model ID] [--key-command COMMAND] [--dry-run]

install registers this bridge with each coding agent on PATH (or each --agent
named), and for pi and opencode adds an Eragon model provider when --model is
given. It never writes the Gateway key: each agent reads it from its environment,
or the bridge runs --key-command to read it where the agent keeps it.

Environment:
  ERAGON_GATEWAY_URL or ANTHROPIC_BASE_URL
  ERAGON_API_KEY     or ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN
  ERAGON_API_KEY_COMMAND, used like --key-command only when none of the keys is set

The server exposes exactly three stdio MCP tools: memory_search, memory_save and memory_share.`;

type ConfigEnvironment = Partial<
  Record<
    | "ERAGON_GATEWAY_URL"
    | "ANTHROPIC_BASE_URL"
    | "ERAGON_API_KEY"
    | "ANTHROPIC_API_KEY"
    | "ANTHROPIC_AUTH_TOKEN",
    string
  >
>;

export type ResolvedConfig =
  | { ok: true; gatewayUrl: string; token: string }
  | { ok: false; error: string };

const NO_KEY =
  "Set ERAGON_API_KEY, ANTHROPIC_API_KEY, or ANTHROPIC_AUTH_TOKEN to a personal Gateway key, or pass --key-command.";
const KEY_VARIABLES = ["ERAGON_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;
/** Longer than a keychain read takes, shorter than a client waits for an MCP server to start. */
export const KEY_COMMAND_TIMEOUT_MS = 15_000;

function explicitUrl(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--url") return argv[index + 1];
    if (argument?.startsWith("--url=")) return argument.slice("--url=".length);
  }
  return undefined;
}

export function resolveConfig(
  argv: string[],
  environment: ConfigEnvironment = process.env,
): ResolvedConfig {
  const gatewayUrl =
    explicitUrl(argv) ?? environment.ERAGON_GATEWAY_URL ?? environment.ANTHROPIC_BASE_URL;
  // Claude Code sends ANTHROPIC_API_KEY when both are set.
  const modelKey = environment.ANTHROPIC_API_KEY ?? environment.ANTHROPIC_AUTH_TOKEN;
  // A Memory key that differs from the key model calls go out under files the
  // agent's saves under another person or workspace, with nothing to show it:
  // a stale ERAGON_API_KEY left in a shell profile after the model key was
  // replaced did exactly that. Only a gateway base URL makes the two comparable.
  if (
    environment.ANTHROPIC_BASE_URL !== undefined &&
    environment.ERAGON_API_KEY !== undefined &&
    modelKey !== undefined &&
    environment.ERAGON_API_KEY !== modelKey
  ) {
    return {
      ok: false,
      error:
        "ERAGON_API_KEY is not the key your model calls use, so Memory would be saved under a different key. Unset ERAGON_API_KEY, or set it to the same Gateway key.",
    };
  }
  const token = environment.ERAGON_API_KEY ?? modelKey;
  if (gatewayUrl === undefined || gatewayUrl.trim() === "") {
    return {
      ok: false,
      error: "Pass --url https://<your-eragon>/gw or set ERAGON_GATEWAY_URL.",
    };
  }
  if (token === undefined || token.trim() === "") return { ok: false, error: NO_KEY };
  let parsed: URL;
  try {
    parsed = new URL(gatewayUrl);
  } catch {
    return { ok: false, error: "The Eragon Gateway URL is invalid." };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, error: "The Eragon Gateway URL must use HTTPS or HTTP." };
  }
  return { ok: true, gatewayUrl: gatewayUrl.replace(/\/+$/, ""), token };
}

/**
 * The configuration, with the key from a command when the environment holds
 * none (ERA-5023). A client that keeps its key out of the environment it
 * gives MCP servers (Claude Desktop's third-party inference config, Claude
 * Code's `apiKeyHelper`, Codex without `env_vars`) can still start the bridge:
 * the command reads the key where that client keeps it, as `apiKeyHelper`
 * does, so no configuration ever holds the key itself. A key already in the
 * environment wins and the command never runs, so the different-key check
 * above still guards every exported key.
 */
export async function loadConfig(
  argv: string[],
  environment: NodeJS.ProcessEnv = process.env,
  options: { keyCommandTimeoutMs?: number } = {},
): Promise<ResolvedConfig> {
  // An empty variable is no key; left in, it would trip the different-key check.
  const present: NodeJS.ProcessEnv = { ...environment };
  for (const name of KEY_VARIABLES) if (present[name]?.trim() === "") delete present[name];
  const resolved = resolveConfig(argv, present);
  const command = values(argv, "--key-command").at(-1) ?? present.ERAGON_API_KEY_COMMAND;
  // Only a missing key reaches the command: a URL problem is reported without running anything.
  if (resolved.ok || resolved.error !== NO_KEY || command === undefined || command.trim() === "") return resolved;
  const read = await keyFromCommand(command, present, options.keyCommandTimeoutMs ?? KEY_COMMAND_TIMEOUT_MS);
  if (!read.ok) return read;
  return resolveConfig(argv, { ...present, ERAGON_API_KEY: read.key });
}

/**
 * Runs a key command through the shell, as Claude Code runs `apiKeyHelper`,
 * and takes the one word it prints. What it printed never reaches an error:
 * a failing command may still have printed a key. Its stdout is piped, never
 * inherited, because the bridge's own stdout is the MCP channel.
 */
function keyFromCommand(
  command: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ ok: true; key: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let printed = "";
    let settled = false;
    const finish = (result: { ok: true; key: string } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(command, { shell: true, env: environment, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, error: `The key command did not finish within ${timeoutMs / 1000} s.` });
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (printed.length < 16_384) printed += chunk;
    });
    child.on("error", () => finish({ ok: false, error: "The key command could not be started." }));
    child.on("close", (code, signal) => {
      if (code !== 0) {
        finish({ ok: false, error: `The key command failed (${code === null ? `signal ${signal}` : `exit ${code}`}).` });
        return;
      }
      const key = printed.trim();
      if (key === "" || /\s/.test(key)) {
        finish({ ok: false, error: "The key command did not print one key." });
        return;
      }
      finish({ ok: true, key });
    });
  });
}

function values(argv: string[], flag: string): string[] {
  const found: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === flag && argv[index + 1] !== undefined) found.push(argv[index + 1] ?? "");
    else if (argument?.startsWith(`${flag}=`)) found.push(argument.slice(flag.length + 1));
  }
  return found;
}

const isAgent = (value: string): value is Agent => (AGENTS as readonly string[]).includes(value);

async function runInstall(argv: string[], environment: NodeJS.ProcessEnv): Promise<number> {
  const named = values(argv, "--agent");
  const unknown = named.filter((agent) => !isAgent(agent));
  if (unknown.length > 0) {
    console.error(`Unknown agent ${unknown.join(", ")}. Use one of: ${AGENTS.join(", ")}.`);
    return 1;
  }
  const gatewayUrl = (explicitUrl(argv) ?? environment.ERAGON_GATEWAY_URL ?? environment.ANTHROPIC_BASE_URL)?.replace(/\/+$/, "");
  if (gatewayUrl === undefined || gatewayUrl === "") {
    console.error("Pass --url https://<your-eragon>/gw.");
    return 1;
  }
  const dryRun = argv.includes("--dry-run");
  const keyCommand = values(argv, "--key-command").at(-1);
  const reports = await install({
    agents: named.length === 0 ? "detect" : named.filter(isAgent),
    gatewayUrl,
    model: values(argv, "--model")[0],
    env: environment,
    dryRun,
    ...(keyCommand === undefined || keyCommand.trim() === "" ? {} : { keyCommand }),
  });
  if (reports.length === 0) {
    console.log(`No coding agent found on PATH (looked for ${AGENTS.join(", ")}). Name one with --agent.`);
    return 1;
  }
  for (const report of reports) {
    console.log(`${report.agent}: ${dryRun ? "would configure" : "configured"}`);
    for (const file of report.files) console.log(`  wrote ${file}`);
    for (const command of report.commands) console.log(`  ran ${command}`);
    for (const note of report.notes) console.log(`  next: ${note}`);
  }
  console.log("Start a new agent session to load the Eragon Memory tools.");
  return 0;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  if (argv[0] === "install") return runInstall(argv.slice(1), process.env);
  const config = await loadConfig(argv);
  if (!config.ok) {
    console.error(config.error);
    return 1;
  }
  await runMemoryMcp(config);
  return 0;
}
