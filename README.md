# Eragon Context MCP

Connect coding agents to the key owner's Eragon Memory through a narrow local
MCP bridge.

The bridge exposes three Memory tools:

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

## Skills

Each MCP tool listing checks `GET /gw/v1/skills` with the same Gateway key.
A successful response, including an empty list, enables Skills. The Gateway's
unknown-path response hides them. A temporary failure keeps the last known
availability and triggers a background retry with backoff and any
`Retry-After` delay. The bridge notifies clients when the tool list changes.
The first listing can also retry once within its five-second budget.

A key with Skills access needs Memory write-back (`memory:write`) to propose
changes. If the Gateway returns an unknown-path response for a proposal, the
bridge hides both proposal tools from the current listing and keeps skill reads
available. The next tool listing offers both proposal tools again whenever skill
reads are available. A direct proposal call can also retry in the same session.
After a Skills read refusal, only proposal calls started after that refusal can
hide the proposal tools.

| Tool | Arguments and result |
|---|---|
| `skill_list` | Check before redoing a known procedure. Optional `query` requires every word to appear somewhere in the name or description, ignoring case. Hyphens, underscores, and whitespace separate query words. `truncated: true` means the Gateway returned the first 500 skills by name, even if the filter finds none. |
| `skill_get` | Pass `idOrName` for the published version, `SKILL.md` as `body`, and a list of companion files. Add a bundle-relative `path` to read a text file up to 256 KiB. |
| `skill_propose` | Propose a reusable procedure with a kebab-case `name`, `description`, `body`, `reason`, and optional `files` with `path` and `content`. |
| `skill_revise` | Propose a body-only improvement. Pass `skillId` and `baseVersion` from `skill_get`, the new `body`, and a `reason`. Companion files carry over. |

Proposals wait on **Skills → Installed**. The key owner can **Publish** a new
skill or review the diff and **Accept revision** to apply a draft. The receipt
returns the skill ID as both `proposalId` and `skillId`, the `kind`
(`skill` or `revision`), and a clickable `reviewUrl`. The bridge uses its
Gateway origin when the server returns the relative `/skills/installed` path.
Revision receipts also return `baseVersion`.

New skill names use lowercase letters and digits separated by single hyphens,
up to 100 characters. A description contains 1–500 characters. A proposal
body is limited to 64 KiB, its reason to 1–2000 characters, and a new skill's
files to 50 files totaling 1 MiB. Send SKILL.md as the body and give every
companion file a unique path of at most 500 characters. The whole JSON
request is limited to 2 MiB. Eragon adds name and description frontmatter when
the body arrives without it, and the resulting body must still fit 64 KiB.

The bridge submits a revision directly. Eragon restores the skill's existing
name if the submitted frontmatter declares a different one. For a body
without frontmatter, Eragon adds it using the skill's existing name and
description.

The bridge retries a new skill proposal once if the connection fails before
any response, using the identical request. Eragon returns the earlier
proposal only when the name, SKILL.md, and companion file paths and contents
match. If the name is taken, check **Skills → Installed** for an earlier
proposal before submitting under another name.

If the published version changes, call `skill_get` again, reconcile the
changes, and retry `skill_revise` once. If another change is being applied,
wait for it to land before re-reading the skill.

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
