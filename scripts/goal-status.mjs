import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkGoalArtifacts } from "./goal-check.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(projectRoot, relativePath), "utf8"));
}

try {
  const [validation, state, requirements] = await Promise.all([
    checkGoalArtifacts(projectRoot),
    readJson(path.join(".toolspan-dev", "goal-state.json")),
    readJson(path.join("goal", "requirements.json")),
  ]);
  const requirementsByStage = Object.fromEntries(
    ["CORE", "DESKTOP", "SETUP", "RELEASE"].map((stage) => {
      const entries = requirements.requirements.filter((item) => item.stage === stage);
      return [stage.toLowerCase(), {
        total: entries.length,
        deterministic: entries.filter((item) => item.gateType === "deterministic").length,
        nonDeterministic: entries.filter((item) => item.gateType !== "deterministic").length,
      }];
    }),
  );
  const stages = Object.fromEntries(Object.entries(state.stages).map(([name, stage]) => [name, {
    status: stage.status,
    passedCount: Array.isArray(stage.passedRequirements) ? stage.passedRequirements.length : 0,
    failedCount: Array.isArray(stage.failedRequirements) ? stage.failedRequirements.length : 0,
    hasVerificationReport: typeof stage.verificationReport === "string"
      && stage.verificationReport.trim().length > 0,
  }]));
  process.stdout.write(`${JSON.stringify({
    status: validation.errors.length === 0 ? "VALID" : "INVALID",
    goalVersion: state.goalVersion,
    currentStage: state.currentStage,
    stages,
    requirements: requirementsByStage,
    blockers: Array.isArray(state.blockers) ? state.blockers.map((blocker) => ({
      id: blocker.id,
      classification: blocker.classification,
    })) : [],
    environmentKeys: state.environment !== null && typeof state.environment === "object"
      ? Object.keys(state.environment).sort() : [],
    validationErrors: validation.errors,
  }, null, 2)}\n`);
  if (validation.errors.length > 0) process.exitCode = 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    status: "INVALID",
    validationErrors: [error instanceof Error ? error.message : "Could not read goal state"],
  }, null, 2)}\n`);
  process.exitCode = 1;
}
