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
          // The Gateway counts the bridge's Memory calls under this name.
          "user-agent": expect.stringMatching(/^eragon-context-mcp\/\d+\.\d+\.\d+$/),
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

describe("memory_save corrections", () => {
  const ok = () =>
    vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ memory: { id: "mem_old", outcome: "updated" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

  it("sends memory_id as the entry to correct", async () => {
    const fetchImpl = ok();
    await callMemoryTool(
      "memory_save",
      { kind: "fact", title: "Deploy day", content: "Deploys are on Friday.", memory_id: " mem_old " },
      { gatewayUrl: "https://s.eragon.ai/gw", token: "test-secret", fetchImpl },
      "mcp:session:request",
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://s.eragon.ai/gw/v1/memory",
      expect.objectContaining({
        body: JSON.stringify({
          kind: "fact",
          title: "Deploy day",
          content: "Deploys are on Friday.",
          idempotencyKey: "mcp:session:request",
          memoryId: "mem_old",
        }),
      }),
    );
  });

  it("rejects an empty memory_id without calling the Gateway", async () => {
    const fetchImpl = ok();
    const result = await callMemoryTool(
      "memory_save",
      { kind: "fact", title: "Deploy day", content: "Deploys are on Friday.", memory_id: " " },
      { gatewayUrl: "https://s.eragon.ai/gw", token: "test-secret", fetchImpl },
    );

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("memory_share", () => {
  const config = (fetchImpl: typeof fetch) => ({ gatewayUrl: "https://tenant.example/gw", token: "test-secret", fetchImpl });

  it("files a share for the user's approval and says where to approve it", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://tenant.example/gw/v1/memory/share");
      expect(JSON.parse(String(init?.body))).toEqual({ memoryIds: ["mem_1"], audience: "team", team: "Platform" });
      return new Response(JSON.stringify({
        approval: { id: "gwa_1", status: "pending", description: "Share 1 memory with the Platform team", expiresAt: "2026-10-17T08:00:00.000Z", reviewPath: "/inbox" },
      }), { status: 202, headers: { "content-type": "application/json" } });
    });

    const result = await callMemoryTool("memory_share", { memory_ids: ["mem_1"], audience: "team", team: "Platform" }, config(fetchImpl));

    expect(result.isError).not.toBe(true);
    expect(result.content[0]).toEqual({
      type: "text",
      text: "Nothing is shared yet. Sent to the user for approval: Share 1 memory with the Platform team. Tell them to approve or deny it in their Eragon Inbox at https://tenant.example/inbox before 2026-10-17T08:00:00.000Z. Approval id: gwa_1.",
    });
  });

  it("hands back the gateway's question when a name is ambiguous", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ask: "More than one colleague matches Al." }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    const result = await callMemoryTool("memory_share", { memory_ids: ["mem_1"], recipients: ["Al"] }, config(fetchImpl));
    expect(result.content[0]).toEqual({ type: "text", text: "More than one colleague matches Al." });
  });

  it("needs memory ids and exactly one of recipients and audience before calling the gateway", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    for (const args of [
      { memory_ids: [], audience: "org" },
      { memory_ids: ["mem_1"] },
      { memory_ids: ["mem_1"], recipients: ["a"], audience: "org" },
      { memory_ids: ["mem_1"], audience: "everyone" },
      { memory_ids: ["mem_1"], recipients: ["a"], team: "Platform" },
    ]) {
      expect((await callMemoryTool("memory_share", args, config(fetchImpl))).isError).toBe(true);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("passes on the gateway's refusal", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { message: "this gateway key cannot write Eragon Memory" } }), {
      status: 403, headers: { "content-type": "application/json" },
    }));
    const result = await callMemoryTool("memory_share", { memory_ids: ["mem_1"], audience: "org" }, config(fetchImpl));
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: "this gateway key cannot write Eragon Memory" }] });
  });

  it("never sends the user to look for a share the gateway did not file", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    const result = await callMemoryTool("memory_share", { memory_ids: ["mem_1"], audience: "org" }, { gatewayUrl: "https://tenant.example/gw", token: "test-secret", fetchImpl });
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: "Eragon did not file this share; nothing was shared or sent for approval." }] });
  });
});
