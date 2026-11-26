import { AGENTS, install } from "./install.js";
import { runMemoryMcp } from "./server.js";
const USAGE = `eragon-context-mcp — Eragon Memory for coding agents

Usage:
  eragon-context-mcp [--url https://<your-eragon>/gw]
  eragon-context-mcp install [--agent claude-code|codex|pi|opencode]... [--url URL] [--model ID] [--dry-run]

install registers this bridge with each coding agent on PATH (or each --agent
named), and for pi and opencode adds an Eragon model provider when --model is
given. It never writes the Gateway key: each agent reads it from its environment.

Environment:
  ERAGON_GATEWAY_URL or ANTHROPIC_BASE_URL
  ERAGON_API_KEY
  ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN when ANTHROPIC_BASE_URL matches the Gateway URL

The server exposes exactly three stdio MCP tools: memory_search, memory_save and memory_share.`;
function explicitUrl(argv) {
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--url")
            return argv[index + 1];
        if (argument?.startsWith("--url="))
            return argument.slice("--url=".length);
    }
    return undefined;
}
export function resolveConfig(argv, environment = process.env) {
    const modelGatewayUrl = environment.ANTHROPIC_BASE_URL?.trim();
    const gatewayUrl = explicitUrl(argv) ?? environment.ERAGON_GATEWAY_URL ?? modelGatewayUrl;
    const eragonKey = environment.ERAGON_API_KEY?.trim();
    // Claude Code sends ANTHROPIC_API_KEY when both are set.
    const modelKey = (environment.ANTHROPIC_API_KEY ?? environment.ANTHROPIC_AUTH_TOKEN)?.trim();
    // A Memory key that differs from the key model calls go out under files the
    // agent's saves under another person or workspace, with nothing to show it:
    // a stale ERAGON_API_KEY left in a shell profile after the model key was
    // replaced did exactly that. Only a gateway base URL makes the two comparable.
    if (modelGatewayUrl &&
        eragonKey !== undefined &&
        modelKey !== undefined &&
        eragonKey !== modelKey) {
        return {
            ok: false,
            error: "ERAGON_API_KEY is not the key your model calls use, so Memory would be saved under a different key. Unset ERAGON_API_KEY, or set it to the same Gateway key.",
        };
    }
    // Without a model Gateway URL, the model key is for Anthropic itself.
    const token = eragonKey ?? (modelGatewayUrl ? modelKey : undefined);
    if (gatewayUrl === undefined || gatewayUrl.trim() === "") {
        return {
            ok: false,
            error: "Pass --url https://<your-eragon>/gw or set ERAGON_GATEWAY_URL.",
        };
    }
    if (!token) {
        return {
            ok: false,
            error: "Set ERAGON_API_KEY to a personal Gateway key, or configure ANTHROPIC_BASE_URL and its Gateway key for Claude Code.",
        };
    }
    if (/[^!-~]/.test(token)) {
        return { ok: false, error: "The Gateway key must be a single printable token." };
    }
    let parsed;
    try {
        parsed = new URL(gatewayUrl);
    }
    catch {
        return { ok: false, error: "The Eragon Gateway URL is invalid." };
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return { ok: false, error: "The Eragon Gateway URL must use HTTPS or HTTP." };
    }
    if (modelKey !== undefined &&
        modelGatewayUrl &&
        URL.parse(modelGatewayUrl)?.href.replace(/\/+$/, "") !== parsed.href.replace(/\/+$/, "")) {
        return { ok: false, error: "Use the Claude Code Gateway URL with its inherited key." };
    }
    return { ok: true, gatewayUrl: gatewayUrl.replace(/\/+$/, ""), token };
}
function values(argv, flag) {
    const found = [];
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === flag && argv[index + 1] !== undefined)
            found.push(argv[index + 1] ?? "");
        else if (argument?.startsWith(`${flag}=`))
            found.push(argument.slice(flag.length + 1));
    }
    return found;
}
const isAgent = (value) => AGENTS.includes(value);
async function runInstall(argv, environment) {
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
        console.log(`${report.agent}: ${dryRun ? "would configure" : "configured"}`);
        for (const file of report.files)
            console.log(`  wrote ${file}`);
        for (const command of report.commands)
            console.log(`  ran ${command}`);
        for (const note of report.notes)
            console.log(`  next: ${note}`);
    }
    console.log("Start a new agent session to load the Eragon Memory tools.");
    return 0;
}
export async function main(argv = process.argv.slice(2)) {
    if (argv.includes("--help") || argv.includes("-h")) {
        console.log(USAGE);
        return 0;
    }
    if (argv[0] === "install")
        return runInstall(argv.slice(1), process.env);
    const config = resolveConfig(argv);
    if (!config.ok) {
        console.error(config.error);
        return 1;
    }
    await runMemoryMcp(config);
    return 0;
}
//# sourceMappingURL=cli.js.map