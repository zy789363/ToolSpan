import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  analyzeSetupSecurity,
  analyzeTestEnvironmentManifest,
  createSetupSecurityResult,
} from "../check-setup-security.mjs";
import { analyzeDesktopSecurity, analyzeSetupCredentialProtocol } from "../check-desktop-security.mjs";
import { npmInvocation, verificationEnvironment } from "../desktop-install.mjs";
import { projectRoot } from "../desktop-verification-utils.mjs";
import {
  REQUIRED_SETUP_SCRIPTS,
  SETUP_GOAL_IDS,
  MINIMUM_SETUP_SCENARIO_DECLARATIONS,
  countSetupScenarioDeclarations,
  setupExternalGateSummary,
  setupVerificationStepNames,
  validateSetupPackageScripts,
  verifySetup,
} from "../verify-setup.mjs";

function packageWithRealSetupScripts() {
  return {
    scripts: Object.fromEntries(
      [...REQUIRED_SETUP_SCRIPTS, "verify:setup"].map((name) => [name, `node scripts/${name.replaceAll(":", "-")}.mjs`]),
    ),
  };
}

test("Setup npm orchestration resolves npm-cli, strips secret environment values and never requests a shell", () => {
  const cli = path.join("C:\\Program Files\\nodejs", "node_modules", "npm", "bin", "npm-cli.js");
  const invocation = npmInvocation(cli, ["run", "setup:test"]);
  assert.equal(invocation.command, process.execPath);
  assert.equal(invocation.arguments[0], cli);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.windowsHide, true);

  const original = {
    PATH: "safe-path",
    CloudFlareAPIKEY: "must-not-reach-child",
    TOOLSPAN_E2E_CF_API_TOKEN: "also-must-not-reach-child",
    NPM_TOKEN: "also-secret",
  };
  assert.deepEqual(verificationEnvironment(original), { PATH: "safe-path" });
  assert.equal(original.CloudFlareAPIKEY, "must-not-reach-child");
});

test("Setup package scripts are real and child gates cannot recurse through verify:setup or verify:all:source", () => {
  const document = packageWithRealSetupScripts();
  assert.deepEqual(validateSetupPackageScripts(document), []);
  document.scripts["setup:test"] = "npm run verify:setup";
  assert.deepEqual(validateSetupPackageScripts(document), ["SETUP_SCRIPT_RECURSION:setup:test"]);
  document.scripts["setup:test"] = "npm run verify:all:source";
  assert.deepEqual(validateSetupPackageScripts(document), ["SETUP_SCRIPT_RECURSION:setup:test"]);
  document.scripts["setup:test"] = "echo ...";
  assert.deepEqual(validateSetupPackageScripts(document), ["SETUP_SCRIPT_NOT_REAL:setup:test"]);
  document.scripts["setup:test"] = "vitest run tests/setup*.test.ts";
  assert.deepEqual(validateSetupPackageScripts(document), ["SETUP_SCRIPT_SHELL_GLOB:setup:test"]);
});

test("Core and Desktop source verifiers remain lower-stage leaves and cannot recurse into Setup", async () => {
  for (const relativePath of ["scripts/verify-core.mjs", "scripts/verify-desktop-source.mjs"]) {
    const source = await readFile(path.join(projectRoot, relativePath), "utf8");
    assert.doesNotMatch(source, /["'`]verify:setup["'`]/u, relativePath);
    assert.doesNotMatch(source, /["'`]verify:all:source["'`]/u, relativePath);
  }
});

test("Setup source verifier runs every deterministic layer and leaves unexecuted external gates pending", async () => {
  const rootCalls = [];
  const desktopCalls = [];
  const cargoCalls = [];
  let orchestratorCalls = 0;
  const result = await verifySetup({
    nodeVersion: "24.3.0",
    requiredInputs: [],
    packageDocument: packageWithRealSetupScripts(),
    setupScenarioSource: Array.from(
      { length: MINIMUM_SETUP_SCENARIO_DECLARATIONS },
      (_, index) => `it(\"scenario ${index}\", () => {});`,
    ).join("\n"),
    npmCli: "C:\\node\\npm-cli.js",
    runOrchestratorTests: async () => { orchestratorCalls += 1; },
    runRoot: async (script) => { rootCalls.push(script); },
    runDesktop: async (script, _label, arguments_) => { desktopCalls.push([script, arguments_]); },
    runCargo: async (operation) => { cargoCalls.push(operation); },
  });
  assert.equal(orchestratorCalls, 1);
  assert.deepEqual(rootCalls, [
    "desktop:install",
    "setup:test",
    "check:setup-docs",
    "check:setup-prompts",
    "check:commercial-links",
    "check:affiliate-disclosure",
    "check:vendor-assets",
    "smoke:setup-manifest",
    "check:setup:security",
    "build",
    "verify:core",
    "verify:desktop:source",
  ]);
  assert.deepEqual(desktopCalls, [
    ["test", ["tests/components/setup-page.test.tsx"]],
    ["typecheck", []],
    ["build", []],
    ["check:i18n", []],
    ["test:a11y", []],
  ]);
  assert.deepEqual(cargoCalls, ["fmt", "check", "clippy", "test"]);
  assert.equal(result.status, "PASS");
  assert.equal(result.stageStatus, "SETUP_IMPLEMENTATION_COMPLETE");
  assert.equal(result.deterministicOnly, true);
  assert.equal(result.setupScenarioDeclarations, MINIMUM_SETUP_SCENARIO_DECLARATIONS);
  assert.deepEqual(result.checks, setupVerificationStepNames());
  assert.deepEqual(result.externalGates, setupExternalGateSummary());
  assert.ok(Object.values(result.externalGates).every((value) => value !== "PASS"));
});

test("Setup verifier rejects a token scenario suite below the stage minimum", async () => {
  const source = Array.from({ length: MINIMUM_SETUP_SCENARIO_DECLARATIONS - 1 }, (_, index) => (
    `it(\"scenario ${index}\", () => {});`
  )).join("\n");
  assert.equal(countSetupScenarioDeclarations(source), MINIMUM_SETUP_SCENARIO_DECLARATIONS - 1);
  const result = await verifySetup({
    nodeVersion: "24.3.0",
    requiredInputs: [],
    packageDocument: packageWithRealSetupScripts(),
    setupScenarioSource: source,
    npmCli: "C:\\node\\npm-cli.js",
  });
  assert.equal(result.status, "FAIL");
  assert.equal(result.reason, "SETUP_MOCK_SCENARIO_COVERAGE_INSUFFICIENT");
});

test("Setup security analyzer accepts env-name-only manifests and rejects durable or command-line credentials without printing values", () => {
  const safeFiles = [{
    relativePath: "src/setup/cloudflare-fetch-adapter.ts",
    text: "const API = 'https://api.cloudflare.com/client/v4'; function redact(value: unknown) { return '[REDACTED]'; }",
  }];
  const safeDocuments = {
    durableSchemas: {
      "schemas/setup-state.schema.json": { properties: { sessionId: { type: "string" }, credentialReentryRequired: { type: "boolean" } } },
    },
    testEnvironment: {
      cloudflare: {
        available: true,
        apiTokenEnv: "TOOLSPAN_E2E_CF_API_TOKEN",
        globalEmailEnv: "TOOLSPAN_E2E_CF_GLOBAL_EMAIL",
        globalKeyEnv: "CloudFlareAPIKEY",
      },
    },
  };
  assert.deepEqual(analyzeSetupSecurity(safeFiles, safeDocuments), []);
  assert.deepEqual(analyzeTestEnvironmentManifest(safeDocuments.testEnvironment), []);
  assert.deepEqual(
    analyzeTestEnvironmentManifest({ cloudflare: { apiTokenEnv: "UNRELATED_CREDENTIAL_ENV" } }),
    ["TEST_ENVIRONMENT_INVALID_SECRET_ENV_NAME"],
  );

  const unsafeFiles = [{
    relativePath: "src/setup/cloudflared-adapter.ts",
    text: [
      "const API = 'https://api.cloudflare.com/client/v4';",
      "function redact() {}",
      "const leaked = 'Bearer abcdefghijklmnopqrstuvwxyz123456';",
      "spawn('cloudflared', ['--token', tunnelToken]);",
    ].join("\n"),
  }];
  const violations = analyzeSetupSecurity(unsafeFiles, {
    durableSchemas: { "schemas/setup-receipt.schema.json": { properties: { apiToken: { type: "string" } } } },
    testEnvironment: { apiToken: "abcdefghijklmnopqrstuvwx" },
  });
  assert.ok(violations.some((item) => item.code === "SECRET_VALUE_IN_SETUP_SOURCE"));
  assert.ok(violations.some((item) => item.code === "CREDENTIAL_ON_PROCESS_COMMAND_LINE"));
  assert.ok(violations.some((item) => item.code === "MANAGEMENT_CREDENTIAL_IN_DURABLE_SCHEMA"));
  assert.ok(violations.some((item) => item.code === "TEST_ENVIRONMENT_SECRET_FIELD"));
  assert.ok(violations.every((item) => !JSON.stringify(item).includes("abcdefghijklmnopqrstuvwxyz123456")));
});

test("Setup security PASS reports its selected text boundary instead of claiming packaged-input coverage", async () => {
  const result = createSetupSecurityResult([
    {
      relativePath: "src/setup/cloudflare-fetch-adapter.ts",
      text: "const API = 'https://api.cloudflare.com/client/v4'; function redact() {}",
    },
    {
      relativePath: "apps/desktop/src/tests/setup-page.test.tsx",
      text: "test('fixture', () => {});",
    },
  ], [], { durableSchemaDocumentsAnalyzed: 5 });

  assert.equal(result.status, "PASS");
  assert.ok(result.checks.includes("NO_SECRET_VALUE_PATTERN_IN_SELECTED_NON_TEST_SETUP_TEXT"));
  assert.ok(!result.checks.includes("NO_SECRET_VALUE_IN_SETUP_SOURCE_OR_PACKAGED_INPUTS"));
  assert.deepEqual(result.scanScope, {
    roots: [
      "src/setup",
      "apps/desktop/src",
      "apps/desktop/src-tauri/src",
      "schemas",
      "config",
      "docs/setup",
      "docs/prompts",
      "examples",
    ],
    textExtensions: [".json", ".md", ".mjs", ".ps1", ".rs", ".ts", ".tsx"],
    excludedDirectoryNames: [".git", ".toolspan-dev", "dist", "node_modules", "target", "vendor-inputs"],
    secretValueExcludedPathClasses: ["tests", "fixtures", "__tests__", "*.spec.*", "*.test.*"],
    packagedInputsIncluded: false,
  });
  assert.equal(result.selectedTextFilesAnalyzed, 2);
  assert.equal(result.productionSourceTextFilesAnalyzed, 2);
  assert.equal(result.secretValueTextFilesScanned, 1);
  assert.equal(result.secretValueTextFilesExcludedAsTests, 1);
  assert.equal(result.durableSchemaDocumentsAnalyzed, 5);
  assert.equal(result.secretValuePatternFindings, 0);
  assert.equal(Object.hasOwn(result, "secretValuesFound"), false);
});

test("Desktop v0.5 security freezes setup methods and permits credentials only in four optional Rust-injected requests", async () => {
  const files = [{
    relativePath: "apps/desktop/src-tauri/src/lib.rs",
    text: [
      "struct OwnedChild { child: std::process::Child, ownership_nonce: String }",
      "fn hash_owner_password() { bcrypt::hash(\"value\", 12); }",
      "fn atomic_config(expected_hash: String) { rename(); backup(); }",
      "fn renderer_supplied_credential(params: Map) { params.contains_key(\"credential\"); }",
      "fn inject_setup_credential() {}",
    ].join("\n"),
  }];
  const protocolSchema = JSON.parse(await readFile(
    path.join(projectRoot, "schemas", "desktop-protocol.v1.schema.json"),
    "utf8",
  ));
  const base = {
    rootPackage: { version: "0.5.0", dependencies: {}, devDependencies: {} },
    rootLock: { packages: {} },
    tauriConfig: { app: { security: { csp: "default-src 'self'" } } },
    cargoManifest: "bcrypt = '=0.17.1'",
    capabilities: [{ name: "main.json", document: { permissions: ["core:default", "setup"] } }],
  };
  assert.deepEqual(analyzeSetupCredentialProtocol(protocolSchema), []);
  assert.deepEqual(analyzeDesktopSecurity(files, {
    ...base,
    protocolSchema,
  }), []);

  const unsafeSchema = structuredClone(protocolSchema);
  unsafeSchema.$defs.unknownSetupRequest = {
    type: "object",
    properties: { method: { enum: ["setup.runShell", "cloudflare.proxy"] } },
  };
  unsafeSchema.$defs.setupGetSnapshotRequest.properties.params.properties.credential = {
    $ref: "#/$defs/setupCredential",
  };
  const violations = analyzeDesktopSecurity(files, {
    ...base,
    protocolSchema: unsafeSchema,
  });
  assert.ok(violations.some((item) => item.code === "PROTOCOL_METHOD_OUTSIDE_V0_4"));
  assert.ok(violations.some((item) => item.code === "SETUP_METHOD_OUTSIDE_V0_5"));
  assert.ok(violations.some((item) => item.code === "SETUP_CREDENTIAL_FIELD_OUTSIDE_ALLOWED_REQUEST"));
  assert.ok(violations.some((item) => item.code === "SETUP_CREDENTIAL_REF_OUTSIDE_ALLOWED_REQUEST"));
});

test("requirements matrix contains every Setup Goal ID as a deterministic source-completion gate", async () => {
  const requirements = JSON.parse(await readFile(path.join(projectRoot, "goal", "requirements.json"), "utf8"));
  const setup = requirements.requirements.filter((item) => item.stage === "SETUP");
  const setupById = new Map(setup.map((item) => [item.id, item]));
  assert.equal(new Set(setup.map((item) => item.id)).size, setup.length);
  assert.deepEqual(
    SETUP_GOAL_IDS.filter((id) => !setupById.has(id)),
    [],
  );
  for (const id of SETUP_GOAL_IDS) {
    const requirement = setupById.get(id);
    assert.equal(requirement.gateType, "deterministic", id);
    assert.ok(requirement.blockingFor.includes("SETUP_IMPLEMENTATION_COMPLETE"), id);
    assert.match(requirement.verificationCommand, /^npm run [a-z0-9:-]+$/u, id);
  }
});

test("Setup CI has Ubuntu and Windows Node 24 source jobs and supplies no external credential", async () => {
  const workflow = JSON.parse(await readFile(path.join(projectRoot, ".github", "workflows", "core.yml"), "utf8"));
  const setup = workflow.jobs["setup-source"];
  assert.equal(setup["runs-on"], "${{ matrix.os }}");
  assert.deepEqual(
    new Set(setup.strategy.matrix.include.map((entry) => `${entry.os}|${entry.node}`)),
    new Set(["ubuntu-latest|24.x", "windows-latest|24.x"]),
  );
  const commands = setup.steps.filter((step) => typeof step.run === "string").map((step) => step.run);
  assert.ok(commands.includes("npm ci"));
  assert.ok(commands.some((command) => command.includes("ripgrep")));
  assert.ok(commands.some((command) => command.includes("examples/goal-state.example.json")
    && command.includes(".toolspan-dev/goal-state.json")));
  assert.ok(commands.includes("npm run verify:setup"));
  const source = JSON.stringify(setup);
  assert.doesNotMatch(source, /(?:CloudFlareAPIKEY|CLOUDFLARE_API_TOKEN|GLOBAL_API_KEY|\bsecrets\b)/iu);
});
