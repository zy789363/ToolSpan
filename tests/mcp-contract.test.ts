import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import expectedContract from "./fixtures/mcp-tools.v0.3.json" with { type: "json" };
import {
  contractFromListedTools,
} from "../src/mcp-tool-registry.js";
import { createMcpServer, type McpServices } from "../src/mcp.js";

function listingServices(): McpServices {
  const unavailable = new Proxy({}, {
    get() {
      throw new Error("Contract listing must not call a Tool service");
    },
  });
  return {
    workspaces: unavailable as McpServices["workspaces"],
    files: unavailable as McpServices["files"],
    jobs: unavailable as McpServices["jobs"],
    artifacts: unavailable as McpServices["artifacts"],
    runnerNames: [],
    startedAt: 0,
    protectedResourceMetadataUrl: "https://mcp.example.test/.well-known/oauth-protected-resource",
  };
}

describe("MCP golden contract", () => {
  it("matches the owned runtime registry and its real tools/list response", async () => {
    const runtime = createMcpServer(listingServices());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "contract-test", version: "1.0.0" });
    await runtime.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      expect(runtime.registry.contract()).toEqual(expectedContract);
      expect(contractFromListedTools(
        listed.tools as Array<Record<string, unknown>>,
        runtime.registry,
      )).toEqual(expectedContract);
    } finally {
      await client.close();
      await runtime.server.close();
    }
  });
});
