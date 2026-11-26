export declare const AGENTS: readonly ["claude-code", "codex", "pi", "opencode"];
export type Agent = (typeof AGENTS)[number];
/**
 * Codex's config.toml with exactly one `[mcp_servers.eragon]` table.
 *
 * Codex starts MCP servers with a filtered environment and forwards only the
 * variables an entry names in `env_vars`, so the key is named there and never
 * written. An earlier eragon table and its subtables are removed first: a
 * second `[mcp_servers.eragon]` table makes the whole file unparseable. An
 * entry written as an inline table or dotted key is refused rather than
 * guessed at.
 */
export declare function codexConfig(current: string, gatewayUrl: string, keyCommand?: string): string;
/**
 * Pi's mcp.json with the bridge declared directly. Pi's default exposure,
 * codemode, hides MCP tools until a script searches for them; on the PR
 * preview that cost a correction three attempts, and direct exposure took one.
 */
export declare function piMcpConfig(current: string | undefined, gatewayUrl: string, keyCommand?: string): string;
/** Pi's models.json with an Eragon provider that speaks Anthropic Messages through the Gateway. */
export declare function piModelsConfig(current: string | undefined, gatewayUrl: string, model: string): string;
/**
 * OpenCode's opencode.json with the bridge, and an `eragon` provider when a
 * model is named. Its own provider, not an override of `anthropic`, so the
 * person's direct Anthropic setup keeps working.
 */
export declare function opencodeConfig(current: string | undefined, gatewayUrl: string, model: string | undefined, keyCommand?: string): string;
export type InstallEnvironment = Record<string, string | undefined>;
export type InstallReport = {
    agent: Agent;
    /** Files written, or that a dry run would write. */
    files: string[];
    /** Commands run, or that a dry run would run. */
    commands: string[];
    /** What the person still has to do or know. */
    notes: string[];
};
/**
 * One argument of a command line cmd.exe hands to an agent's `.cmd` shim.
 * Windows runs npm shims only through a shell, and Node then joins the
 * arguments with spaces, unquoted, so `--key-command "print-key --desktop"`
 * would register `print-key` alone. Quoted as node.exe parses arguments;
 * what cmd.exe would expand or end early inside quotes (`%`, `"`, a line
 * break) is refused rather than registered as a different command.
 */
export declare function cmdArg(arg: string): string;
/**
 * Configures each requested agent, or with `"detect"` each one whose binary
 * is on PATH, in the order of AGENTS. A dry run reports what it would do and
 * changes nothing.
 */
export declare function install(options: {
    agents: readonly Agent[] | "detect";
    gatewayUrl: string;
    model: string | undefined;
    env: InstallEnvironment;
    dryRun: boolean;
    /** A command that prints the key, run by the bridge when its environment has none (ERA-5023). */
    keyCommand?: string | undefined;
}): Promise<InstallReport[]>;
//# sourceMappingURL=install.d.ts.map