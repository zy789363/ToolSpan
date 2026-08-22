import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { contractFromListedTools } from "../dist/mcp-tool-registry.js";
import { createMcpServer } from "../dist/mcp.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(projectRoot, "tests", "fixtures", "mcp-tools.v0.3.json");
const privateRegistryField = ["_registered", "Tools"].join("");

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return /\.(?:js|ts)$/u.test(entry.name) ? [entryPath] : [];
  }));
  return nested.flat();
}

async function assertNoPrivateRegistryReferences() {
  const roots = [path.join(projectRoot, "src"), path.join(projectRoot, "dist")];
  const files = (await Promise.all(roots.map(sourceFiles))).flat();
  const matches = [];
  for (const file of files) {
    if ((await readFile(file, "utf8")).includes(privateRegistryField)) {
      matches.push(path.relative(projectRoot, file));
    }
  }
  assert.deepEqual(matches, [], `Private SDK registry reference found in: ${matches.join(", ")}`);
}

function listingServices() {
  const unavailable = new Proxy({}, {
    get() {
      throw new Error("Contract listing must not call a Tool service");
    },
  });
  return {
    workspaces: unavailable,
    files: unavailable,
    jobs: unavailable,
    artifacts: unavailable,
    runnerNames: [],
    startedAt: 0,
    protectedResourceMetadataUrl: "https://mcp.example.test/.well-known/oauth-protected-resource",
  };
}

async function main() {
  const expected = JSON.parse(await readFile(fixturePath, "utf8"));
  assert.equal(expected.length, 27, "Golden fixture must contain exactly 27 tools");
  assert.equal(new Set(expected.map((tool) => tool.name)).size, 27, "Golden fixture contains duplicate tools");

  const runtime = createMcpServer(listingServices());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "contract-check", version: "1.0.0" });
  await runtime.server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const registryContract = runtime.registry.contract();
    const listed = await client.listTools();
    const listedContract = contractFromListedTools(listed.tools, runtime.registry);
    assert.deepEqual(registryContract, expected, "Runtime registry differs from golden fixture");
    assert.deepEqual(listedContract, expected, "Runtime tools/list differs from golden fixture");
  } finally {
    await client.close();
    await runtime.server.close();
  }

  await assertNoPrivateRegistryReferences();
  process.stdout.write([
    "MCP contract: PASS",
    "Tools: 27/27",
    "Registry/tools-list/fixture: MATCH",
    "Private SDK registry references: 0",
    "",
  ].join("\n"));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "MCP contract check failed"}\n`);
  process.exitCode = 1;
});
