import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(scriptDirectory, "..");

const STAGES = ["CORE", "DESKTOP", "SETUP", "RELEASE"];
const CURRENT_STAGES = ["PRECHECK", "CORE", "DESKTOP", "SETUP", "RELEASE_GATES", "DONE"];
const GATE_TYPES = ["deterministic", "native", "external", "owner"];
const STAGE_STATUSES = [
  "NOT_STARTED",
  "IN_PROGRESS",
  "IMPLEMENTATION_COMPLETE",
  "PASS",
  "FAIL",
  "BLOCKED_BY_ENVIRONMENT",
  "EXTERNAL_GATE_PENDING",
  "NOT_CONFIGURED",
];
const BLOCKER_CLASSIFICATIONS = [
  "PREEXISTING_FAILURE",
  "REGRESSION",
  "BLOCKED_BY_ENVIRONMENT",
  "BLOCKED_BY_EXTERNAL_ACCOUNT",
  "BLOCKED_BY_OWNER_INPUT",
  "BLOCKED_BY_UPSTREAM_CHANGE",
  "BLOCKED_BY_HOST_PLAN_OR_POLICY",
  "SPEC_CONFLICT",
];
const IMPLEMENTATION_GATES = new Set([
  "CORE_IMPLEMENTATION_COMPLETE",
  "DESKTOP_SOURCE_COMPLETE",
  "SETUP_IMPLEMENTATION_COMPLETE",
]);
const STAGE_KEYS = { core: "CORE", desktop: "DESKTOP", setup: "SETUP", release: "RELEASE" };
const EXPECTED_ROOT_KEYS = ["goalVersion", "currentStage", "stages", "environment", "blockers", "lastUpdated"];
const EXPECTED_STAGE_KEYS = ["status", "passedRequirements", "failedRequirements", "verificationReport"];
const PLACEHOLDER_COMMAND = /(?:\.\.\.|<[^>]+>|\b(?:TODO|TBD|FIXME|placeholder|not implemented)\b)/iu;
const TRIVIAL_COMMAND = /^(?:echo\b|true$|exit\s+0$)/iu;
const ENVIRONMENT_VARIABLE_NAME = /^[A-Z][A-Z0-9_]*$/u;
const KNOWN_SECRET_VALUE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]+=*|\bBasic\s+[A-Za-z0-9+/]+=*|\bsk-[A-Za-z0-9_-]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[baprs]-[A-Za-z0-9-]{20,}|\bAIza[0-9A-Za-z_-]{30,}|[a-z][a-z0-9+.-]*:\/\/[^\s/:]+:[^\s/@]+@)/iu;
const CLOUDFLARE_GLOBAL_KEY_VALUE = /\bcfk_[A-Za-z0-9_-]{40,}\b/u;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unknownKeys(value, allowed) {
  if (!isObject(value)) return [];
  const allowedSet = new Set(allowed);
  return Object.keys(value).filter((key) => !allowedSet.has(key));
}

function hasUniqueStrings(value) {
  return Array.isArray(value)
    && value.every((item) => typeof item === "string")
    && new Set(value).size === value.length;
}

function stageSetFor(currentStage) {
  switch (currentStage) {
    case "DESKTOP": return new Set(["CORE", "DESKTOP"]);
    case "SETUP": return new Set(["CORE", "DESKTOP", "SETUP"]);
    case "RELEASE_GATES":
    case "DONE": return new Set(STAGES);
    default: return new Set(["CORE"]);
  }
}

function npmScriptFromCommand(command) {
  const runMatch = /^npm(?:\.cmd)?\s+run\s+([^\s]+)(?:\s|$)/u.exec(command);
  if (runMatch !== null) return runMatch[1];
  return /^npm(?:\.cmd)?\s+test(?:\s|$)/u.test(command) ? "test" : undefined;
}

function scriptLooksReal(script) {
  return typeof script === "string"
    && script.trim().length > 0
    && !PLACEHOLDER_COMMAND.test(script)
    && !TRIVIAL_COMMAND.test(script.trim());
}

export function commandLooksReal(command, packageScripts = undefined, enforceScript = true) {
  if (typeof command !== "string") return false;
  const trimmed = command.trim();
  if (trimmed.length === 0 || trimmed.includes("\n") || PLACEHOLDER_COMMAND.test(trimmed)
    || TRIVIAL_COMMAND.test(trimmed)) return false;
  if (!/^(?:npm(?:\.cmd)?\s+(?:run\s+[^\s]+|test\b)|node\s+[^\s]+)/u.test(trimmed)) return false;
  const scriptName = npmScriptFromCommand(trimmed);
  if (!enforceScript || scriptName === undefined || packageScripts === undefined) return true;
  return scriptLooksReal(packageScripts[scriptName]);
}

export function validateRequirements(document, options = {}) {
  const errors = [];
  const packageScripts = options.packageScripts;
  const enforcedStages = options.enforcedStages ?? new Set(STAGES);
  if (!isObject(document)) return ["requirements: expected an object"];
  for (const key of unknownKeys(document, ["goalVersion", "requirements"])) {
    errors.push(`requirements.${key}: unexpected field`);
  }
  if (document.goalVersion !== "4.0") errors.push("requirements.goalVersion: expected 4.0");
  if (!Array.isArray(document.requirements)) return [...errors, "requirements.requirements: expected an array"];

  const ids = new Set();
  for (const [index, requirement] of document.requirements.entries()) {
    const location = `requirements.requirements[${index}]`;
    if (!isObject(requirement)) {
      errors.push(`${location}: expected an object`);
      continue;
    }
    for (const key of unknownKeys(requirement, [
      "id", "stage", "summary", "gateType", "blockingFor", "verificationCommand", "manualEvidence",
    ])) errors.push(`${location}.${key}: unexpected field`);

    if (typeof requirement.id !== "string" || !/^[A-Z][A-Z0-9-]+$/u.test(requirement.id)) {
      errors.push(`${location}.id: invalid Requirement ID`);
    } else if (ids.has(requirement.id)) {
      errors.push(`${location}.id: duplicate Requirement ID ${requirement.id}`);
    } else {
      ids.add(requirement.id);
    }
    if (!STAGES.includes(requirement.stage)) errors.push(`${location}.stage: invalid stage`);
    if (typeof requirement.summary !== "string" || requirement.summary.trim().length === 0) {
      errors.push(`${location}.summary: expected non-empty text`);
    }
    if (!GATE_TYPES.includes(requirement.gateType)) errors.push(`${location}.gateType: invalid gate classification`);
    if (!hasUniqueStrings(requirement.blockingFor)) {
      errors.push(`${location}.blockingFor: expected unique strings`);
    }

    if (requirement.gateType === "deterministic") {
      const enforceScript = enforcedStages.has(requirement.stage);
      if (!commandLooksReal(requirement.verificationCommand, packageScripts, enforceScript)) {
        errors.push(`${location}.verificationCommand: deterministic gate must name a real command`);
      }
      if (Array.isArray(requirement.blockingFor) && requirement.blockingFor.length === 0) {
        errors.push(`${location}.blockingFor: deterministic gate must block a defined completion target`);
      }
    } else if (["native", "external", "owner"].includes(requirement.gateType)) {
      if (typeof requirement.manualEvidence !== "string" || requirement.manualEvidence.trim().length === 0) {
        errors.push(`${location}.manualEvidence: non-deterministic gate requires manual evidence`);
      }
      if (Array.isArray(requirement.blockingFor)
        && requirement.blockingFor.some((gate) => IMPLEMENTATION_GATES.has(gate))) {
        errors.push(`${location}.blockingFor: non-deterministic gate cannot block a source implementation stage`);
      }
    }
  }
  return errors;
}

function fieldMayContainSecret(key) {
  const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
  if (!/(?:secret|password|token|apikey|privatekey|credential)/u.test(normalized)) return false;
  return !/(?:name|variable|env|present|available|configured|source|type|mode|status|capable)$/u.test(normalized);
}

function shannonEntropy(value) {
  const counts = new Map();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  return [...counts.values()].reduce((entropy, count) => {
    const probability = count / value.length;
    return entropy - probability * Math.log2(probability);
  }, 0);
}

function looksHighEntropy(value) {
  return /^[A-Za-z0-9._~+/-]{24,256}$/u.test(value)
    && new Set(value).size >= 12
    && shannonEntropy(value) >= 4.2;
}

export function findSecretLikeState(document) {
  const findings = [];
  const visit = (value, location, parentKey = "") => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${location}[${index}]`, parentKey));
      return;
    }
    if (isObject(value)) {
      for (const [key, child] of Object.entries(value)) {
        const secretField = fieldMayContainSecret(key);
        const childLocation = secretField ? `${location}.*` : `${location}.${key}`;
        if (secretField) findings.push(`${childLocation}: SECRET_FIELD_NAME`);
        visit(child, childLocation, key);
      }
      return;
    }
    if (typeof value !== "string") return;
    if (CLOUDFLARE_GLOBAL_KEY_VALUE.test(value)) findings.push(`${location}: CLOUDFLARE_GLOBAL_KEY`);
    else if (KNOWN_SECRET_VALUE.test(value)) findings.push(`${location}: KNOWN_SECRET_VALUE`);
    else if (looksHighEntropy(value)) findings.push(`${location}: HIGH_ENTROPY_VALUE`);
    if (fieldMayContainSecret(parentKey) && value.length > 0 && !ENVIRONMENT_VARIABLE_NAME.test(value)) {
      findings.push(`${location}: SECRET_FIELD_VALUE`);
    }
  };
  visit(document, "goalState");
  return [...new Set(findings)];
}

function requiredForCompletedStage(stageKey, requirements) {
  const stageName = STAGE_KEYS[stageKey];
  if (stageKey === "release") {
    return requirements.filter((item) => Array.isArray(item.blockingFor)
      && item.blockingFor.includes("RELEASE_READY"));
  }
  return requirements.filter((item) => item.stage === stageName && item.gateType === "deterministic");
}

export function validateGoalState(document, requirementsDocument) {
  const errors = [];
  if (!isObject(document)) return ["goalState: expected an object"];
  for (const key of unknownKeys(document, EXPECTED_ROOT_KEYS)) errors.push(`goalState.${key}: unexpected field`);
  if (document.goalVersion !== "4.0") errors.push("goalState.goalVersion: expected 4.0");
  if (isObject(requirementsDocument) && document.goalVersion !== requirementsDocument.goalVersion) {
    errors.push("goalState.goalVersion: must match requirements.goalVersion");
  }
  if (!CURRENT_STAGES.includes(document.currentStage)) errors.push("goalState.currentStage: invalid stage");

  const requirementList = Array.isArray(requirementsDocument?.requirements)
    ? requirementsDocument.requirements : [];
  const requirementsById = new Map(requirementList.map((item) => [item.id, item]));
  if (!isObject(document.stages)) {
    errors.push("goalState.stages: expected an object");
  } else {
    for (const key of unknownKeys(document.stages, Object.keys(STAGE_KEYS))) {
      errors.push(`goalState.stages.${key}: unexpected stage`);
    }
    for (const [stageKey, stageName] of Object.entries(STAGE_KEYS)) {
      const stage = document.stages[stageKey];
      const location = `goalState.stages.${stageKey}`;
      if (!isObject(stage)) {
        errors.push(`${location}: expected an object`);
        continue;
      }
      for (const key of unknownKeys(stage, EXPECTED_STAGE_KEYS)) errors.push(`${location}.${key}: unexpected field`);
      if (!STAGE_STATUSES.includes(stage.status)) errors.push(`${location}.status: invalid status`);
      for (const field of ["passedRequirements", "failedRequirements"]) {
        if (!hasUniqueStrings(stage[field])) errors.push(`${location}.${field}: expected unique Requirement IDs`);
      }
      const passed = Array.isArray(stage.passedRequirements) ? stage.passedRequirements : [];
      const failed = Array.isArray(stage.failedRequirements) ? stage.failedRequirements : [];
      for (const id of [...passed, ...failed]) {
        const requirement = requirementsById.get(id);
        if (requirement === undefined) {
          errors.push(`${location}: undefined Requirement ID ${String(id)}`);
        } else if (stageKey !== "release" && requirement.stage !== stageName) {
          errors.push(`${location}: Requirement ID ${String(id)} belongs to ${String(requirement.stage)}`);
        }
      }
      for (const id of passed) {
        if (failed.includes(id)) errors.push(`${location}: Requirement ID ${id} cannot both pass and fail`);
      }
      if (stage.status === "FAIL" && failed.length === 0) {
        errors.push(`${location}.status: FAIL requires at least one failed Requirement ID`);
      }
      if (["PASS", "IMPLEMENTATION_COMPLETE"].includes(stage.status)) {
        if (failed.length > 0) errors.push(`${location}.status: completed state cannot contain failed requirements`);
        if (typeof stage.verificationReport !== "string" || stage.verificationReport.trim().length === 0) {
          errors.push(`${location}.verificationReport: completed state requires a report path`);
        }
        const missing = requiredForCompletedStage(stageKey, requirementList)
          .map((item) => item.id).filter((id) => !passed.includes(id));
        if (missing.length > 0) {
          errors.push(`${location}.status: undefined PASS; missing ${missing.join(", ")}`);
        }
      }
    }
  }

  if (!isObject(document.environment)) {
    errors.push("goalState.environment: expected an object");
  } else {
    for (const [key, value] of Object.entries(document.environment)) {
      if (!["string", "number", "boolean"].includes(typeof value) && value !== null) {
        errors.push(`goalState.environment.${key}: expected a scalar capability value`);
      }
    }
  }

  if (!Array.isArray(document.blockers)) {
    errors.push("goalState.blockers: expected an array");
  } else {
    const blockerIds = new Set();
    for (const [index, blocker] of document.blockers.entries()) {
      const location = `goalState.blockers[${index}]`;
      if (!isObject(blocker)) {
        errors.push(`${location}: expected an object`);
        continue;
      }
      for (const key of unknownKeys(blocker, ["id", "classification", "summary", "evidence", "nextAction"])) {
        errors.push(`${location}.${key}: unexpected field`);
      }
      if (typeof blocker.id !== "string" || blocker.id.trim().length === 0) {
        errors.push(`${location}.id: expected non-empty text`);
      } else if (blockerIds.has(blocker.id)) {
        errors.push(`${location}.id: duplicate blocker ID`);
      } else blockerIds.add(blocker.id);
      if (!BLOCKER_CLASSIFICATIONS.includes(blocker.classification)) {
        errors.push(`${location}.classification: invalid blocker classification`);
      }
      for (const field of ["summary", "nextAction"]) {
        if (typeof blocker[field] !== "string" || blocker[field].trim().length === 0) {
          errors.push(`${location}.${field}: expected non-empty text`);
        }
      }
      if (blocker.evidence !== undefined && typeof blocker.evidence !== "string") {
        errors.push(`${location}.evidence: expected text`);
      }
    }
  }
  if (typeof document.lastUpdated !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(document.lastUpdated)
    || Number.isNaN(Date.parse(document.lastUpdated))) {
    errors.push("goalState.lastUpdated: expected a UTC date-time");
  }
  errors.push(...findSecretLikeState(document));
  return errors;
}

function validateSchemaHeaders(requirementsSchema, stateSchema) {
  const errors = [];
  if (requirementsSchema?.properties?.goalVersion?.const !== "4.0") {
    errors.push("schemas/requirements.schema.json: goalVersion const must be 4.0");
  }
  if (stateSchema?.properties?.goalVersion?.const !== "4.0") {
    errors.push("schemas/goal-state.schema.json: goalVersion const must be 4.0");
  }
  const statusEnum = stateSchema?.$defs?.stage?.properties?.status?.enum;
  if (!Array.isArray(statusEnum) || STAGE_STATUSES.some((status) => !statusEnum.includes(status))) {
    errors.push("schemas/goal-state.schema.json: stage status enum is incomplete");
  }
  const blockerEnum = stateSchema?.properties?.blockers?.items?.properties?.classification?.enum;
  if (!Array.isArray(blockerEnum)
    || BLOCKER_CLASSIFICATIONS.some((classification) => !blockerEnum.includes(classification))) {
    errors.push("schemas/goal-state.schema.json: blocker classification enum is incomplete");
  }
  return errors;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function checkGoalArtifacts(projectRoot = defaultProjectRoot) {
  const paths = {
    requirements: path.join(projectRoot, "goal", "requirements.json"),
    requirementsSchema: path.join(projectRoot, "schemas", "requirements.schema.json"),
    stateSchema: path.join(projectRoot, "schemas", "goal-state.schema.json"),
    state: path.join(projectRoot, ".toolspan-dev", "goal-state.json"),
    package: path.join(projectRoot, "package.json"),
  };
  const [requirements, requirementsSchema, stateSchema, state, packageJson] = await Promise.all([
    readJson(paths.requirements), readJson(paths.requirementsSchema), readJson(paths.stateSchema),
    readJson(paths.state), readJson(paths.package),
  ]);
  const enforcedStages = stageSetFor(state.currentStage);
  const errors = [
    ...validateSchemaHeaders(requirementsSchema, stateSchema),
    ...validateRequirements(requirements, { packageScripts: packageJson.scripts, enforcedStages }),
    ...validateGoalState(state, requirements),
  ];
  return {
    errors,
    summary: {
      goalVersion: requirements.goalVersion,
      currentStage: state.currentStage,
      requirementCount: Array.isArray(requirements.requirements) ? requirements.requirements.length : 0,
      deterministicGateCount: Array.isArray(requirements.requirements)
        ? requirements.requirements.filter((item) => item.gateType === "deterministic").length : 0,
      enforcedStages: [...enforcedStages],
    },
  };
}

async function main() {
  try {
    const result = await checkGoalArtifacts();
    process.stdout.write(`${JSON.stringify({
      status: result.errors.length === 0 ? "PASS" : "FAIL",
      ...result.summary,
      errors: result.errors,
    }, null, 2)}\n`);
    if (result.errors.length > 0) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      status: "FAIL",
      errors: [error instanceof Error ? error.message : "Goal artifact validation failed"],
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
