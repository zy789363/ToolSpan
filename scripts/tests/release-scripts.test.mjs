import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import {
  analyzeTestEnvironment,
  checkTestEnvironment,
  defaultSchemaPath,
} from "../check-test-environment.mjs";
import {
  cargoComponentsFromMetadata,
  createCycloneDxSbom,
  createSpdxSbom,
  deduplicateComponents,
  npmComponentsFromLock,
  releaseCommandPlan,
  scanNativeInstallerRawAsciiUtf16Patterns,
  scanNpmTarball,
  scanReleaseText,
  validatePackedFiles,
  validateCycloneDx16Sbom,
  validateReleaseCommandPlan,
  validateReleaseLifecycleScripts,
  validateSpdx23Sbom,
} from "../release-dry-run.mjs";
import {
  RELEASE_CLAIM_POLICY,
  RELEASE_GATE_MATRIX,
  RELEASE_GATE_MAX_AGE_DAYS,
  claimPolicyFromOpenAiSnapshot,
  countExternalGatesPromotedWithoutEvidence,
  evaluateReleaseGates,
  summarizeReleaseReadiness,
  validateLatestDryRunPointer,
  validateManualGateEvidence,
  verifyRelease,
} from "../verify-release.mjs";
import {
  REQUIRED_SOURCE_SCRIPTS,
  projectRoot,
  validateAllSourcePackageScripts,
  verifyAllSource,
} from "../verify-all-source.mjs";

function sourcePackage() {
  return {
    scripts: Object.fromEntries(REQUIRED_SOURCE_SCRIPTS.map((name) => [
      name,
      `node scripts/${name.replaceAll(":", "-")}.mjs`,
    ])),
  };
}

function releaseGate(id) {
  return RELEASE_GATE_MATRIX.find((entry) => entry.id === id);
}

function manualPass(requirementId, proof, observedAt = "2026-08-21T00:00:00Z") {
  return {
    schemaVersion: "1.0",
    requirementId,
    status: "PASS",
    observedAt,
    sanitized: true,
    secretValues: 0,
    proof,
  };
}

const CURRENT_RELEASE_CONTEXT = Object.freeze({
  toolSpanVersion: "0.5.0",
  msiSha256: "d".repeat(64),
  nsisSha256: "e".repeat(64),
  affiliateSnapshotSha256: "f".repeat(64),
  openAiSnapshotSha256: "1".repeat(64),
});

function tarOctal(value, width) {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function syntheticNpmTarball(entries) {
  const chunks = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? []);
    const header = Buffer.alloc(512);
    header.write(`package/${entry.path}`, 0, 100, "utf8");
    header.write(tarOctal(0o644, 8), 100, 8, "ascii");
    header.write(tarOctal(0, 8), 108, 8, "ascii");
    header.write(tarOctal(0, 8), 116, 8, "ascii");
    if (entry.rawSizeField === undefined) header.write(tarOctal(content.length, 12), 124, 12, "ascii");
    else Buffer.from(entry.rawSizeField).copy(header, 124, 0, 12);
    header.write(tarOctal(0, 12), 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header.write(entry.type ?? "0", 156, 1, "ascii");
    if (entry.linkName !== undefined) header.write(entry.linkName, 157, 100, "utf8");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
    chunks.push(header, content, padding);
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

function utf16Be(value) {
  const bytes = Buffer.from(value, "utf16le");
  for (let index = 0; index < bytes.length; index += 2) {
    [bytes[index], bytes[index + 1]] = [bytes[index + 1], bytes[index]];
  }
  return bytes;
}

test("verify:all:source runs goal, Core, Desktop and Setup leaves in order without recursion", async () => {
  assert.deepEqual(validateAllSourcePackageScripts(sourcePackage()), []);
  const recursive = sourcePackage();
  recursive.scripts["verify:setup"] = "npm run verify:all:source";
  assert.deepEqual(validateAllSourcePackageScripts(recursive), ["SOURCE_SCRIPT_RECURSION:verify:setup"]);

  const calls = [];
  const result = await verifyAllSource({
    nodeVersion: "24.1.0",
    packageDocument: sourcePackage(),
    npmCli: "C:\\node\\npm-cli.js",
    runUnitTests: async () => { calls.push("release-script-tests"); },
    runRoot: async (script) => { calls.push(script); },
  });
  assert.equal(result.status, "PASS");
  assert.equal(result.shell, false);
  assert.equal(result.externalGatesPromotedToPass, 0);
  assert.deepEqual(calls, [
    "release-script-tests",
    "goal:check",
    "verify:core",
    "verify:desktop:source",
    "verify:setup",
  ]);
});

test("release dry-run command plan only builds and packs through resolved executables", () => {
  const npmCli = path.join("C:\\Program Files\\nodejs", "node_modules", "npm", "bin", "npm-cli.js");
  const plan = releaseCommandPlan(npmCli, path.join(projectRoot, ".toolspan-dev", "evidence", "release", "run-test", "package"));
  assert.deepEqual(validateReleaseCommandPlan(plan), []);
  assert.deepEqual(plan.map((entry) => entry.id), ["CORE_BUILD", "DESKTOP_RENDERER_BUILD", "NPM_PACK"]);
  assert.ok(plan.every((entry) => entry.command === process.execPath));
  const allArguments = plan.flatMap((entry) => entry.arguments);
  assert.equal(allArguments.some((argument) => /^(?:publish|version|tag|release)$/iu.test(argument)), false);
  assert.ok(plan.find((entry) => entry.id === "NPM_PACK").arguments.includes("--ignore-scripts"));
});

test("Cargo SBOM metadata plan is locked, offline and filtered to the Windows x64 release target", async () => {
  const releaseModule = await import("../release-dry-run.mjs");
  const cargo = "C:\\Rust\\bin\\cargo.exe";
  const plan = releaseModule.cargoMetadataCommandPlan(cargo);

  assert.deepEqual(plan, [{
    id: "CARGO_METADATA",
    command: cargo,
    arguments: [
      "metadata",
      "--locked",
      "--offline",
      "--filter-platform",
      "x86_64-pc-windows-msvc",
      "--format-version",
      "1",
      "--manifest-path",
      "Cargo.toml",
    ],
    cwd: path.join(projectRoot, "apps", "desktop", "src-tauri"),
    capture: true,
  }]);
  assert.deepEqual(releaseModule.validateCargoMetadataCommandPlan(plan, cargo), []);
});

test("Cargo SBOM metadata plan rejects a missing platform filter", async () => {
  const releaseModule = await import("../release-dry-run.mjs");
  const cargo = "C:\\Rust\\bin\\cargo.exe";
  const plan = releaseModule.cargoMetadataCommandPlan(cargo);
  plan[0].arguments.splice(plan[0].arguments.indexOf("--filter-platform"), 2);

  assert.ok(
    releaseModule.validateCargoMetadataCommandPlan(plan, cargo)
      .includes("CARGO_METADATA:FILTER_PLATFORM_REQUIRED"),
  );
});

test("Cargo SBOM metadata plan rejects a target other than Windows x64 MSVC", async () => {
  const releaseModule = await import("../release-dry-run.mjs");
  const cargo = "C:\\Rust\\bin\\cargo.exe";
  const plan = releaseModule.cargoMetadataCommandPlan(cargo);
  const filterIndex = plan[0].arguments.indexOf("--filter-platform");
  plan[0].arguments[filterIndex + 1] = "x86_64-unknown-linux-gnu";

  assert.ok(
    releaseModule.validateCargoMetadataCommandPlan(plan, cargo)
      .includes("CARGO_METADATA:TARGET_NOT_ALLOWLISTED"),
  );
});

test("Cargo SBOM metadata plan rejects weakened offline locking and unexpected arguments", async () => {
  const releaseModule = await import("../release-dry-run.mjs");
  const cargo = "C:\\Rust\\bin\\cargo.exe";
  for (const required of ["--locked", "--offline"]) {
    const plan = releaseModule.cargoMetadataCommandPlan(cargo);
    plan[0].arguments.splice(plan[0].arguments.indexOf(required), 1);
    assert.ok(
      releaseModule.validateCargoMetadataCommandPlan(plan, cargo)
        .includes("CARGO_METADATA:LOCKED_OFFLINE_REQUIRED"),
      required,
    );
  }

  const unexpected = releaseModule.cargoMetadataCommandPlan(cargo);
  unexpected[0].arguments.push("--all-features");
  assert.ok(
    releaseModule.validateCargoMetadataCommandPlan(unexpected, cargo)
      .includes("CARGO_METADATA:ARGUMENTS_NOT_ALLOWLISTED"),
  );
});

test("release dry-run rejects lifecycle drift before executing root or Desktop builds", () => {
  const rootPackage = {
    scripts: {
      prebuild: "node scripts/clean-dist.mjs",
      build: "tsc -p tsconfig.build.json",
      postbuild: "node scripts/bundle-desktop-host.mjs",
    },
  };
  const desktopPackage = {
    scripts: {
      build: "tsc -p tsconfig.json --noEmit && vite build",
    },
  };
  assert.deepEqual(validateReleaseLifecycleScripts(rootPackage, desktopPackage), []);
  assert.deepEqual(
    validateReleaseLifecycleScripts(
      { scripts: { ...rootPackage.scripts, postbuild: "npm publish" } },
      desktopPackage,
    ),
    ["ROOT_POSTBUILD_NOT_ALLOWLISTED"],
  );
  assert.deepEqual(
    validateReleaseLifecycleScripts(
      rootPackage,
      { scripts: { ...desktopPackage.scripts, prebuild: "git tag unsafe" } },
    ),
    ["DESKTOP_PREBUILD_NOT_ALLOWLISTED"],
  );
});

test("repository ignores root dotenv files and every dotenv variant", async () => {
  const rules = (await readFile(path.join(projectRoot, ".gitignore"), "utf8"))
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  assert.ok(rules.includes(".env"), "root .env must be ignored");
  assert.ok(rules.includes(".env.*"), "root .env.* variants must be ignored");
  assert.ok(rules.includes("/state/"), "runtime state must be ignored only at repository root");
  assert.ok(!rules.includes("state/"), "nested source state directories must remain trackable");
  const attributes = await readFile(path.join(projectRoot, ".gitattributes"), "utf8");
  assert.match(attributes, /^tests\/e2e-fixtures\/remote-workspace\/writable\.txt text eol=lf$/mu);
});

test("package policy rejects nested .env segments without rejecting .environment", () => {
  const allowlist = { required: [], allowedExact: [], allowedPrefixes: ["config/", "docs/"] };
  assert.deepEqual(validatePackedFiles([
    { path: "config/.env.local" },
    { path: "docs/nested/.env" },
    { path: "docs/.env.production/value.txt" },
  ], allowlist), [
    "PACKAGE_FORBIDDEN_FILE:config/.env.local",
    "PACKAGE_FORBIDDEN_FILE:docs/nested/.env",
    "PACKAGE_FORBIDDEN_FILE:docs/.env.production/value.txt",
  ]);
  assert.deepEqual(validatePackedFiles([{ path: "config/.environment" }], allowlist), []);
});

test("release package policy requires the production shrinkwrap in the actual tarball", async () => {
  const allowlist = JSON.parse(await readFile(
    path.join(projectRoot, "scripts", "release-package-allowlist.json"),
    "utf8",
  ));
  assert.ok(allowlist.required.includes("npm-shrinkwrap.json"));
  assert.ok(allowlist.allowedExact.includes("npm-shrinkwrap.json"));
  assert.ok(validatePackedFiles([], allowlist).includes(
    "PACKAGE_REQUIRED_FILE_MISSING:npm-shrinkwrap.json",
  ));
});

test("native bundle selection accepts only exact current ToolSpan release artifacts", async () => {
  const releaseModule = await import("../release-dry-run.mjs");
  const selection = releaseModule.selectNativeBundleCandidates([
    {
      targetName: "ToolSpan_0.5.0_x64-setup.exe",
      source: "apps/desktop/src-tauri/target/debug/bundle/nsis/ToolSpan_0.5.0_x64-setup.exe",
      sourceProfile: "debug",
    },
    {
      targetName: "ToolSpan_0.5.0_x64-setup.exe",
      source: "apps/desktop/src-tauri/target/release/bundle/nsis/ToolSpan_0.5.0_x64-setup.exe",
      sourceProfile: "release",
    },
    {
      targetName: "ToolSpan_0.5.0_x64_en-US.msi",
      source: "apps/desktop/src-tauri/target/debug/bundle/msi/ToolSpan_0.5.0_x64_en-US.msi",
      sourceProfile: "debug",
    },
    {
      targetName: "ToolSpan_0.5.0_x64_en-US.msi",
      source: "apps/desktop/src-tauri/target/release/bundle/msi/ToolSpan_0.5.0_x64_en-US.msi",
      sourceProfile: "release",
    },
    {
      targetName: "ToolSpan_0.4.0_x64-setup.exe",
      source: "apps/desktop/src-tauri/target/debug/bundle/nsis/ToolSpan_0.4.0_x64-setup.exe",
      sourceProfile: "debug",
    },
    {
      targetName: "ToolSpan_0.4.0_x64-setup.exe",
      source: "apps/desktop/src-tauri/target/release/bundle/nsis/ToolSpan_0.4.0_x64-setup.exe",
      sourceProfile: "release",
    },
    {
      targetName: "Other_0.5.0_x64-setup.exe",
      source: "apps/desktop/src-tauri/target/release/bundle/nsis/Other_0.5.0_x64-setup.exe",
      sourceProfile: "release",
    },
    {
      targetName: "ToolSpan_10.5.0_x64-setup.exe",
      source: "apps/desktop/src-tauri/target/release/bundle/nsis/ToolSpan_10.5.0_x64-setup.exe",
      sourceProfile: "release",
    },
    {
      targetName: "ToolSpan_0.5.0_x64.zip",
      source: "apps/desktop/src-tauri/target/release/bundle/updater/ToolSpan_0.5.0_x64.zip",
      sourceProfile: "release",
    },
    {
      targetName: "ToolSpan_0.5.0_x64-setup.exe",
      source: "apps/desktop/src-tauri/target/release/bundle/updater/ToolSpan_0.5.0_x64-setup.exe",
      sourceProfile: "release",
    },
  ], "0.5.0");

  assert.deepEqual(new Set(selection.current.map((entry) => entry.targetName)), new Set([
    "ToolSpan_0.5.0_x64-setup.exe",
    "ToolSpan_0.5.0_x64_en-US.msi",
  ]));
  assert.ok(selection.current.every((entry) => (
    entry.sourceProfile === "release" && entry.selection === "RELEASE_SHIPPING_ARTIFACT"
  )));
  assert.deepEqual(selection.stale.map((entry) => entry.targetName).sort(), [
    "ToolSpan_0.4.0_x64-setup.exe",
    "ToolSpan_0.4.0_x64-setup.exe",
    "ToolSpan_10.5.0_x64-setup.exe",
  ]);
  assert.equal(selection.rejected.length, 5);
  assert.deepEqual(new Set(selection.rejected.map((entry) => entry.rejection)), new Set([
    "PROFILE_NOT_RELEASE",
    "SOURCE_PATH_MISMATCH",
    "TARGET_NOT_ALLOWLISTED",
  ]));
});

test("test-environment v2 accepts only flags, IDs and environment references and reports zero Secret values", async () => {
  const [schema, manifest] = await Promise.all([
    readFile(defaultSchemaPath, "utf8").then(JSON.parse),
    readFile(path.join(projectRoot, "examples", "test-environment.example.json"), "utf8").then(JSON.parse),
  ]);
  manifest.cloudflare.globalKeyEnv = "CloudFlareAPIKEY";
  const safe = analyzeTestEnvironment(manifest, schema);
  assert.deepEqual(safe.errors, []);
  assert.equal(safe.secretValues, 0);

  const unexpectedKey = "synthetic-unexpected-field-marker";
  const syntheticSecret = "sk-synthetic-value-that-must-never-appear-123456789";
  const unsafe = structuredClone(manifest);
  unsafe.cloudflare[unexpectedKey] = syntheticSecret;
  const result = analyzeTestEnvironment(unsafe, schema);
  assert.ok(result.errors.includes("testEnvironment.cloudflare:UNEXPECTED_FIELD"));
  assert.ok(result.errors.includes("testEnvironment:SECRET_VALUE_FORBIDDEN"));
  const serializedFindings = JSON.stringify(result.errors);
  assert.equal(serializedFindings.includes(unexpectedKey), false);
  assert.equal(serializedFindings.includes(syntheticSecret), false);
  assert.equal(result.secretValues, 1);

  const rawEnvironmentValue = structuredClone(manifest);
  rawEnvironmentValue.cloudflare.globalKeyEnv = "abcdef0123456789abcdef0123456789abcdef0";
  const rawResult = analyzeTestEnvironment(rawEnvironmentValue, schema);
  assert.ok(rawResult.errors.some((item) => item.includes("globalKeyEnv:EXPECTED_ENVIRONMENT_VARIABLE_NAME")));
  assert.ok(rawResult.errors.includes("testEnvironment:SECRET_VALUE_FORBIDDEN"));
  assert.equal(rawResult.secretValues, 1);
});

test("test-environment reports Secret scanning as not performed when input is unavailable or malformed", async () => {
  const schemaText = await readFile(defaultSchemaPath, "utf8");
  const missingError = Object.assign(new Error("synthetic missing manifest"), { code: "ENOENT" });
  const cases = [
    {
      name: "missing",
      readFile: async () => { throw missingError; },
    },
    {
      name: "malformed",
      readFile: async (filePath) => filePath === "manifest.json" ? "{" : schemaText,
    },
  ];

  for (const scenario of cases) {
    const result = await checkTestEnvironment({
      manifestPath: "manifest.json",
      schemaPath: "schema.json",
      readFile: scenario.readFile,
    });
    assert.equal(result.secretValues, null, scenario.name);
    assert.equal(result.secretScan, "NOT_PERFORMED", scenario.name);
  }
});

test("SPDX and CycloneDX evidence is built from npm lock entries and Cargo metadata without local paths", () => {
  const components = deduplicateComponents([
    ...npmComponentsFromLock({ packages: {
      "": { name: "toolspan-mcp", version: "0.5.0" },
      "node_modules/zod": { version: "4.4.3", license: "MIT" },
    } }, "package-lock.json"),
    ...cargoComponentsFromMetadata({ packages: [{
      name: "serde",
      version: "1.0.228",
      license: "MIT OR Apache-2.0",
      manifest_path: "C:\\Users\\someone\\registry\\serde\\Cargo.toml",
    }] }),
    {
      ecosystem: "npm",
      name: "freeform-license-example",
      version: "1.0.0",
      license: "Company permissive terms",
      development: false,
      sourceName: "package-lock.json",
    },
  ]);
  const spdx = createSpdxSbom({
    packageName: "toolspan-mcp",
    packageVersion: "0.5.0",
    components,
    createdAt: "2026-08-21T00:00:00.000Z",
    namespace: "urn:uuid:00000000-0000-4000-8000-000000000000",
  });
  const cyclone = createCycloneDxSbom({
    packageName: "toolspan-mcp",
    packageVersion: "0.5.0",
    components,
    createdAt: "2026-08-21T00:00:00.000Z",
    serialNumber: "urn:uuid:00000000-0000-4000-8000-000000000001",
  });
  assert.equal(spdx.spdxVersion, "SPDX-2.3");
  assert.deepEqual(spdx.documentDescribes, spdx.packages.map((item) => item.SPDXID));
  assert.equal(cyclone.bomFormat, "CycloneDX");
  assert.ok(components.some((item) => item.ecosystem === "npm"));
  assert.ok(components.some((item) => item.ecosystem === "cargo"));
  assert.deepEqual(
    cyclone.components.find((item) => item.name === "zod").licenses,
    [{ license: { id: "MIT" } }],
  );
  assert.deepEqual(
    cyclone.components.find((item) => item.name === "serde").licenses,
    [{ expression: "MIT OR Apache-2.0" }],
  );
  assert.deepEqual(
    cyclone.components.find((item) => item.name === "freeform-license-example").licenses,
    [{ license: { name: "Company permissive terms" } }],
  );
  assert.equal(
    spdx.packages.find((item) => item.name === "freeform-license-example").licenseDeclared,
    "NOASSERTION",
  );
  assert.deepEqual(validateSpdx23Sbom(spdx), []);
  assert.deepEqual(validateCycloneDx16Sbom(cyclone), []);
  const invalidCyclone = structuredClone(cyclone);
  invalidCyclone.components.find((item) => item.name === "serde").licenses = [{
    license: { id: "MIT OR Apache-2.0" },
  }];
  assert.ok(validateCycloneDx16Sbom(invalidCyclone).includes("CYCLONEDX_LICENSE_ID_INVALID"));
  assert.ok(validateSpdx23Sbom({ ...spdx, spdxVersion: "SPDX-2.2" }).includes("SPDX_VERSION_INVALID"));
  const missingDescribes = structuredClone(spdx);
  delete missingDescribes.documentDescribes;
  assert.ok(validateSpdx23Sbom(missingDescribes).includes("SPDX_DOCUMENT_DESCRIBES_INVALID"));
  assert.doesNotMatch(JSON.stringify([spdx, cyclone]), /C:\\Users\\someone/iu);
});

test("release scan returns only finding locations and codes, never matched content", () => {
  const text = "token=sk-example-value-that-is-long-enough-123456789 C:\\Users\\private-name\\project";
  const findings = scanReleaseText(text, "dist/example.js", ["C:\\Users\\private-name"]);
  assert.deepEqual(findings, [
    { path: "dist/example.js", code: "SECRET_LIKE_VALUE" },
    { path: "dist/example.js", code: "PERSONAL_ABSOLUTE_PATH" },
  ]);
  assert.doesNotMatch(JSON.stringify(findings), /private-name|example-value/iu);
});

test("actual npm tarball scan catches extensionless UTF-8 and UTF-16LE/BE Secret values without echoing them", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "toolspan-release-tar-test-"));
  const tarballPath = path.join(temporaryRoot, "synthetic.tgz");
  const extractionRoot = path.join(temporaryRoot, "extracted");
  const utf8Secret = ["sk", "synthetic-extensionless-value-1234567890"].join("-");
  const utf16Secret = ["ghp", "SyntheticUtf16Value12345678901234567890"].join("_");
  const utf16BeSecret = ["sk", "synthetic-installer-utf16be-value-1234567890"].join("-");
  try {
    const tarballBytes = syntheticNpmTarball([
      { path: "LICENSE", content: Buffer.from(`notice ${utf8Secret}`, "utf8") },
      { path: "docs/utf16.txt", content: Buffer.from(
        `${"前言".repeat(500)} notice ${utf16Secret}`,
        "utf16le",
      ) },
      { path: "docs/utf16be.txt", content: utf16Be(
        `${"前言".repeat(500)} notice ${utf16BeSecret}`,
      ) },
    ]);
    await writeFile(tarballPath, tarballBytes);
    const result = await scanNpmTarball({
      tarballPath,
      extractionRoot,
      expectedFiles: ["LICENSE", "docs/utf16.txt", "docs/utf16be.txt"],
    });
    assert.equal(result.status, "FAIL");
    assert.equal(result.packageFilesEnumerated, 3);
    assert.equal(result.packageFilesContentScanned, 3);
    assert.equal(result.packageFilesBinarySkipped, 0);
    assert.equal(result.tarballBytes, tarballBytes.length);
    assert.equal(
      result.tarballSha256,
      createHash("sha256").update(tarballBytes).digest("hex"),
    );
    assert.deepEqual(result.findings, [
      { path: "LICENSE", code: "SECRET_LIKE_VALUE" },
      { path: "docs/utf16.txt", code: "SECRET_LIKE_VALUE" },
      { path: "docs/utf16be.txt", code: "SECRET_LIKE_VALUE" },
    ]);
    assert.equal(JSON.stringify(result).includes(utf8Secret), false);
    assert.equal(JSON.stringify(result).includes(utf16Secret), false);
    assert.equal(JSON.stringify(result).includes(utf16BeSecret), false);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("actual npm tarball scan explains every binary skip with MIME and reason", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "toolspan-release-binary-test-"));
  const tarballPath = path.join(temporaryRoot, "synthetic.tgz");
  try {
    await writeFile(tarballPath, syntheticNpmTarball([
      { path: "assets/logo.png", content: Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff,
      ]) },
    ]));
    const result = await scanNpmTarball({
      tarballPath,
      extractionRoot: path.join(temporaryRoot, "extracted"),
      expectedFiles: ["assets/logo.png"],
    });
    assert.equal(result.status, "PASS");
    assert.equal(result.packageFilesEnumerated, 1);
    assert.equal(result.packageFilesContentScanned, 0);
    assert.equal(result.packageFilesBinarySkipped, 1);
    assert.equal(result.packageFilesUnexplainedSkipped, 0);
    assert.deepEqual(result.packageFileBinarySkipDetails, [{
      path: "assets/logo.png",
      mime: "image/png",
      reason: "BINARY_MAGIC_PNG",
    }]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("npm tarball extraction rejects path traversal, links and device entries", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "toolspan-release-unsafe-tar-test-"));
  try {
    for (const [name, entry, code] of [
      ["traversal", { path: "../escape", content: Buffer.from("blocked") }, "NPM_TARBALL_PATH_UNSAFE"],
      ["link", { path: "linked", type: "2", linkName: "package/LICENSE" }, "NPM_TARBALL_ENTRY_TYPE_FORBIDDEN"],
      ["device", { path: "device", type: "3" }, "NPM_TARBALL_ENTRY_TYPE_FORBIDDEN"],
      ["nul-spliced-size", {
        path: "nul-spliced-size",
        rawSizeField: Buffer.from([
          0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x00, 0x32, 0x00, 0x20,
        ]),
      }, "NPM_TARBALL_OCTAL_INVALID"],
    ]) {
      const tarballPath = path.join(temporaryRoot, `${name}.tgz`);
      await writeFile(tarballPath, syntheticNpmTarball([entry]));
      await assert.rejects(
        scanNpmTarball({
          tarballPath,
          extractionRoot: path.join(temporaryRoot, `extracted-${name}`),
        }),
        (error) => error?.code === code,
        name,
      );
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("native installer evidence is explicitly limited to raw ASCII and UTF-16LE pattern scans", () => {
  const asciiSecret = ["github", "pat", "SyntheticAsciiInstallerValue1234567890"].join("_");
  const utf16Secret = ["sk", "synthetic-installer-utf16-value-1234567890"].join("-");
  const ascii = scanNativeInstallerRawAsciiUtf16Patterns(
    Buffer.from(`header ${asciiSecret} trailer`, "ascii"),
    "desktop-native/example.msi",
  );
  const utf16 = scanNativeInstallerRawAsciiUtf16Patterns(
    Buffer.concat([Buffer.from([0x7f]), Buffer.from(`header ${utf16Secret} trailer`, "utf16le")]),
    "desktop-native/example.exe",
  );
  for (const result of [ascii, utf16]) {
    assert.equal(result.status, "FAIL");
    assert.equal(result.scope, "RAW_INSTALLER_FILE_BYTES_ONLY");
    assert.deepEqual(result.encodings, ["ASCII", "UTF-16LE"]);
    assert.deepEqual(result.utf16LeByteAlignments, [0, 1]);
    assert.equal(result.compressedPayloadCoverage, false);
    assert.equal(result.limitation, "COMPRESSED_OR_ENCRYPTED_PAYLOADS_NOT_INSPECTED");
    assert.deepEqual(result.findings, [{
      path: result === ascii ? "desktop-native/example.msi" : "desktop-native/example.exe",
      code: "SECRET_LIKE_VALUE",
    }]);
  }
  assert.equal(JSON.stringify([ascii, utf16]).includes(asciiSecret), false);
  assert.equal(JSON.stringify([ascii, utf16]).includes(utf16Secret), false);
});

test("04 Release matrix is exact and missing evidence never becomes PASS", async () => {
  assert.deepEqual(RELEASE_GATE_MATRIX.map((entry) => entry.id), [
    "E-OWNER-01",
    "E-GH-01",
    "E-WIN-01",
    "E-SIGN-01",
    "E-CF-TOKEN-01",
    "E-CF-GLOBAL-01",
    "E-CF-WIN-01",
    "E-HOST-01",
    "E-CODEX-01",
    "E-CGPT-UI-01",
    "E-OAUTH-SOAK-01",
    "E-AFF-01",
    "E-ASSET-01",
    "E-DATA-01",
  ]);
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  const gates = await evaluateReleaseGates({
    licenseText: "TOOLSPAN LICENSE — OWNER GATE\nStatus: BLOCKED_BY_OWNER_INPUT.",
    readFile: async () => { throw missing; },
  });
  assert.ok(gates.every((gate) => gate.status !== "PASS"));
  const readiness = summarizeReleaseReadiness(gates);
  assert.equal(readiness.releaseReady, false);
  assert.deepEqual(readiness.requiredPending, ["E-OWNER-01", "E-GH-01", "E-WIN-01", "E-HOST-01", "E-CODEX-01"]);
  assert.deepEqual(readiness.activeConditionalPending.map((entry) => entry.id), [
    "E-CF-TOKEN-01",
    "E-DATA-01",
  ]);
  assert.deepEqual(readiness.inactiveConditionalFallbacks.map((entry) => entry.id), [
    "E-CF-WIN-01", "E-AFF-01", "E-ASSET-01",
  ]);

  assert.equal(validateManualGateEvidence({
    schemaVersion: "1.0",
    requirementId: "E-CODEX-01",
    status: "PASS",
    observedAt: "2026-08-21T00:00:00Z",
    sanitized: true,
    secretValues: 0,
  }, RELEASE_GATE_MATRIX.find((entry) => entry.id === "E-CODEX-01")), false);
});

test("E-CODEX-01 PASS proves remote read, write and job while the local fixture stays unchanged", () => {
  const proof = {
    kind: "CODEX_REMOTE_E2E",
    remoteInstanceUrl: "https://mcp.aiqushi.top/mcp",
    devspaceInfoConfirmed: true,
    toolCount: 27,
    readPassed: true,
    writePassed: true,
    jobPassed: true,
    remoteBeforeSha256: "a".repeat(64),
    remoteAfterSha256: "b".repeat(64),
    localBeforeSha256: "c".repeat(64),
    localAfterSha256: "c".repeat(64),
  };
  assert.equal(validateManualGateEvidence(
    manualPass("E-CODEX-01", proof),
    releaseGate("E-CODEX-01"),
  ), true);
  assert.equal(validateManualGateEvidence(
    manualPass("E-CODEX-01", { ...proof, remoteAfterSha256: proof.remoteBeforeSha256 }),
    releaseGate("E-CODEX-01"),
  ), false);
  assert.equal(validateManualGateEvidence(
    manualPass("E-CODEX-01", { ...proof, localAfterSha256: "d".repeat(64) }),
    releaseGate("E-CODEX-01"),
  ), false);
});

test("E-HOST-01 PASS proves the complete official Inspector protocol sequence", () => {
  const proof = {
    kind: "MCP_INSPECTOR_E2E",
    inspectorPackage: "@modelcontextprotocol/inspector",
    inspectorVersion: "2.3.0",
    endpoint: "http://127.0.0.1:8787/mcp",
    initializePassed: true,
    toolCount: 27,
    readPassed: true,
    mutationPassed: true,
    insufficientScopePassed: true,
  };
  assert.equal(validateManualGateEvidence(
    manualPass("E-HOST-01", proof),
    releaseGate("E-HOST-01"),
  ), true);
  assert.equal(validateManualGateEvidence(
    manualPass("E-HOST-01", { ...proof, insufficientScopePassed: false }),
    releaseGate("E-HOST-01"),
  ), false);
});

test("E-WIN-01 PASS is bound to both current dry-run installers and all native smokes", () => {
  const proof = {
    kind: "WINDOWS_NATIVE_SMOKE",
    toolSpanVersion: CURRENT_RELEASE_CONTEXT.toolSpanVersion,
    msiSha256: CURRENT_RELEASE_CONTEXT.msiSha256,
    nsisSha256: CURRENT_RELEASE_CONTEXT.nsisSha256,
    installSmokePassed: true,
    traySmokePassed: true,
    ownedProcessSmokePassed: true,
    unrelatedProcessSurvived: true,
  };
  const options = { currentReleaseContext: CURRENT_RELEASE_CONTEXT };
  assert.equal(validateManualGateEvidence(
    manualPass("E-WIN-01", proof),
    releaseGate("E-WIN-01"),
    options,
  ), true);
  assert.equal(validateManualGateEvidence(
    manualPass("E-WIN-01", { ...proof, nsisSha256: "2".repeat(64) }),
    releaseGate("E-WIN-01"),
    options,
  ), false);
  assert.equal(validateManualGateEvidence(
    manualPass("E-WIN-01", { ...proof, unrelatedProcessSurvived: false }),
    releaseGate("E-WIN-01"),
    options,
  ), false);
  assert.equal(validateManualGateEvidence(
    manualPass("E-WIN-01", proof),
    releaseGate("E-WIN-01"),
  ), false);
});

test("Cloudflare API PASS proves the aiqushi.top lifecycle, idempotency, public verify and owned cleanup", () => {
  const common = {
    kind: "CLOUDFLARE_LIFECYCLE",
    zoneName: "aiqushi.top",
    zoneId: "a".repeat(32),
    accountId: "b".repeat(32),
    planHash: "c".repeat(64),
    applyStatus: "APPLIED",
    secondRunDuplicateCreates: 0,
    publicEndpoint: "https://mcp.aiqushi.top/mcp",
    publicHealthPassed: true,
    oauthDiscoveryPassed: true,
    publicToolCount: 27,
    ownedCleanupPassed: true,
  };
  for (const [id, credentialType] of [
    ["E-CF-TOKEN-01", "SCOPED_API_TOKEN"],
    ["E-CF-GLOBAL-01", "GLOBAL_API_KEY"],
  ]) {
    const proof = { ...common, credentialType };
    assert.equal(validateManualGateEvidence(manualPass(id, proof), releaseGate(id)), true, id);
    assert.equal(validateManualGateEvidence(
      manualPass(id, { ...proof, secondRunDuplicateCreates: 1 }),
      releaseGate(id),
    ), false, `${id}: duplicate create`);
    assert.equal(validateManualGateEvidence(
      manualPass(id, { ...proof, zoneName: "example.com" }),
      releaseGate(id),
    ), false, `${id}: wrong zone`);
  }
});

test("every remaining PASS gate requires its own closed proof", () => {
  const native = {
    toolSpanVersion: CURRENT_RELEASE_CONTEXT.toolSpanVersion,
    msiSha256: CURRENT_RELEASE_CONTEXT.msiSha256,
    nsisSha256: CURRENT_RELEASE_CONTEXT.nsisSha256,
  };
  const cases = [
    ["E-OWNER-01", {
      kind: "OWNER_PUBLICATION_APPROVAL",
      publicationApproved: true,
      ipRightsConfirmed: true,
      trademarkConfirmed: true,
      licenseApproved: true,
    }],
    ["E-GH-01", {
      kind: "GITHUB_RELEASE_SETTINGS",
      repositoryUrl: "https://github.com/toolspan/toolspan",
      securityPolicyConfigured: true,
      rulesetConfigured: true,
      defaultBranchProtected: true,
      privateVulnerabilityReportingEnabled: true,
    }],
    ["E-SIGN-01", {
      kind: "WINDOWS_AUTHENTICODE",
      ...native,
      msiSignatureValid: true,
      nsisSignatureValid: true,
      certificateThumbprintSha256: "2".repeat(64),
      timestamped: true,
    }, { currentReleaseContext: CURRENT_RELEASE_CONTEXT }],
    ["E-CF-WIN-01", {
      kind: "CLOUDFLARED_WINDOWS_SERVICE",
      ...native,
      installPassed: true,
      startPassed: true,
      rebootPersistencePassed: true,
      uninstallPassed: true,
      unrelatedServicePreserved: true,
    }, { currentReleaseContext: CURRENT_RELEASE_CONTEXT }],
    ["E-CGPT-UI-01", {
      kind: "CHATGPT_UI_SMOKE",
      accountConfirmed: true,
      endpoint: "https://mcp.aiqushi.top/mcp",
      developerModeVisible: true,
      customMcpUiReachable: true,
      oauthDiscoveryPassed: true,
      toolScanPassed: true,
      toolCount: 27,
      readInvocationPassed: true,
      businessWorkspaceUsed: false,
    }],
    ["E-OAUTH-SOAK-01", {
      kind: "OAUTH_SOAK",
      durationMinutes: 60,
      refreshObserved: true,
      rotationObserved: true,
      scopePreserved: true,
      reconnectPassed: true,
    }],
    ["E-AFF-01", {
      kind: "AFFILIATE_CURRENTNESS",
      snapshotSha256: CURRENT_RELEASE_CONTEXT.affiliateSnapshotSha256,
      officialSourceUrl: "https://www.namesilo.com/pricing",
      affiliateLinkCurrent: true,
      couponCurrent: true,
      offerCurrent: true,
    }, { currentReleaseContext: CURRENT_RELEASE_CONTEXT }],
    ["E-ASSET-01", {
      kind: "VENDOR_ASSET_RIGHTS",
      provider: "namesilo",
      rightsConfirmed: true,
      provenanceConfirmed: true,
      assetSha256s: ["3".repeat(64)],
    }],
    ["E-DATA-01", {
      kind: "OPENAI_QUOTA_CURRENTNESS",
      snapshotSha256: CURRENT_RELEASE_CONTEXT.openAiSnapshotSha256,
      officialSourceCount: 7,
      numericClaimsCurrent: true,
      mcpPlanClaimsCurrent: true,
    }, { currentReleaseContext: CURRENT_RELEASE_CONTEXT }],
  ];
  for (const [id, proof, options = {}] of cases) {
    assert.equal(validateManualGateEvidence(manualPass(id, proof), releaseGate(id), options), true, id);
    assert.equal(validateManualGateEvidence(
      manualPass(id, { ...proof, unexpected: true }),
      releaseGate(id),
      options,
    ), false, `${id}: proof must be closed`);
  }
});

test("manual evidence rejects future and expired observations under a closed per-gate freshness policy", () => {
  assert.deepEqual(
    Object.keys(RELEASE_GATE_MAX_AGE_DAYS).sort(),
    RELEASE_GATE_MATRIX.map((gate) => gate.id).sort(),
  );
  assert.ok(Object.values(RELEASE_GATE_MAX_AGE_DAYS).every(
    (days) => Number.isInteger(days) && days > 0,
  ));
  const gate = releaseGate("E-HOST-01");
  const evidence = {
    schemaVersion: "1.0",
    requirementId: gate.id,
    status: "FAIL",
    observedAt: "2026-08-20T12:00:00Z",
    sanitized: true,
    secretValues: 0,
  };
  const now = new Date("2026-08-21T12:00:00Z");
  assert.equal(validateManualGateEvidence(evidence, gate, { now }), true);
  assert.equal(validateManualGateEvidence(
    { ...evidence, observedAt: "2026-08-21T12:00:00.001Z" },
    gate,
    { now },
  ), false);
  assert.equal(validateManualGateEvidence(
    { ...evidence, observedAt: "2000-01-01T00:00:00Z" },
    gate,
    { now },
  ), false);
});

test("current non-PASS evidence remains compatible with the six-field envelope", () => {
  const now = new Date("2026-08-21T12:00:00Z");
  for (const [id, status] of [
    ["E-HOST-01", "FAIL"],
    ["E-SIGN-01", "NOT_CONFIGURED"],
    ["E-CF-GLOBAL-01", "EXTERNAL_GATE_PENDING"],
    ["E-CGPT-UI-01", "BLOCKED_BY_HOST_PLAN_OR_POLICY"],
    ["E-OAUTH-SOAK-01", "NOT_REQUIRED"],
    ["E-AFF-01", "STALE_FALLBACK"],
    ["E-ASSET-01", "TEXT_ONLY_FALLBACK"],
    ["E-DATA-01", "STALE_FALLBACK"],
  ]) {
    assert.equal(validateManualGateEvidence({
      schemaVersion: "1.0",
      requirementId: id,
      status,
      observedAt: "2026-08-21T00:00:00Z",
      sanitized: true,
      secretValues: 0,
    }, releaseGate(id), { now }), true, id);
  }
});

test("latest PASS pointer is explicitly scoped to dry-run assembly", () => {
  const pointer = {
    schemaVersion: "1.0",
    status: "PASS",
    scope: "RELEASE_DRY_RUN_ASSEMBLY",
    dryRunOnly: true,
    runDirectory: "run-test",
    report: "run-test/artifact-manifest.json",
  };
  assert.equal(validateLatestDryRunPointer(pointer), true);
  assert.equal(validateLatestDryRunPointer({ ...pointer, scope: "RELEASE" }), false);
  assert.equal(validateLatestDryRunPointer({ ...pointer, dryRunOnly: false }), false);
  assert.equal(validateLatestDryRunPointer({ ...pointer, unexpected: true }), false);
});

test("verify:release binds E-WIN proof to the current dry-run manifests and computes promotion diagnostics", async () => {
  const evidenceRoot = path.join("C:\\synthetic", "release");
  const externalRoot = path.join("C:\\synthetic", "external");
  const latest = {
    schemaVersion: "1.0",
    status: "PASS",
    scope: "RELEASE_DRY_RUN_ASSEMBLY",
    dryRunOnly: true,
    runDirectory: "run-test",
    report: "run-test/artifact-manifest.json",
  };
  const artifactManifest = {
    status: "PASS",
    dryRunOnly: true,
    tagCreated: false,
    published: false,
    toolSpanVersion: CURRENT_RELEASE_CONTEXT.toolSpanVersion,
  };
  const desktopManifest = {
    toolSpanVersion: CURRENT_RELEASE_CONTEXT.toolSpanVersion,
    nativeArtifacts: [
      { targetName: "ToolSpan_0.5.0_x64_en-US.msi", sha256: CURRENT_RELEASE_CONTEXT.msiSha256 },
      { targetName: "ToolSpan_0.5.0_x64-setup.exe", sha256: CURRENT_RELEASE_CONTEXT.nsisSha256 },
    ],
  };
  const windowsProof = {
    kind: "WINDOWS_NATIVE_SMOKE",
    toolSpanVersion: CURRENT_RELEASE_CONTEXT.toolSpanVersion,
    msiSha256: CURRENT_RELEASE_CONTEXT.msiSha256,
    nsisSha256: CURRENT_RELEASE_CONTEXT.nsisSha256,
    installSmokePassed: true,
    traySmokePassed: true,
    ownedProcessSmokePassed: true,
    unrelatedProcessSurvived: true,
  };
  const written = new Map();
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  const result = await verifyRelease({
    npmCli: "C:\\node\\npm-cli.js",
    now: new Date("2026-08-21T12:00:00Z"),
    releaseEvidenceRoot: evidenceRoot,
    externalEvidenceRoot: externalRoot,
    runRoot: async () => {},
    isFile: async () => true,
    mkdir: async () => {},
    writeFile: async (filePath, value) => { written.set(filePath, value); },
    readFile: async (filePath) => {
      if (filePath === path.join(evidenceRoot, "latest.json")) return JSON.stringify(latest);
      if (filePath === path.join(evidenceRoot, "run-test", "artifact-manifest.json")) {
        return JSON.stringify(artifactManifest);
      }
      if (filePath === path.join(evidenceRoot, "run-test", "desktop-bundles.manifest.json")) {
        return JSON.stringify(desktopManifest);
      }
      if (filePath === path.join(externalRoot, "E-WIN-01.json")) {
        return JSON.stringify(manualPass("E-WIN-01", windowsProof));
      }
      if (filePath.endsWith("LICENSE")) return "MIT License";
      if (filePath.endsWith("namesilo-offer.snapshot.json")) return "affiliate snapshot";
      if (filePath.endsWith("openai-plan-usage.snapshot.json")) return "openai snapshot";
      throw missing;
    },
  });
  assert.equal(result.externalGatesPromotedWithoutEvidence, 0);
  assert.equal(result.requiredPending.includes("E-WIN-01"), false);
  const reportName = result.evidence.split("/").at(-1);
  const report = JSON.parse(written.get(path.join(evidenceRoot, reportName)));
  assert.deepEqual(
    report.gateMatrix.find((gate) => gate.id === "E-WIN-01"),
    { id: "E-WIN-01", required: true, status: "PASS", proofValidated: true },
  );
  assert.equal(countExternalGatesPromotedWithoutEvidence([
    { status: "PASS", proofValidated: true },
    { status: "PASS", proofValidated: false },
    { status: "FAIL", proofValidated: false },
  ]), 1);
});

test("active conditional claims prevent false RELEASE_READY after every mandatory gate passes", () => {
  const gates = RELEASE_GATE_MATRIX.map((gate) => ({
    id: gate.id,
    required: gate.required,
    status: gate.required === true || gate.required === false ? "PASS" : gate.fallback,
  }));
  const readiness = summarizeReleaseReadiness(gates);
  assert.deepEqual(readiness.requiredPending, []);
  assert.equal(readiness.releaseReady, false);
  assert.deepEqual(readiness.activeConditionalPending.map((entry) => entry.condition), [
    "ONE_CLICK_CLOUDFLARE_VALIDATED",
    "NUMERIC_OPENAI_QUOTA_CLAIM",
  ]);
  assert.ok(readiness.activeConditionalPending.every((entry) => RELEASE_CLAIM_POLICY[entry.condition].active));
  assert.deepEqual(readiness.inactiveConditionalFallbacks.map((entry) => entry.id), [
    "E-CF-WIN-01", "E-AFF-01", "E-ASSET-01",
  ]);
});

test("WINDOWS_ONE_CLICK_VALIDATED is inactive because Desktop uses the manual cloudflared boundary", () => {
  assert.equal(RELEASE_CLAIM_POLICY.WINDOWS_ONE_CLICK_VALIDATED.active, false);
  assert.equal(
    RELEASE_CLAIM_POLICY.WINDOWS_ONE_CLICK_VALIDATED.basis,
    "WINDOWS_SETUP_USES_MANUAL_CLOUDFLARED_ONLY",
  );
  const gates = RELEASE_GATE_MATRIX.map((gate) => ({
    id: gate.id,
    required: gate.required,
    status: gate.required === "WINDOWS_ONE_CLICK_VALIDATED" ? "BLOCKED_BY_ENVIRONMENT" : "PASS",
  }));
  const readiness = summarizeReleaseReadiness(gates);
  assert.deepEqual(readiness.requiredPending, []);
  assert.deepEqual(readiness.activeConditionalPending, []);
  assert.ok(readiness.inactiveConditionalFallbacks.some((entry) => entry.id === "E-CF-WIN-01"));
  assert.equal(readiness.releaseReady, true);
});

test("incomplete official OpenAI coverage deactivates numeric quota claims only through fallback", () => {
  const policy = claimPolicyFromOpenAiSnapshot(Buffer.from(JSON.stringify({
    verificationStatus: "INCOMPLETE_OFFICIAL_COVERAGE",
  }), "utf8"));
  assert.equal(policy.NUMERIC_OPENAI_QUOTA_CLAIM.active, false);
  assert.equal(
    policy.NUMERIC_OPENAI_QUOTA_CLAIM.basis,
    "OFFICIAL_SOURCE_COVERAGE_INCOMPLETE_STALE_FALLBACK",
  );
  assert.equal(policy.COMMERCIAL_CTA_CURRENT.active, false);

  const gates = RELEASE_GATE_MATRIX.map((gate) => ({
    id: gate.id,
    required: gate.required,
    status: gate.required === "NUMERIC_OPENAI_QUOTA_CLAIM" ? "STALE_FALLBACK" : "PASS",
  }));
  const readiness = summarizeReleaseReadiness(gates, policy);
  assert.deepEqual(readiness.requiredPending, []);
  assert.deepEqual(readiness.activeConditionalPending, []);
  assert.deepEqual(readiness.inactiveConditionalFallbacks.map((entry) => entry.id), ["E-DATA-01"]);
  assert.equal(readiness.releaseReady, true);
});

test("TEXT_ONLY_FALLBACK satisfies the inactive Logo/Banner policy and does not block Release", () => {
  const gates = RELEASE_GATE_MATRIX.map((gate) => ({
    id: gate.id,
    required: gate.required,
    status: gate.required === "VENDOR_ASSET_CLAIM" ? "TEXT_ONLY_FALLBACK" : "PASS",
  }));
  const readiness = summarizeReleaseReadiness(gates);
  assert.equal(RELEASE_CLAIM_POLICY.VENDOR_ASSET_CLAIM.active, false);
  assert.deepEqual(readiness.requiredPending, []);
  assert.deepEqual(readiness.activeConditionalPending, []);
  assert.deepEqual(readiness.inactiveConditionalFallbacks.map((entry) => entry.id), ["E-ASSET-01"]);
  assert.equal(readiness.releaseReady, true);
});

test("verify:release preserves an exit-2 source prerequisite as an environment blocker", async () => {
  const blocked = Object.assign(new Error("All deterministic source stages failed"), {
    code: "PROCESS_FAILED",
    exitCode: 2,
  });
  const result = await verifyRelease({
    npmCli: "C:\\node\\npm-cli.js",
    runRoot: async (script) => {
      if (script === "verify:all:source") throw blocked;
    },
  });
  assert.equal(result.status, "BLOCKED_BY_ENVIRONMENT");
  assert.equal(result.releaseReady, false);
  assert.equal(result.exitCode, 2);
});

test("requirements contain the complete 04 matrix and deterministic Release automation", async () => {
  const document = JSON.parse(await readFile(path.join(projectRoot, "goal", "requirements.json"), "utf8"));
  const byId = new Map(document.requirements.map((entry) => [entry.id, entry]));
  for (const gate of RELEASE_GATE_MATRIX) {
    const requirement = byId.get(gate.id);
    assert.ok(requirement, gate.id);
    assert.equal(requirement.stage, "RELEASE", gate.id);
    assert.notEqual(requirement.gateType, "deterministic", gate.id);
    assert.equal(typeof requirement.manualEvidence, "string", gate.id);
    assert.deepEqual(
      requirement.blockingFor,
      gate.required === true ? ["RELEASE_READY"] : gate.required === false ? [] : [gate.required],
      `${gate.id}: blocking condition must be canonical`,
    );
  }
  assert.equal(byId.get("R-EXTENV-01").verificationCommand, "npm run check:test-environment");
  assert.equal(byId.get("R-DRYRUN-01").verificationCommand, "npm run release:dry-run");
});
