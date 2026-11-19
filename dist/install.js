/**
 * `eragon-context-mcp install`: registers this bridge with each coding agent
 * found on PATH, in the form that agent was tested with, so a person runs one
 * command instead of following four agent-specific recipes.
 *
 * No configuration it writes holds the Gateway key. Every agent reads it from
 * its own environment at run time (ERAGON_API_KEY, or ANTHROPIC_AUTH_TOKEN for
 * Claude Code), so a key that is replaced never lingers in a file. A file it
 * changes is first copied beside itself as `<file>.eragon-backup`.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { RECALL_EVENT, RECALL_TIMEOUT_SECONDS } from "./recall-hook.js";
export const AGENTS = ["claude-code", "codex", "pi", "opencode"];
/** The binary whose presence on PATH says the agent is installed. */
const AGENT_BINARY = {
    "claude-code": "claude",
    codex: "codex",
    pi: "pi",
    opencode: "opencode",
};
const SERVER = "eragon";
const COMMAND = "eragon-context-mcp";
const KEY_VARIABLE = "ERAGON_API_KEY";
const BACKUP_SUFFIX = ".eragon-backup";
const RECALL_STATUS = "Recalling Eragon Memory (eragon-context-mcp)";
const BRIDGE_BIN = fileURLToPath(new URL("../bin/eragon-context-mcp.mjs", import.meta.url));
function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parseObject(current, file) {
    if (current === undefined || current.trim() === "")
        return {};
    const parsed = JSON.parse(current.replace(/^\uFEFF/, ""));
    if (!isObject(parsed))
        throw new Error(`${file} is not a JSON object`);
    return parsed;
}
function child(parent, key) {
    const value = parent[key];
    return isObject(value) ? value : {};
}
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const TOML_HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/;
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
export function codexConfig(current, gatewayUrl) {
    const kept = [];
    let table = "";
    let skipping = false;
    for (const line of current.split("\n")) {
        const header = TOML_HEADER.exec(line);
        if (header !== null) {
            table = header[1] ?? "";
            skipping = table === `mcp_servers.${SERVER}` || table.startsWith(`mcp_servers.${SERVER}.`);
            if (skipping)
                continue;
        }
        else if (/^\s*mcp_servers\.eragon\b/.test(line) ||
            (table === "mcp_servers" && /^\s*eragon\s*[.=]/.test(line))) {
            throw new Error(`config.toml defines mcp_servers.${SERVER} inline; remove that entry, then run install again`);
        }
        if (!skipping)
            kept.push(line);
    }
    const body = kept.join("\n").replace(/\s+$/, "");
    const entry = [
        `[mcp_servers.${SERVER}]`,
        `command = "${COMMAND}"`,
        `args = ["--url", ${JSON.stringify(gatewayUrl)}]`,
        `env_vars = ["${KEY_VARIABLE}"]`,
    ].join("\n");
    return body === "" ? `${entry}\n` : `${body}\n\n${entry}\n`;
}
/**
 * Pi's mcp.json with the bridge declared directly. Pi's default exposure,
 * codemode, hides MCP tools until a script searches for them; on the PR
 * preview that cost a correction three attempts, and direct exposure took one.
 */
export function piMcpConfig(current, gatewayUrl) {
    const config = parseObject(current, "mcp.json");
    return json({
        ...config,
        mcpServers: {
            ...child(config, "mcpServers"),
            [SERVER]: {
                command: COMMAND,
                args: ["--url", gatewayUrl],
                env: { [KEY_VARIABLE]: `\${${KEY_VARIABLE}}` },
                exposure: "direct",
            },
        },
    });
}
/** Pi's models.json with an Eragon provider that speaks Anthropic Messages through the Gateway. */
export function piModelsConfig(current, gatewayUrl, model) {
    const config = parseObject(current, "models.json");
    const providers = child(config, "providers");
    const existing = child(providers, SERVER);
    const models = Array.isArray(existing.models) ? existing.models.filter(isObject) : [];
    return json({
        ...config,
        providers: {
            ...providers,
            [SERVER]: {
                ...existing,
                baseUrl: gatewayUrl,
                api: "anthropic-messages",
                apiKey: `$${KEY_VARIABLE}`,
                models: [...models.filter((entry) => entry.id !== model), { id: model }],
            },
        },
    });
}
/**
 * OpenCode's opencode.json with the bridge, and an `eragon` provider when a
 * model is named. Its own provider, not an override of `anthropic`, so the
 * person's direct Anthropic setup keeps working.
 */
export function opencodeConfig(current, gatewayUrl, model) {
    const config = parseObject(current, "opencode.json");
    const providers = child(config, "provider");
    const existing = child(providers, SERVER);
    return json({
        ...config,
        ...(model === undefined
            ? {}
            : {
                provider: {
                    ...providers,
                    [SERVER]: {
                        ...existing,
                        npm: "@ai-sdk/anthropic",
                        name: "Eragon",
                        options: { baseURL: `${gatewayUrl}/v1`, apiKey: `{env:${KEY_VARIABLE}}` },
                        models: { ...child(existing, "models"), [model]: {} },
                    },
                },
            }),
        mcp: {
            ...child(config, "mcp"),
            [SERVER]: {
                type: "local",
                command: [COMMAND, "--url", gatewayUrl],
                environment: { [KEY_VARIABLE]: `{env:${KEY_VARIABLE}}` },
                enabled: true,
            },
        },
    });
}
/** Windows installs a CLI as `<name>.cmd` (npm) or `<name>.exe`, found through PATHEXT. */
function candidates(binary, env) {
    if (process.platform !== "win32")
        return [binary];
    return [binary, ...(env.PATHEXT ?? ".EXE;.CMD").split(";").filter(Boolean).map((ext) => `${binary}${ext.toLowerCase()}`)];
}
async function onPath(binary, env) {
    for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
        if (dir === "")
            continue;
        for (const name of candidates(binary, env)) {
            try {
                await access(join(dir, name), constants.X_OK);
                return true;
            }
            catch {
                // Not here.
            }
        }
    }
    return false;
}
async function readOptional(file) {
    try {
        return await readFile(file, "utf8");
    }
    catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
async function writeAtomically(file, contents, mode) {
    const staged = `${file}.eragon-tmp-${randomUUID()}`;
    try {
        await writeFile(staged, contents, { mode, flag: "wx" });
        await rename(staged, file);
    }
    finally {
        await unlink(staged).catch(() => { });
    }
}
/** Keep a private backup and replace the whole configuration atomically. */
async function writeConfig(file, current, next, backup = true) {
    if (current === next)
        return;
    await mkdir(dirname(file), { recursive: true });
    const mode = current === undefined ? 0o600 : (await stat(file)).mode & 0o777;
    if (backup && current !== undefined)
        await writeAtomically(`${file}${BACKUP_SUFFIX}`, current, 0o600);
    await writeAtomically(file, next, mode);
}
function hookFile(agent, env) {
    const home = env.HOME ?? env.USERPROFILE ?? homedir();
    if (agent === "claude-code")
        return join(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "settings.json");
    if (agent === "codex")
        return join(env.CODEX_HOME ?? join(home, ".codex"), "hooks.json");
    return undefined;
}
function shellArgument(value) {
    return /^[\w/.:=-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
function recallHandler(agent, gatewayUrl) {
    // Claude Code already uses its environment for the MCP URL. Codex's --url
    // matches the URL in its existing MCP registration.
    const args = agent === "codex" ? ["recall-hook", "--url", gatewayUrl] : ["recall-hook"];
    const command = [BRIDGE_BIN, ...args].map(shellArgument).join(" ");
    // Windows cannot execute the .mjs entry point directly.
    const windows = process.platform !== "win32" ? {} : agent === "claude-code"
        ? { command: process.execPath, args: [BRIDGE_BIN, ...args] }
        : { commandWindows: `& ${[process.execPath, BRIDGE_BIN, ...args].map((arg) => `'${arg.replaceAll("'", "''")}'`).join(" ")}` };
    return {
        type: "command",
        command,
        timeout: RECALL_TIMEOUT_SECONDS,
        statusMessage: RECALL_STATUS,
        ...(agent === "codex" ? { additionalContextLimit: 0 } : {}),
        ...windows,
    };
}
function promptHookGroups(config, file) {
    if (config.hooks !== undefined && !isObject(config.hooks))
        throw new Error(`${file}: hooks must be an object`);
    const groups = child(config, "hooks")[RECALL_EVENT];
    if (groups === undefined)
        return [];
    if (!Array.isArray(groups))
        throw new Error(`${file}: hooks.${RECALL_EVENT} must be an array`);
    return groups;
}
function separateRecallHooks(groups) {
    const userGroups = [];
    const managed = [];
    for (const group of groups) {
        if (!isObject(group) || !Array.isArray(group.hooks)) {
            userGroups.push(group);
            continue;
        }
        const handlers = group.hooks.filter((handler) => {
            if (!isObject(handler) || handler.type !== "command" || handler.statusMessage !== RECALL_STATUS)
                return true;
            managed.push(handler);
            return false;
        });
        if (handlers.length === group.hooks.length)
            userGroups.push(group);
        else if (handlers.length > 0)
            userGroups.push({ ...group, hooks: handlers });
    }
    return { userGroups, managed };
}
function withRecallHook(config, groups, handler) {
    const hooks = child(config, "hooks");
    return json({ ...config, hooks: { ...hooks, [RECALL_EVENT]: [...groups, { hooks: [handler] }] } });
}
async function prepareRecallInstall(file, handler) {
    const current = await readOptional(file);
    const config = parseObject(current, file);
    const { userGroups, managed } = separateRecallHooks(promptHookGroups(config, file));
    const next = withRecallHook(config, userGroups, handler);
    // Reinstall can update the command while retaining the original backup.
    return () => writeConfig(file, current, next, managed.length === 0);
}
export async function uninstallRecallHooks(agents, env, dryRun) {
    const files = [];
    for (const agent of new Set(agents)) {
        const file = hookFile(agent, env);
        if (file === undefined)
            continue;
        const current = await readOptional(file);
        const config = parseObject(current, file);
        const { userGroups, managed } = separateRecallHooks(promptHookGroups(config, file));
        if (current === undefined || managed.length === 0)
            continue;
        files.push(file);
        if (dryRun)
            continue;
        const [handler] = managed;
        if (handler !== undefined && managed.length === 1) {
            const backupFile = `${file}${BACKUP_SUFFIX}`;
            const backup = await readOptional(backupFile);
            let unchanged = false;
            try {
                const original = parseObject(backup, backupFile);
                unchanged = current === withRecallHook(original, promptHookGroups(original, backupFile), handler);
            }
            catch {
                // An invalid backup cannot restore the file. Remove the managed hook below.
            }
            if (unchanged) {
                if (backup === undefined)
                    await unlink(file);
                else
                    await writeConfig(file, current, backup, false);
                continue;
            }
        }
        const hooks = child(config, "hooks");
        if (userGroups.length === 0)
            delete hooks[RECALL_EVENT];
        else
            hooks[RECALL_EVENT] = userGroups;
        if (Object.keys(hooks).length === 0)
            delete config.hooks;
        await writeConfig(file, current, json(config), false);
    }
    return files;
}
const run = promisify(execFile);
function plan(agent, gatewayUrl, model, env) {
    // Windows has no HOME; its agents keep their config under the profile directory.
    const home = env.HOME ?? env.USERPROFILE ?? homedir();
    const missingKey = env[KEY_VARIABLE] === undefined
        ? [`Export ${KEY_VARIABLE}=<your personal Gateway key> in the shell you start it from.`]
        : [];
    switch (agent) {
        case "claude-code":
            return {
                files: [],
                // Claude Code passes its whole environment to the bridge, which reads
                // the URL and key the model calls already use.
                commands: [
                    ["claude", "mcp", "remove", SERVER, "--scope", "user"],
                    ["claude", "mcp", "add", "--scope", "user", SERVER, "--", COMMAND],
                ],
                notes: [
                    ...(env.ANTHROPIC_BASE_URL === undefined || env.ANTHROPIC_AUTH_TOKEN === undefined
                        ? ["Set ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN as the Gateway Connect page shows; the bridge uses them."]
                        : []),
                    ...(env[KEY_VARIABLE] !== undefined && env[KEY_VARIABLE] !== env.ANTHROPIC_AUTH_TOKEN
                        ? [`Unset ${KEY_VARIABLE} for Claude Code: the bridge refuses to start beside a key other than the model's.`]
                        : []),
                ],
            };
        case "codex": {
            const codexHome = env.CODEX_HOME ?? join(home, ".codex");
            return {
                files: [{ file: join(codexHome, "config.toml"), next: (current) => codexConfig(current ?? "", gatewayUrl) }],
                commands: [],
                notes: [...missingKey, "Review and trust the Eragon recall hook with /hooks in Codex."],
            };
        }
        case "pi": {
            const dir = env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent");
            return {
                files: [
                    { file: join(dir, "mcp.json"), next: (current) => piMcpConfig(current, gatewayUrl) },
                    ...(model === undefined
                        ? []
                        : [{ file: join(dir, "models.json"), next: (current) => piModelsConfig(current, gatewayUrl, model) }]),
                ],
                commands: [],
                notes: [...missingKey, ...(model === undefined ? [] : [`Start it with: pi --model ${SERVER}/${model}`])],
            };
        }
        case "opencode": {
            const dir = join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "opencode");
            return {
                files: [{ file: join(dir, "opencode.json"), next: (current) => opencodeConfig(current, gatewayUrl, model) }],
                commands: [],
                notes: [...missingKey, ...(model === undefined ? [] : [`Start it with: opencode --model ${SERVER}/${model}`])],
            };
        }
    }
}
/**
 * Configures each requested agent, or with `"detect"` each one whose binary
 * is on PATH, in the order of AGENTS. A dry run reports what it would do and
 * changes nothing.
 */
export async function install(options) {
    const wanted = [];
    for (const agent of AGENTS) {
        const asked = options.agents === "detect" ? await onPath(AGENT_BINARY[agent], options.env) : options.agents.includes(agent);
        if (asked)
            wanted.push(agent);
    }
    const reports = [];
    for (const agent of wanted) {
        const steps = plan(agent, options.gatewayUrl, options.model, options.env);
        const recallFile = hookFile(agent, options.env);
        if (!options.dryRun) {
            const writeHook = recallFile === undefined ? undefined
                : await prepareRecallInstall(recallFile, recallHandler(agent, options.gatewayUrl));
            for (const { file, next } of steps.files) {
                const current = await readOptional(file);
                await writeConfig(file, current, next(current));
            }
            for (const [command, ...args] of steps.commands) {
                try {
                    // A `.cmd` shim runs only through a shell on Windows.
                    await run(command ?? "", args, { env: options.env, shell: process.platform === "win32" });
                }
                catch (error) {
                    // `mcp remove` fails when nothing is registered yet; that is the
                    // state it is there to reach.
                    if (args[1] !== "remove")
                        throw error;
                }
            }
            await writeHook?.();
        }
        reports.push({
            agent,
            files: [...steps.files.map(({ file }) => file), ...(recallFile === undefined ? [] : [recallFile])],
            commands: steps.commands.map((command) => command.join(" ")),
            notes: steps.notes,
        });
    }
    return reports;
}
//# sourceMappingURL=install.js.map