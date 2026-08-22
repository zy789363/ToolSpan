import request from "supertest";
import { describe, expect, it } from "vitest";

import { createHttpApp } from "../src/http-app.js";
import { SERVICE_INFO } from "../src/service-info.js";

describe("MCP Streamable HTTP endpoint", () => {
  it("initializes through JSON-RPC and advertises the server identity", async () => {
    const response = await request(createHttpApp())
      .post("/mcp")
      .set("Accept", "application/json, text/event-stream")
      .set("Content-Type", "application/json")
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "integration-test", version: "1.0.0" },
        },
      })
      .expect(200);

    expect(response.body).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        serverInfo: { name: SERVICE_INFO.service, version: SERVICE_INFO.version },
        capabilities: { tools: {} },
      },
    });
  });

  it("rejects an untrusted Origin before processing MCP input", async () => {
    const response = await request(createHttpApp())
      .post("/mcp")
      .set("Origin", "https://evil.example")
      .set("Accept", "application/json, text/event-stream")
      .set("Content-Type", "application/json")
      .send({
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "integration-test", version: "1.0.0" },
        },
      })
      .expect(403);

    expect(response.body).toEqual({ error: "Forbidden origin" });
  });
});
