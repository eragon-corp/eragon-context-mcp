import { AGENTS, install, uninstallRecallHooks, type Agent } from "./install.js";
import { recallTimeLeft, runRecallHook } from "./recall-hook.js";

const USAGE = `eragon-context-mcp — Eragon Memory for coding agents

Usage:
  eragon-context-mcp [--url https://<your-eragon>/gw]
  eragon-context-mcp install [--agent claude|claude-code|codex|pi|opencode]... [--url URL] [--model ID] [--dry-run]
  eragon-context-mcp uninstall [--agent claude|claude-code|codex]... [--dry-run]
  eragon-context-mcp recall-hook [--url URL]

install registers this bridge with each coding agent on PATH (or each --agent
named). It installs memory recall hooks for Claude Code and Codex, and adds an
Eragon model provider for pi and opencode when --model is given. Each agent reads
the Gateway key from its environment.
uninstall removes the managed recall hooks. With no --agent it checks both clients.

Environment:
  ERAGON_GATEWAY_URL or ANTHROPIC_BASE_URL
  ERAGON_API_KEY     or ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN

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
  if (token === undefined || token.trim() === "") {
    return {
      ok: false,
      error: "Set ERAGON_API_KEY, ANTHROPIC_API_KEY, or ANTHROPIC_AUTH_TOKEN to a personal Gateway key.",
    };
  }
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

function namedAgents(argv: string[]): string[] {
  return values(argv, "--agent").map((agent) => agent === "claude" ? "claude-code" : agent);
}

async function runInstall(argv: string[], environment: NodeJS.ProcessEnv): Promise<number> {
  const named = namedAgents(argv);
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
  const reports = await install({
    agents: named.length === 0 ? "detect" : named.filter(isAgent),
    gatewayUrl,
    model: values(argv, "--model")[0],
    env: environment,
    dryRun,
  });
  if (reports.length === 0) {
    console.log(`No coding agent found on PATH (looked for ${AGENTS.join(", ")}). Name one with --agent.`);
    return 1;
  }
  for (const report of reports) {
    if (report.error !== undefined) {
      console.error(`${report.agent}: not configured. ${report.error}`);
      continue;
    }
    console.log(`${report.agent}: ${dryRun ? "would configure" : "configured"}`);
    for (const file of report.files) console.log(`  wrote ${file}`);
    for (const command of report.commands) console.log(`  ran ${command}`);
    for (const note of report.notes) console.log(`  next: ${note}`);
  }
  if (reports.some((report) => report.error === undefined)) {
    console.log("Start a new agent session to load the Eragon Memory tools.");
  }
  return reports.some((report) => report.error !== undefined) ? 1 : 0;
}

async function runUninstall(argv: string[], environment: NodeJS.ProcessEnv): Promise<number> {
  const agents = namedAgents(argv);
  const supported = (agent: string): agent is Agent => agent === "claude-code" || agent === "codex";
  if (!agents.every(supported)) {
    console.error("Choose --agent claude (or claude-code) or --agent codex to uninstall a recall hook.");
    return 1;
  }
  const dryRun = argv.includes("--dry-run");
  const { files, errors } = await uninstallRecallHooks(agents.length > 0 ? agents : ["claude-code", "codex"], environment, dryRun);
  for (const file of files) console.log(`${dryRun ? "Would remove" : "Removed"} Eragon recall hook from ${file}`);
  for (const error of errors) console.error(`Left unchanged: ${error}`);
  return errors.length > 0 ? 1 : 0;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  if (argv[0] === "install") return runInstall(argv.slice(1), process.env);
  if (argv[0] === "uninstall") return runUninstall(argv.slice(1), process.env);
  if (argv[0] === "recall-hook") {
    // Nothing left open may keep the hook alive past its deadline: the client
    // would report the timeout as an error on every prompt.
    setTimeout(() => process.exit(0), recallTimeLeft() + 100).unref();
    const config = resolveConfig(argv.slice(1));
    if (config.ok) await runRecallHook(config);
    return 0;
  }
  const config = resolveConfig(argv);
  if (!config.ok) {
    console.error(config.error);
    return 1;
  }
  const { runMemoryMcp } = await import("./server.js");
  await runMemoryMcp(config);
  return 0;
}
