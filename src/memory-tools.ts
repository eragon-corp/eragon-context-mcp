import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

import { requestGateway } from "./client.js";

export const MEMORY_TOOLS: Tool[] = [
  {
    name: "memory_search",
    description:
      "Search Eragon Memory visible to this user in General. Use before saving when durable Memory may already answer or conflict.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to recall from durable Memory." },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 8 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_save",
    description:
      "Save an explicit durable fact, preference, procedure, or contact to Personal General Memory. Never save secrets, guesses, transcripts, transient task state, or project-specific details.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["fact", "preference", "procedure", "contact"] },
        title: { type: "string", description: "Short durable label." },
        content: { type: "string", description: "Self-contained durable information to remember." },
        idempotency_key: {
          type: "string",
          description: "Optional stable key reused when retrying the same logical save.",
        },
      },
      required: ["kind", "title", "content"],
      additionalProperties: false,
    },
  },
];

export type MemoryToolConfig = {
  gatewayUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
};

function textResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function gatewayErrorMessage(body: unknown, status: number): string {
  if (body !== null && typeof body === "object") {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string") return error;
    if (error !== null && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string") return message;
    }
  }
  return `Eragon Memory request failed (${status})`;
}

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

export async function callMemoryTool(
  name: string,
  args: Record<string, unknown>,
  config: MemoryToolConfig,
  fallbackIdempotencyKey?: string,
): Promise<CallToolResult> {
  let path: string;
  let body: Record<string, unknown>;
  if (name === "memory_search") {
    if (!nonEmpty(args.query)) return errorResult("memory_search requires a non-empty query");
    const limit = args.limit === undefined ? 8 : args.limit;
    if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 20) {
      return errorResult("memory_search limit must be an integer from 1 to 20");
    }
    path = "/v1/memory/search";
    body = { query: args.query.trim(), limit };
  } else if (name === "memory_save") {
    const kinds = new Set(["fact", "preference", "procedure", "contact"]);
    if (!nonEmpty(args.kind) || !kinds.has(args.kind)) {
      return errorResult("memory_save kind must be fact, preference, procedure, or contact");
    }
    if (!nonEmpty(args.title) || !nonEmpty(args.content)) {
      return errorResult("memory_save requires non-empty title and content");
    }
    const suppliedKey = args.idempotency_key;
    if (suppliedKey !== undefined && !nonEmpty(suppliedKey)) {
      return errorResult("memory_save idempotency_key must be a non-empty string");
    }
    path = "/v1/memory";
    body = {
      kind: args.kind,
      title: args.title.trim(),
      content: args.content.trim(),
      idempotencyKey: suppliedKey ?? fallbackIdempotencyKey,
    };
    if (body.idempotencyKey === undefined) delete body.idempotencyKey;
  } else {
    return errorResult(`Unknown Eragon Memory tool: ${name}`);
  }

  try {
    const response = await requestGateway({
      gatewayUrl: config.gatewayUrl,
      token: config.token,
      path,
      body,
      ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
    });
    if (response.status >= 400) {
      return errorResult(gatewayErrorMessage(response.body, response.status));
    }
    return textResult(response.body);
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}
