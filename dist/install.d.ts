export declare const AGENTS: readonly ["claude-code", "codex", "pi", "opencode"];
export type Agent = (typeof AGENTS)[number];
type JsonObject = Record<string, unknown>;
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
export declare function codexConfig(current: string, gatewayUrl: string): string;
/**
 * Pi's mcp.json with the bridge declared directly. Pi's default exposure,
 * codemode, hides MCP tools until a script searches for them; on the PR
 * preview that cost a correction three attempts, and direct exposure took one.
 */
export declare function piMcpConfig(current: string | undefined, gatewayUrl: string): string;
/** Pi's models.json with an Eragon provider that speaks Anthropic Messages through the Gateway. */
export declare function piModelsConfig(current: string | undefined, gatewayUrl: string, model: string): string;
/**
 * OpenCode's opencode.json with the bridge, and an `eragon` provider when a
 * model is named. Its own provider, not an override of `anthropic`, so the
 * person's direct Anthropic setup keeps working.
 */
export declare function opencodeConfig(current: string | undefined, gatewayUrl: string, model: string | undefined): string;
export type InstallEnvironment = Record<string, string | undefined>;
export type InstallReport = {
    agent: Agent;
    /** Files written, or that a dry run would write. */
    files: string[];
    /** Commands run, or that a dry run would run. */
    commands: string[];
    /** What the person still has to do or know. */
    notes: string[];
    /** Why this agent was skipped or left partly configured; the other agents are still configured. */
    error?: string;
};
/**
 * One double-quoted argument that cmd, PowerShell and Git Bash all read the
 * same way. Codex runs `commandWindows` in the session's shell, which is any
 * of the three. Each expands something inside double quotes (`%`, `$`, a
 * backtick), so a value containing one cannot be passed safely.
 */
export declare function windowsArgument(value: string): string;
export type RecallHandlerOptions = {
    platform: NodeJS.Platform;
    /** `eragon-context-mcp` on PATH is this binary. */
    byName: boolean;
    /** The bridge entry point, `bin/eragon-context-mcp.mjs`. */
    bin?: string;
};
/**
 * The hook entry for one client.
 *
 * On macOS and Linux both clients run `command` with a shell. It names the
 * bridge as `eragon-context-mcp` when that is this binary on PATH, otherwise by
 * its absolute path; the entry point runs through `#!/usr/bin/env node`.
 *
 * Windows cannot execute the `.mjs` entry point, and the npm `.cmd` shim needs
 * a shell. Claude Code gets its exec form, `node` with arguments and no shell
 * at all. Codex gets `commandWindows`, run by the session's shell (cmd by
 * default, or PowerShell or Git Bash): `node "<entry point>" …` with forward
 * slashes reads the same in all three.
 */
export declare function recallHandler(agent: Agent, gatewayUrl: string, options: RecallHandlerOptions): JsonObject;
/**
 * Removes the managed recall hook from each client's hook file. A file that
 * cannot be read or parsed is reported in `errors` and left alone; the other
 * clients are still handled.
 */
export declare function uninstallRecallHooks(agents: readonly Agent[], env: InstallEnvironment, dryRun: boolean): Promise<{
    files: string[];
    errors: string[];
}>;
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
}): Promise<InstallReport[]>;
export {};
//# sourceMappingURL=install.d.ts.map