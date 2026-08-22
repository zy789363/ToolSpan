import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIRECTORY = path.join(ROOT, ".github", "workflows");
const SHA_PIN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/u;

function assert(condition, message) {
  if (!condition) throw new Error(`CI check: ${message}`);
}

function visit(value, callback) {
  callback(value);
  if (Array.isArray(value)) for (const item of value) visit(item, callback);
  else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) visit(item, callback);
  }
}

async function main() {
  const workflowNames = (await readdir(WORKFLOW_DIRECTORY))
    .filter((name) => /\.ya?ml$/u.test(name))
    .sort();
  assert(workflowNames.length > 0, "at least one workflow is required");

  let pinnedActions = 0;
  for (const name of workflowNames) {
    const source = await readFile(path.join(WORKFLOW_DIRECTORY, name), "utf8");
    assert(!source.includes("pull_request_target"), `${name} must not use pull_request_target`);
    assert(!/self-hosted/iu.test(source), `${name} must not use a self-hosted runner`);
    assert(!/\bsecrets\s*[:.]/iu.test(source), `${name} must not depend on repository secrets`);

    let workflow;
    try {
      workflow = JSON.parse(source);
    } catch (error) {
      throw new Error(`CI check: ${name} must be valid JSON-compatible YAML: ${error instanceof Error ? error.message : "parse error"}`);
    }
    assert(workflow !== null && typeof workflow === "object" && !Array.isArray(workflow), `${name} root must be an object`);
    assert(workflow.on?.pull_request !== undefined, `${name} must run for pull_request`);
    assert(workflow.on?.push !== undefined, `${name} must run for push`);
    assert(workflow.permissions?.contents === "read" && Object.keys(workflow.permissions).length === 1, `${name} must grant only contents: read`);
    assert(workflow.jobs !== null && typeof workflow.jobs === "object", `${name} must define jobs`);

    visit(workflow, (value) => {
      if (typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@/u.test(value)) {
        assert(SHA_PIN.test(value), `${name} action must be pinned to a full commit SHA: ${value.split("@")[0]}`);
        pinnedActions += 1;
      }
    });

    const core = workflow.jobs.core;
    assert(core !== undefined, `${name} must define the core job`);
    assert(core["runs-on"] === "${{ matrix.os }}", `${name} core job must use the declared OS matrix`);
    const include = core.strategy?.matrix?.include;
    assert(Array.isArray(include), `${name} must define an explicit include matrix`);
    const tuples = new Set(include.map((entry) => `${entry.os}|${entry.node}`));
    for (const tuple of ["ubuntu-latest|22.17.0", "ubuntu-latest|24.x", "windows-latest|24.x"]) {
      assert(tuples.has(tuple), `${name} is missing required matrix entry ${tuple}`);
    }
    assert(tuples.size === 3, `${name} matrix must contain only the three required Core environments`);
    const commands = core.steps.filter((step) => typeof step.run === "string").map((step) => step.run);
    assert(commands.includes("npm ci"), `${name} must perform a clean install`);
    assert(commands.some((command) => command.includes("ripgrep")), `${name} Core job must install ripgrep`);
    assert(commands.some((command) => command.includes("examples/goal-state.example.json")
      && command.includes(".toolspan-dev/goal-state.json")), `${name} Core job must initialize local goal state`);
    assert(commands.includes("npm run verify:core"), `${name} must run deterministic Core verification`);

    const desktop = workflow.jobs["desktop-source"];
    assert(desktop !== undefined, `${name} must define the desktop-source job`);
    assert(desktop["runs-on"] === "${{ matrix.os }}", `${name} desktop-source job must use the declared OS matrix`);
    const desktopInclude = desktop.strategy?.matrix?.include;
    assert(Array.isArray(desktopInclude), `${name} must define an explicit Desktop include matrix`);
    const desktopTuples = new Set(desktopInclude.map((entry) => `${entry.os}|${entry.node}`));
    for (const tuple of ["ubuntu-latest|24.x", "windows-latest|24.x"]) {
      assert(desktopTuples.has(tuple), `${name} is missing required Desktop matrix entry ${tuple}`);
    }
    assert(desktopTuples.size === 2, `${name} Desktop matrix must contain only Ubuntu and Windows Node 24`);
    const desktopCommands = desktop.steps.filter((step) => typeof step.run === "string").map((step) => step.run);
    assert(desktopCommands.includes("npm ci"), `${name} Desktop job must clean-install Core`);
    assert(desktopCommands.some((command) => command.includes("ripgrep")), `${name} Desktop job must install ripgrep`);
    assert(desktopCommands.some((command) => command.includes("examples/goal-state.example.json")
      && command.includes(".toolspan-dev/goal-state.json")), `${name} Desktop job must initialize local goal state`);
    assert(desktopCommands.includes("npm run verify:desktop:source"), `${name} must verify Desktop source`);
    assert(desktopCommands.some((command) => command.includes("npm run verify:desktop:windows")
      && command.includes("$LASTEXITCODE") && command.includes("-eq 2")),
    `${name} must attempt native Windows build and distinguish environment blocking`);
  }

  assert(pinnedActions > 0, "workflow must use at least one SHA-pinned action");
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    workflows: workflowNames,
    syntax: "JSON_COMPATIBLE_YAML_PASS",
    permissions: "contents:read",
    pinnedActions,
    pullRequestTargetReferences: 0,
    selfHostedReferences: 0,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "CI check failed"}\n`);
  process.exitCode = 1;
});
