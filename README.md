# Eragon Context MCP

Connect coding agents to the key owner's Eragon Memory through a narrow local
MCP bridge.

The bridge exposes exactly three tools:

- `memory_search` searches permission-filtered General Memory.
- `memory_save` writes durable facts, preferences, procedures, or contacts to
  the key owner's **Personal Memory in General**, or corrects one of the key
  owner's own entries when given its `memory_id`.
- `memory_share` asks to share selected memories with named colleagues, the
  key owner's team, or the whole workspace. It shares nothing itself: the
  request waits in the key owner's Eragon Inbox, and the memories are shared
  only when they approve it there.

The agent needs no memory instructions in CLAUDE.md or AGENTS.md. The bridge
tells it when to search and save as it connects, and the Gateway adds the same
guidance to every model call.

It cannot write Team, Organization, Knowledge, or Project data. A memory reaches
a team or the workspace only when the key owner approves a share in Eragon. It never stores
the Gateway key in MCP configuration; the child process reads the key already
present in the coding agent's environment.

## Requirements

- Node.js 22.19 or newer
- A personal Eragon Gateway key
- **Use my Eragon context** enabled for `memory_search`
- **Allow Memory write-back** enabled for `memory_save` and `memory_share`

Use an HTTPS Gateway URL outside isolated local testing.

## Install from GitHub

Until the first tagged release, install the current `main` branch archive:

```sh
npm install -g https://github.com/eragon-corp/eragon-context-mcp/archive/refs/heads/main.tar.gz
```

After releases begin, pin the tag instead:

```sh
npm install -g https://github.com/eragon-corp/eragon-context-mcp/archive/refs/tags/v0.1.0.tar.gz
```

Verify the binary:

```sh
eragon-context-mcp --help
```

## Set up every agent at once

After installing, run:

```sh
eragon-context-mcp install --url https://<your-eragon>/gw --model <model-id>
```

It finds Claude Code, Codex, Pi and OpenCode on your PATH and registers the
bridge with each, the way each was tested:

| Agent | What it writes |
|---|---|
| Claude Code | `claude mcp add --scope user eragon -- eragon-context-mcp` and a recall hook in `~/.claude/settings.json` |
| Codex | `[mcp_servers.eragon]` in `config.toml`, with `env_vars = ["ERAGON_API_KEY"]`, and a recall hook in `$CODEX_HOME/hooks.json` (`~/.codex/hooks.json` by default) |
| Pi | `mcp.json` with `exposure: "direct"`, and an `eragon` provider in `models.json` when `--model` is given |
| OpenCode | the bridge in `opencode.json`, and an `eragon` provider when `--model` is given |

Name agents with `--agent` (repeatable) to skip detection, and add
`--dry-run` to see what it would change. It never writes the Gateway key:
Claude Code reads `ANTHROPIC_AUTH_TOKEN`, the others `ERAGON_API_KEY`, from
the environment they start in. A file it changes is kept beside itself as
`<file>.eragon-backup`. A settings file that is a symlink (for example into a
dotfiles repository) stays a symlink: the change is written to the file it
points to. If a client's settings file is not valid JSON, `install` names the
file, leaves that client untouched, configures the others, and exits 1.

## Automatic recall in Claude Code and Codex

On each `UserPromptSubmit` event, the hook sends the prompt text as
`{"query": "…"}` to `POST /gw/v1/memory/recall` with the configured Gateway
key. The Gateway replies `{"text": "<eragon_memory_context>…</eragon_memory_context>", "count": 2, "status": "ok"}`;
any 2xx reply with a non-blank `text` is a recall. The hook adds that text to
the conversation as additional context. The Gateway can then skip duplicate
recall, and the client keeps the recalled text in its own history for
subsequent turns and prompt caching.

Recall never holds up or blocks a prompt. The hook gives up 2.5 seconds after
it starts, half a second inside the client's three-second hook timeout, so a
slow Gateway costs one turn without recalled context rather than a timeout
error. A timeout, an empty recall, an older Gateway that returns 404, or any
other failure prints nothing and exits 0, and the prompt continues as typed.

**Privacy.** The hook sends the text of every `UserPromptSubmit` event to
Eragon. In Claude Code that is more than the prompts you type: the event also
fires for scheduled tasks such as each `/loop` iteration, for a background
subagent reporting back, and for messages another session sends to yours, so
their text is sent too. Recalled text can appear in the agent's local
transcript. The hook reads the key from the agent's environment; the key is
never written to a settings file or passed on a command line.

Use `install --agent claude` (or `claude-code`) or `install --agent codex` to
set up one client. Claude Code uses the Gateway URL and key from its
environment. Codex uses the URL supplied at install and reads the key from
its environment. In Codex, open `/hooks` and trust the Eragon recall hook
before its first run.

When `eragon-context-mcp` on your PATH is the copy running `install` (as after
`npm install -g`), the hook calls it by name, like the MCP registration does.
Otherwise it calls the package's entry point by absolute path; run `install`
again after moving or reinstalling the package. Either way the entry point
runs with `node` from the client's PATH. A client launched from the Dock,
Finder or a desktop shortcut may not have your shell's PATH: if `node` (for
example one installed with nvm or fnm) is missing from it, the hook cannot
start and the client reports a hook error on each prompt, though the prompt
still goes through. Start the client from a shell, or put `node` on the PATH
that GUI apps see.

On Windows, neither client can run the `.mjs` entry point directly. Claude
Code gets an exec-form hook (`"command": "node"` with `args`), which runs
without a shell and needs a Claude Code version whose hooks support `args`.
Codex runs `commandWindows` in the session's shell (cmd by default, or
PowerShell or Git Bash), so the hook is written as one
`node "<entry point>" recall-hook --url <url>` line that all three read the
same way. Its shape is tested, and it runs under sh and PowerShell in the test
suite; it has not been run under cmd or on Windows itself. `install` refuses
an entry-point path or URL containing `"`, `%`, `$` or a backtick, which one of
those shells would expand.

Remove Eragon's managed recall hooks from both clients with:

```sh
eragon-context-mcp uninstall
```

Add `--agent claude` or `--agent codex` to remove only that client's hook.
Uninstall preserves user hooks and MCP registrations. If the hook file has
had no user edits since installation, uninstall restores its original bytes
from `.eragon-backup` or deletes a file created solely for the hook.

The next sections show how to register the MCP bridge by hand.

## Claude Code

The bridge reads the Gateway URL and key Claude Code already uses for model
traffic, as the Gateway Connect page sets them:

```sh
export ANTHROPIC_BASE_URL="https://<your-eragon>/gw"
export ANTHROPIC_AUTH_TOKEN="<personal-gateway-key>"
```

Register the bridge once:

```sh
claude mcp add --scope user eragon -- eragon-context-mcp
```

Then restart Claude Code and check:

```sh
claude mcp list
```

Try it without naming a tool:

```text
I always deploy on Friday afternoons.
```

In a new session:

```text
When should I schedule the deploy?
```

## Codex

Codex starts MCP servers with a filtered environment. It forwards only the
variables an entry lists in `env_vars`, so `codex mcp add` alone leaves the
bridge without a key and Codex shows no memory tools. Write the entry
yourself, with the URL as an argument and the key forwarded by name:

```sh
export ERAGON_API_KEY="<personal-gateway-key>"

codex mcp remove eragon >/dev/null 2>&1
mkdir -p "${CODEX_HOME:-$HOME/.codex}"
cat >> "${CODEX_HOME:-$HOME/.codex}/config.toml" <<'EOF'

[mcp_servers.eragon]
command = "eragon-context-mcp"
args = ["--url", "https://<your-eragon>/gw"]
env_vars = ["ERAGON_API_KEY"]
EOF
codex mcp get eragon
```

`codex mcp get eragon` should show `env: ERAGON_API_KEY=*****`. The key stays
in your shell and is never written to `config.toml`. Removing the old entry
first keeps a re-run from adding a second `[mcp_servers.eragon]` table, which
Codex would refuse to load.

`codex exec` runs without a person to approve tool calls and cancels any
that need approval. For headless runs, approve the Eragon tools for that run:

```sh
codex exec -c 'mcp_servers.eragon.default_tools_approval_mode="approve"' "<prompt>"
```

## Configuration

The URL is resolved in this order:

1. `--url`
2. `ERAGON_GATEWAY_URL`
3. `ANTHROPIC_BASE_URL`

The key is resolved in this order:

1. `ERAGON_API_KEY`
2. `ANTHROPIC_API_KEY`
3. `ANTHROPIC_AUTH_TOKEN`

When `ANTHROPIC_BASE_URL` is set, the bridge refuses to start if
`ERAGON_API_KEY` differs from the key Claude Code sends (`ANTHROPIC_API_KEY`,
or else `ANTHROPIC_AUTH_TOKEN`). A stale `ERAGON_API_KEY` would otherwise save
Memory under another key than the model calls use.

## Development

```sh
npm install
npm test
npm run typecheck
npm run build
npm pack --dry-run
```

The Gateway remains authoritative for identity, permissions, storage scope,
deduplication, and audit behavior. This repository is only the local stdio MCP
adapter.
