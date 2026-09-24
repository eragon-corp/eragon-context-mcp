# Eragon Context MCP

Connect coding agents to the key owner's Eragon Memory through a narrow local
MCP bridge.

The bridge exposes exactly two tools:

- `memory_search` searches permission-filtered General Memory.
- `memory_save` writes durable facts, preferences, procedures, or contacts to
  the key owner's **Personal Memory in General**.

It cannot write Team, Organization, Knowledge, or Project data. It never stores
the Gateway key in MCP configuration; the child process reads the key already
present in the coding agent's environment.

## Requirements

- Node.js 22.19 or newer
- A personal Eragon Gateway key
- **Use my Eragon context** enabled for `memory_search`
- **Allow Memory write-back** enabled for `memory_save`

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

## Claude Code

Export the same personal Gateway key and URL used for model traffic:

```sh
export ANTHROPIC_BASE_URL="https://<your-eragon>/gw"
export ANTHROPIC_API_KEY="<personal-gateway-key>"
```

Register the bridge once:

```sh
claude mcp add --scope user eragon -- eragon-context-mcp
```

Then restart Claude Code and check:

```sh
claude mcp list
```

Example prompts:

```text
Use memory_save to remember that my preferred deployment window is Friday afternoon.
```

In a new session:

```text
Use memory_search to tell me my preferred deployment window.
```

## Codex

Codex can use the same stdio bridge:

```sh
export ERAGON_GATEWAY_URL="https://<your-eragon>/gw"
export ERAGON_API_KEY="<personal-gateway-key>"
codex mcp add eragon -- eragon-context-mcp
```

## Configuration

The URL is resolved in this order:

1. `--url`
2. `ERAGON_GATEWAY_URL`
3. `ANTHROPIC_BASE_URL`

The key is resolved in this order:

1. `ERAGON_API_KEY`
2. `ANTHROPIC_API_KEY`

You can therefore keep model and Memory traffic on the same personal Gateway
credential without copying the secret into an MCP configuration file.

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
