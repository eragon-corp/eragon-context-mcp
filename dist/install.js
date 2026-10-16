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
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
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
function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parseObject(current, file) {
    if (current === undefined || current.trim() === "")
        return {};
    const parsed = JSON.parse(current);
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
async function onPath(binary, env) {
    for (const dir of (env.PATH ?? "").split(delimiter)) {
        if (dir === "")
            continue;
        try {
            await access(join(dir, binary), constants.X_OK);
            return true;
        }
        catch {
            // Not in this directory.
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
/**
 * Writes `next` to `file` through a temporary file and a rename, so an agent
 * starting meanwhile never reads half a config; the previous contents are
 * kept as `<file>.eragon-backup`.
 */
async function writeConfig(file, current, next) {
    await mkdir(dirname(file), { recursive: true });
    if (current !== undefined && current !== next)
        await writeFile(`${file}${BACKUP_SUFFIX}`, current);
    const staged = `${file}.eragon-tmp-${process.pid}`;
    await writeFile(staged, next);
    await rename(staged, file);
}
const run = promisify(execFile);
function plan(agent, gatewayUrl, model, env) {
    const home = env.HOME ?? "";
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
                notes: missingKey,
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
        if (!options.dryRun) {
            for (const { file, next } of steps.files) {
                const current = await readOptional(file);
                await writeConfig(file, current, next(current));
            }
            for (const [command, ...args] of steps.commands) {
                try {
                    await run(command ?? "", args, { env: options.env });
                }
                catch (error) {
                    // `mcp remove` fails when nothing is registered yet; that is the
                    // state it is there to reach.
                    if (args[1] !== "remove")
                        throw error;
                }
            }
        }
        reports.push({
            agent,
            files: steps.files.map(({ file }) => file),
            commands: steps.commands.map((command) => command.join(" ")),
            notes: steps.notes,
        });
    }
    return reports;
}
//# sourceMappingURL=install.js.map