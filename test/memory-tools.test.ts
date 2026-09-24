import { describe, expect, it, vi } from "vitest";

import { callMemoryTool } from "../src/memory-tools.js";

describe("memory_search", () => {
  it("searches the key owner's General Memory through the Gateway", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          memories: [
            {
              id: "mem_1",
              title: "Preferred deploy window",
              content: "Friday afternoon",
              kind: "preference",
              scope: "Personal · General",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await callMemoryTool(
      "memory_search",
      { query: "deploy window", limit: 4 },
      {
        gatewayUrl: "https://s.eragon.ai/gw/",
        token: "test-secret",
        fetchImpl,
      },
    );

    expect(result.isError).not.toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "")).toEqual({
      memories: [
        {
          id: "mem_1",
          title: "Preferred deploy window",
          content: "Friday afternoon",
          kind: "preference",
          scope: "Personal · General",
        },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://s.eragon.ai/gw/v1/memory/search",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer test-secret",
          "content-type": "application/json",
        }),
        body: JSON.stringify({ query: "deploy window", limit: 4 }),
      }),
    );
  });
});

describe("memory_save", () => {
  it("saves only a durable Personal General Memory with a stable idempotency key", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          memory: {
            id: "mem_2",
            title: "Preferred deploy window",
            content: "Friday afternoon",
            kind: "preference",
            scope: "Personal · General",
            outcome: "created",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await callMemoryTool(
      "memory_save",
      {
        kind: "preference",
        title: " Preferred deploy window ",
        content: " Friday afternoon ",
        idempotency_key: "deploy-window-v1",
      },
      {
        gatewayUrl: "https://s.eragon.ai/gw",
        token: "test-secret",
        fetchImpl,
      },
    );

    expect(result.isError).not.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://s.eragon.ai/gw/v1/memory",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          kind: "preference",
          title: "Preferred deploy window",
          content: "Friday afternoon",
          idempotencyKey: "deploy-window-v1",
        }),
      }),
    );
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining('"outcome": "created"'),
    });
  });

  it("uses the MCP request identity when the caller omits an idempotency key", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ memory: { id: "mem_3", outcome: "created" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await callMemoryTool(
      "memory_save",
      { kind: "fact", title: "Timezone", content: "Asia/Dubai" },
      { gatewayUrl: "https://s.eragon.ai/gw", token: "test-secret", fetchImpl },
      "mcp:session:request",
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://s.eragon.ai/gw/v1/memory",
      expect.objectContaining({
        body: JSON.stringify({
          kind: "fact",
          title: "Timezone",
          content: "Asia/Dubai",
          idempotencyKey: "mcp:session:request",
        }),
      }),
    );
  });

  it("returns the Gateway's permission error without exposing the credential", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: "this gateway key cannot write Eragon Memory" } }),
        { status: 403, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await callMemoryTool(
      "memory_save",
      { kind: "fact", title: "Timezone", content: "Asia/Dubai" },
      { gatewayUrl: "https://s.eragon.ai/gw", token: "never-print-me", fetchImpl },
    );

    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "this gateway key cannot write Eragon Memory" }],
    });
    expect(JSON.stringify(result)).not.toContain("never-print-me");
  });
});
