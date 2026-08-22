import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  createPublishShrinkwrap,
  isSupportedNodeVersion,
  SUPPORTED_NODE_ENGINE,
} from "../package-runtime-policy.mjs";
import { REQUIRED_SOURCE_SCRIPTS, verifyAllSource } from "../verify-all-source.mjs";

function sourcePackage() {
  return {
    scripts: Object.fromEntries(REQUIRED_SOURCE_SCRIPTS.map((name) => [
      name,
      `node scripts/${name.replaceAll(":", "-")}.mjs`,
    ])),
  };
}

test("all-source verification preserves a child environment blocker", async () => {
  const blocked = Object.assign(new Error("child gate is environment-blocked"), {
    code: "PROCESS_FAILED",
    exitCode: 2,
  });
  const result = await verifyAllSource({
    nodeVersion: "24.19.0",
    packageDocument: sourcePackage(),
    npmCli: "C:\\node\\npm-cli.js",
    environment: { PATH: "fixture-path" },
    runUnitTests: async () => {},
    runRoot: async () => { throw blocked; },
  });

  assert.equal(result.status, "BLOCKED_BY_ENVIRONMENT");
  assert.equal(result.reason, "SOURCE_VERIFICATION_ENVIRONMENT_BLOCKED");
  assert.equal(result.exitCode, 2);
});

test("root package declares the exact verified Node and npm toolchains", async () => {
  const [packageDocument, lockDocument] = await Promise.all([
    readFile(new URL("../../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../../package-lock.json", import.meta.url), "utf8").then(JSON.parse),
  ]);

  assert.equal(packageDocument.engines.node, SUPPORTED_NODE_ENGINE);
  assert.equal(packageDocument.engines.npm, "10.9.2");
  assert.equal(packageDocument.packageManager, "npm@10.9.2");
  assert.deepEqual(lockDocument.packages[""].engines, packageDocument.engines);
});

test("runtime Node policy accepts only supported 22.17+ and 24 majors", () => {
  assert.equal(isSupportedNodeVersion("v22.16.0"), false);
  assert.equal(isSupportedNodeVersion("v22.17.0"), true);
  assert.equal(isSupportedNodeVersion("v23.9.0"), false);
  assert.equal(isSupportedNodeVersion("v24.19.0"), true);
  assert.equal(isSupportedNodeVersion("v25.0.0"), false);
});

test("published shrinkwrap is a deterministic publishable copy of the verified lock", async () => {
  const [packageDocument, lockDocument, shrinkwrapDocument] = await Promise.all([
    readFile(new URL("../../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../../package-lock.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../../npm-shrinkwrap.json", import.meta.url), "utf8").then(JSON.parse),
  ]);

  assert.deepEqual(shrinkwrapDocument, createPublishShrinkwrap(lockDocument));
  assert.deepEqual(shrinkwrapDocument.packages, lockDocument.packages);
  assert.ok(packageDocument.files.includes("npm-shrinkwrap.json"));
});

test("Node development types stay on the supported Node 22 line", async () => {
  const [packageDocument, lockDocument] = await Promise.all([
    readFile(new URL("../../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../../package-lock.json", import.meta.url), "utf8").then(JSON.parse),
  ]);

  assert.match(packageDocument.devDependencies["@types/node"], /^22\.[0-9]+\.[0-9]+$/u);
  assert.equal(
    lockDocument.packages["node_modules/@types/node"].version,
    packageDocument.devDependencies["@types/node"],
  );
  assert.equal(
    lockDocument.packages[""].devDependencies["@types/node"],
    packageDocument.devDependencies["@types/node"],
  );
});
