import type { Readable } from "node:stream";
type ConfigEnvironment = Partial<Record<"ERAGON_GATEWAY_URL" | "ANTHROPIC_BASE_URL" | "ERAGON_API_KEY" | "ANTHROPIC_API_KEY" | "ANTHROPIC_AUTH_TOKEN", string>>;
type ConfigError = {
    ok: false;
    error: string;
    exitCode?: number;
};
export type ResolvedConfig = {
    ok: true;
    gatewayUrl: string;
    token: string;
} | ConfigError;
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
    keyCommandStdin?: Readable;
}): Promise<ResolvedConfig>;
export declare function main(argv?: string[]): Promise<number>;
export {};
//# sourceMappingURL=cli.d.ts.map