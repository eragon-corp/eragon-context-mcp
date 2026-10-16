import { runMemoryMcp } from "./server.js";
const USAGE = `eragon-context-mcp — Eragon Memory for coding agents

Usage:
  eragon-context-mcp [--url https://<your-eragon>/gw]

Environment:
  ERAGON_GATEWAY_URL or ANTHROPIC_BASE_URL
  ERAGON_API_KEY     or ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN

The server exposes exactly two stdio MCP tools: memory_search and memory_save.`;
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
    const gatewayUrl = explicitUrl(argv) ?? environment.ERAGON_GATEWAY_URL ?? environment.ANTHROPIC_BASE_URL;
    // Claude Code sends ANTHROPIC_API_KEY when both are set.
    const modelKey = environment.ANTHROPIC_API_KEY ?? environment.ANTHROPIC_AUTH_TOKEN;
    // A Memory key that differs from the key model calls go out under files the
    // agent's saves under another person or workspace, with nothing to show it:
    // a stale ERAGON_API_KEY left in a shell profile after the model key was
    // replaced did exactly that. Only a gateway base URL makes the two comparable.
    if (environment.ANTHROPIC_BASE_URL !== undefined &&
        environment.ERAGON_API_KEY !== undefined &&
        modelKey !== undefined &&
        environment.ERAGON_API_KEY !== modelKey) {
        return {
            ok: false,
            error: "ERAGON_API_KEY is not the key your model calls use, so Memory would be saved under a different key. Unset ERAGON_API_KEY, or set it to the same Gateway key.",
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
    return { ok: true, gatewayUrl: gatewayUrl.replace(/\/+$/, ""), token };
}
export async function main(argv = process.argv.slice(2)) {
    if (argv.includes("--help") || argv.includes("-h")) {
        console.log(USAGE);
        return 0;
    }
    const config = resolveConfig(argv);
    if (!config.ok) {
        console.error(config.error);
        return 1;
    }
    await runMemoryMcp(config);
    return 0;
}
//# sourceMappingURL=cli.js.map