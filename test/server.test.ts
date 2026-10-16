import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { createMemoryMcpServer } from "../src/server.js";

async function connected() {
  const server = createMemoryMcpServer({ gatewayUrl: "https://s.eragon.ai/gw", token: "test-secret" });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("memory MCP server", () => {
  it("tells the agent when to search and save Memory without any CLAUDE.md or AGENTS.md text", async () => {
    const client = await connected();
    const instructions = client.getInstructions() ?? "";

    expect(instructions).toContain("memory_search");
    expect(instructions).toContain("memory_save");
    expect(instructions).toContain("without being asked");
    expect(instructions).toContain("memory_id");
    await client.close();
  });

  it("offers memory_id on memory_save for corrections", async () => {
    const client = await connected();
    const { tools } = await client.listTools();
    const save = tools.find((tool) => tool.name === "memory_save");

    expect(save?.inputSchema.properties).toHaveProperty("memory_id");
    expect(save?.inputSchema.required).toEqual(["kind", "title", "content"]);
    expect(save?.description).toContain("Private matters of anyone other than the user");
    await client.close();
  });
});
