import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  DETERMINISTIC_SOURCE_TEST_FILES,
  EXTERNAL_E2E_GATES,
  allSourceStepNames,
  deterministicSourceTestArguments,
  externalSourceGateSummary,
  verifyAllSource,
} from "../verify-all-source.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const testDirectory = path.join(projectRoot, "scripts", "tests");

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(projectRoot, relativePath), "utf8"));
}

function packageScriptArguments(command) {
  const match = /^node --test (.+)$/u.exec(command);
  assert.ok(match, "test:source-scripts must use node --test with an explicit file list");
  return match[1].split(/\s+/u);
}

test("source verification explicitly covers every deterministic helper test and no external E2E script", async () => {
  const discovered = (await readdir(testDirectory))
    .filter((name) => name.endsWith(".test.mjs"))
    .map((name) => `scripts/tests/${name}`)
    .sort();
  const registered = [...DETERMINISTIC_SOURCE_TEST_FILES].sort();

  assert.deepEqual(registered, discovered);
  assert.deepEqual(deterministicSourceTestArguments(), ["--test", ...DETERMINISTIC_SOURCE_TEST_FILES]);
  assert.ok(DETERMINISTIC_SOURCE_TEST_FILES.some((file) => file.endsWith("cloudflare-e2e.test.mjs")));
  assert.ok(DETERMINISTIC_SOURCE_TEST_FILES.some((file) => file.endsWith("cloudflare-public-e2e.test.mjs")));
  assert.ok(DETERMINISTIC_SOURCE_TEST_FILES.some((file) => file.endsWith("host-e2e-safety.test.mjs")));
  assert.ok(DETERMINISTIC_SOURCE_TEST_FILES.some((file) => file.endsWith("setup-verification.test.mjs")));
  assert.equal(
    DETERMINISTIC_SOURCE_TEST_FILES.some((file) => /^scripts\/e2e-.*\.mjs$/u.test(file)),
    false,
  );
  assert.equal(allSourceStepNames()[0], "DETERMINISTIC_SOURCE_SCRIPT_TESTS");
});

test("the CI-facing source test script is exactly the registered deterministic suite", async () => {
  const packageDocument = await readJson("package.json");
  assert.deepEqual(
    packageScriptArguments(packageDocument.scripts["test:source-scripts"]),
    [...DETERMINISTIC_SOURCE_TEST_FILES],
  );
});

test("release gate documentation names the credential-free helper-test", async () => {
  const document = await readFile(path.join(projectRoot, "docs", "release", "release-gates.md"), "utf8");
  assert.match(document, /helper-test/iu);
  assert.match(document, /npm run test:source-scripts/u);
  assert.match(document, /当前 v0\.7\.1 发布/u);
  assert.match(document, /latest\.json.*RELEASE_DRY_RUN_ASSEMBLY/isu);
  assert.match(document, /不是正式 Release、`RELEASE_READY`/u);
});

test("setup documentation names the current product version and keeps exact-27 credential boundaries", async () => {
  const [packageDocument, setupDocument] = await Promise.all([
    readJson("package.json"),
    readFile(path.join(projectRoot, "docs", "setup", "index.md"), "utf8"),
  ]);
  assert.ok(setupDocument.includes(`当前 v${packageDocument.version} 的连接辅助流程`));
  assert.match(setupDocument, /exact 27 Tool Contract/u);
  assert.match(setupDocument, /Secret 输入/u);
});

test("credentialed or human-checkpoint E2E gates remain pending and are never part of source execution", async () => {
  const packageDocument = await readJson("package.json");
  const sourceArguments = deterministicSourceTestArguments();
  const pending = externalSourceGateSummary();

  assert.deepEqual(
    pending.map((gate) => gate.id),
    EXTERNAL_E2E_GATES.map((gate) => gate.id),
  );
  for (const gate of pending) {
    assert.equal(gate.status, "EXTERNAL_GATE_PENDING", gate.id);
    assert.equal(typeof packageDocument.scripts[gate.script], "string", gate.id);
    assert.equal(sourceArguments.includes(`npm run ${gate.script}`), false, gate.id);
    assert.equal(sourceArguments.includes(packageDocument.scripts[gate.script]), false, gate.id);
  }
});

test("verify:all:source reports external gates as pending after deterministic source completion", async () => {
  const packageDocument = await readJson("package.json");
  const calls = [];
  const result = await verifyAllSource({
    nodeVersion: "24.19.0",
    packageDocument,
    npmCli: "C:\\node\\npm-cli.js",
    environment: { PATH: "fixture-path" },
    runUnitTests: async () => { calls.push("deterministic-source-tests"); },
    runRoot: async (script) => { calls.push(script); },
  });

  assert.equal(result.status, "PASS");
  assert.equal(result.externalGatesPromotedToPass, 0);
  assert.deepEqual(result.externalGates, externalSourceGateSummary());
  assert.equal(calls[0], "deterministic-source-tests");
});

test("Core CI runs deterministic source helpers without credentials or external E2E commands", async () => {
  const workflow = await readJson(path.join(".github", "workflows", "core.yml"));
  const core = workflow.jobs?.core;
  assert.ok(core, "core job is required");
  const commands = core.steps.filter((step) => typeof step.run === "string").map((step) => step.run);

  assert.ok(commands.includes("npm run test:source-scripts"));
  for (const gate of EXTERNAL_E2E_GATES) {
    assert.equal(commands.includes(`npm run ${gate.script}`), false, gate.id);
  }
  const source = JSON.stringify(core);
  assert.doesNotMatch(source, /(?:CloudFlareAPIKEY|CLOUDFLARE_API_TOKEN|\bsecrets\b)/iu);
});

test("product contract pins current 0.7.1 separately from the historical 0.2 protocol baseline", async () => {
  const [packageDocument, contract, fixture] = await Promise.all([
    readJson("package.json"),
    readFile(path.join(projectRoot, "docs", "product-contract.md"), "utf8"),
    readJson(path.join("tests", "fixtures", "mcp-tools.v0.3.json")),
  ]);

  assert.equal(packageDocument.version, "0.7.1");
  assert.ok(contract.includes(`当前产品版本 \`${packageDocument.version}\``));
  assert.ok(contract.includes("当前 MCP 兼容性基线是固定的 `exact 27` 个工具"));
  assert.ok(contract.includes("历史说明：本文早期的 `0.2` 仅表示"));
  assert.ok(contract.includes("不是当前产品版本"));
  assert.doesNotMatch(contract, /定义当前 0\.2 版本/u);
  assert.equal(fixture.length, 27);
  assert.ok(contract.includes("固定公布 27 个工具"));
});

test("contract documents the SVN, concurrency reservation, and security boundaries guarded by source changes", async () => {
  const contract = await readFile(path.join(projectRoot, "docs", "product-contract.md"), "utf8");

  for (const required of [
    "`svn` 只允许 `status`、`diff`、`info` 和 `log`",
    "启动中的作业不能绕过全局或工作区级限制",
    "当前 `svn` 最多同时运行 4 个作业、单工作区最多 2 个",
    "`search_files` 将用户模式作为显式正则操作数传给 ripgrep",
    "`blender` 按选项名（包括 `--option=value` 形式）拒绝",
    "MCP 工具执行失败只返回稳定的通用错误",
    "实现或文档变更必须同步更新门禁测试",
  ]) {
    assert.ok(contract.includes(required), `product contract is missing: ${required}`);
  }
});
