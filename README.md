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
| Claude Code | `claude mcp add --scope user eragon -- eragon-context-mcp` |
| Codex | `[mcp_servers.eragon]` in `config.toml`, with `env_vars = ["ERAGON_API_KEY"]` |
| Pi | `mcp.json` with `exposure: "direct"`, and an `eragon` provider in `models.json` when `--model` is given |
| OpenCode | the bridge in `opencode.json`, and an `eragon` provider when `--model` is given |

Name agents with `--agent` (repeatable) to skip detection, and add
`--dry-run` to see what it would change. It never writes the Gateway key:
Claude Code reads `ANTHROPIC_AUTH_TOKEN`, the others `ERAGON_API_KEY`, from
the environment they start in. A file it changes is kept beside itself as
`<file>.eragon-backup`.

The sections below are the same setup by hand.

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
