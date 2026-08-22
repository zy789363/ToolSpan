import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const fixtureRelativePath = "tests/e2e-fixtures/remote-workspace";

async function text(file: string): Promise<string> {
  return readFile(path.resolve(file), "utf8");
}

describe("release Host E2E contract", () => {
  it("keeps the synthetic remote workspace at the contracted fixture path", async () => {
    const repository = await realpath(".");
    const fixture = await realpath(fixtureRelativePath);

    expect(path.relative(repository, fixture).split(path.sep).join("/")).toBe(fixtureRelativePath);
    await expect(text(`${fixtureRelativePath}/README.txt`)).resolves.toContain(
      "only allowed workspace root",
    );
    await expect(text(`${fixtureRelativePath}/writable.txt`)).resolves.toBe(
      "toolspan-release-e2e-state: pristine\n",
    );
    const fixturePackage = JSON.parse(await text(`${fixtureRelativePath}/package.json`)) as {
      private: boolean;
      scripts: Record<string, string>;
    };
    expect(fixturePackage).toMatchObject({
      private: true,
      scripts: { "toolspan:e2e": "node e2e-job.mjs" },
    });
    await expect(text(`${fixtureRelativePath}/e2e-job.mjs`)).resolves.toContain(
      "output/job-result.txt",
    );
  });

  it("uses official Inspector plus the pinned SDK against an installed npm-pack artifact", async () => {
    const rootPackage = JSON.parse(await text("package.json")) as {
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    const harness = await text("scripts/e2e-mcp-inspector.mjs");
    const wrapper = await text("scripts/e2e-host-local.mjs");

    expect(rootPackage.dependencies["@modelcontextprotocol/sdk"]).toBe("1.30.0");
    expect(harness).toContain('const SDK_VERSION = "1.30.0"');
    expect(harness).toContain("StreamableHTTPClientTransport");
    expect(harness).toContain('"--package=@modelcontextprotocol/inspector@latest"');
    expect(harness).toContain('"--stored-auth-only"');
    expect(harness).toContain('allowedExitCodes: [3]');
    expect(harness).toContain("MCP_INSPECTOR_OAUTH_STATE_PATH");
    expect(harness).toContain('["pack", "--json", "--pack-destination"');
    expect(harness).toContain('"--ignore-scripts"');
    expect(harness).toContain('shell: false');
    expect(harness).not.toContain("shell: true");
    expect(harness).not.toContain("...process.env");
    expect(harness).not.toContain("CloudFlareAPIKEY");
    expect(wrapper).toContain('command: "npm run e2e:host:local"');
    expect(rootPackage.scripts["e2e:mcp-inspector"]).toBe(
      "node scripts/e2e-mcp-inspector.mjs",
    );
    expect(rootPackage.scripts["e2e:host:local"]).toBe("node scripts/e2e-host-local.mjs");
  });

  it("defines sanitized evidence and cannot turn the local run into Codex remote PASS", async () => {
    const schema = JSON.parse(await text("schemas/release-evidence.schema.json")) as {
      properties: Record<string, unknown>;
    };
    const protocolClient = (schema.properties.protocolClient as {
      properties: Record<string, { const?: unknown }>;
    }).properties;
    const gates = (schema.properties.gates as {
      properties: Record<string, { properties: Record<string, { const?: unknown }> }>;
    }).properties;
    const safety = (schema.properties.secretSafety as {
      properties: Record<string, { const?: unknown }>;
    }).properties;

    expect(protocolClient.inspectorCliExecuted?.const).toBe(true);
    expect(protocolClient.inspectorResult?.const).toBe("auth_required");
    expect(protocolClient.inspectorExitCode?.const).toBe(3);
    expect(protocolClient.inspectorCredentialsSupplied?.const).toBe(false);
    expect(protocolClient.inspectorAuthStoreWritten?.const).toBe(false);
    expect(gates["E-HOST-01"]?.properties.status?.const).toBe("FAIL");
    expect(gates["E-CODEX-01"]?.properties.status?.const).toBe("EXTERNAL_GATE_PENDING");
    expect(safety.passwordInCommandLine?.const).toBe(false);
    expect(safety.secretValuesInEvidence?.const).toBe(false);
    expect(safety.externalCredentialInheritedByServer?.const).toBe(false);
  });
});
