import { type KeySource } from "./server.js";
type ConfigEnvironment = Partial<Record<"ERAGON_GATEWAY_URL" | "ANTHROPIC_BASE_URL" | "ERAGON_API_KEY" | "ANTHROPIC_API_KEY" | "ANTHROPIC_AUTH_TOKEN", string>>;
export type ResolvedConfig = {
    ok: true;
    gatewayUrl: string;
    token: string;
} | {
    ok: false;
    error: string;
};
/** Longer than a keychain read takes, shorter than a client waits for an MCP server to start. */
export declare const KEY_COMMAND_TIMEOUT_MS = 15000;
export declare function resolveConfig(argv: string[], environment?: ConfigEnvironment): ResolvedConfig;
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
export declare function loadConfig(argv: string[], environment?: NodeJS.ProcessEnv, options?: {
    keyCommandTimeoutMs?: number;
}): Promise<ResolvedConfig>;
/**
 * What the bridge starts with, without waiting for a key command (ERA-5056).
 * A key in the environment is used at once. A key command runs in the
 * background as the bridge starts: the client's start-up window (10 s in
 * older Codex) must not be spent on a keychain prompt, and the first
 * tools/list already waits at most 5 s. A command that fails is run again by
 * the next tool call, so Memory works once the key can be read (an unlocked
 * keychain), and its tools are listed all along. A missing URL, or no key and
 * no command, still stops the bridge at once with the same message as before.
 */
export declare function prepareBridge(argv: string[], environment?: NodeJS.ProcessEnv, options?: {
    keyCommandTimeoutMs?: number;
    log?: (message: string) => void;
}): {
    ok: true;
    gatewayUrl: string;
    key: KeySource;
} | {
    ok: false;
    error: string;
};
export declare function main(argv?: string[]): Promise<number>;
export {};
//# sourceMappingURL=cli.d.ts.map