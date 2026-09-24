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
- At least one Claude-compatible model allowed for the key when Claude Code also
  uses the Gateway for model traffic

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

## Claude Code setup

Export the same personal Gateway key and URL used for model traffic:

```sh
export ANTHROPIC_BASE_URL="https://<your-eragon>/gw"
export ANTHROPIC_API_KEY="<personal-gateway-key>"
```

Use the raw URL in the shell. Do not paste Markdown such as
`[https://example/gw](https://example/gw)` into the variable. Make these
variables available in every shell or launcher that starts Claude Code; the MCP
registration intentionally does not copy the key into its configuration.

Register the bridge once:

```sh
claude mcp add --scope user eragon -- eragon-context-mcp
```

Restart Claude Code and confirm that the server is registered:

```sh
claude mcp list
```

### Choose an allowed model

Model authorization and Memory authorization are separate. A working MCP can
still be paired with a key that is not allowed to use Claude Code's default
model. List the models advertised for the key:

```sh
curl -fsS "$ANTHROPIC_BASE_URL/v1/models" \
  -H "Authorization: Bearer $ANTHROPIC_API_KEY"
```

If Claude Code reports `403 model not allowed for this gateway key`, start it
with one of the returned Claude-compatible model IDs:

```sh
claude --model <allowed-model-id>
```

The model list is Gateway-specific and can change, so the guide does not
hard-code a model name.

### Verify search and write-back

Search first without changing Memory:

```text
Use the Eragon memory_search tool to tell me what I worked on recently. Cite the Memory titles you used.
```

To verify write-back, save a harmless, clearly labeled fact:

```text
Use the Eragon memory_save tool to remember that my preferred deployment window is Friday afternoon. Title it "Claude Code MCP verification".
```

Start a new Claude Code session, then retrieve it:

```text
Use the Eragon memory_search tool to find "Claude Code MCP verification" and tell me my preferred deployment window.
```

The write test creates a durable Personal General Memory entry. Delete that
entry in Eragon afterward if it was only for verification.

### Troubleshooting

- `403 model not allowed for this gateway key`: select an allowed model as
  described above. This error comes from model authorization, not the MCP.
- `memory_search` is unavailable or denied: enable **Use my Eragon context**,
  then restart Claude Code.
- `memory_save` is denied: use a personal key and enable **Allow Memory
  write-back**.
- The MCP appears in `claude mcp list` but tool calls fail: confirm the Gateway
  variables are present in the exact shell or launcher that started Claude
  Code.
- Claude Code says its built-in `claude.ai` connectors are disabled: this is
  expected when `ANTHROPIC_API_KEY` takes precedence and is unrelated to the
  Eragon MCP server.

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
