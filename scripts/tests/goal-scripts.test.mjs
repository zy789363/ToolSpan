import assert from "node:assert/strict";
import { test } from "node:test";

import {
  commandLooksReal,
  findSecretLikeState,
  validateGoalState,
  validateRequirements,
} from "../goal-check.mjs";
import { isNodeAtLeast, parseNodeVersion } from "../goal-preflight.mjs";

function requirements() {
  return {
    goalVersion: "4.0",
    requirements: [{
      id: "C-TEST-01",
      stage: "CORE",
      summary: "A deterministic fixture",
      gateType: "deterministic",
      blockingFor: ["CORE_IMPLEMENTATION_COMPLETE"],
      verificationCommand: "npm run check:test",
    }],
  };
}

function state(status = "IN_PROGRESS") {
  return {
    goalVersion: "4.0",
    currentStage: "CORE",
    stages: {
      core: {
        status,
        passedRequirements: status === "PASS" ? ["C-TEST-01"] : [],
        failedRequirements: [],
        verificationReport: status === "PASS" ? "docs/release/test.md" : null,
      },
      desktop: { status: "NOT_STARTED", passedRequirements: [], failedRequirements: [], verificationReport: null },
      setup: { status: "NOT_STARTED", passedRequirements: [], failedRequirements: [], verificationReport: null },
      release: { status: "NOT_STARTED", passedRequirements: [], failedRequirements: [], verificationReport: null },
    },
    environment: { CORE_CAPABLE: true },
    blockers: [],
    lastUpdated: "2026-08-20T00:00:00Z",
  };
}

test("Node capability comparison uses the strict 22.17 minimum", () => {
  assert.deepEqual(parseNodeVersion("v22.17.0"), [22, 17, 0]);
  assert.equal(isNodeAtLeast("v22.16.0"), false);
  assert.equal(isNodeAtLeast("v22.17.0"), true);
  assert.equal(isNodeAtLeast("v24.19.0"), true);
});

test("deterministic commands reject placeholders and missing active-stage scripts", () => {
  assert.equal(commandLooksReal("npm run check:test", { "check:test": "node scripts/check-test.mjs" }), true);
  assert.equal(commandLooksReal("npm run check:test", { "check:test": "echo ..." }), false);
  assert.equal(commandLooksReal("..."), false);
});

test("requirements reject duplicate IDs and non-deterministic source blockers", () => {
  const document = requirements();
  document.requirements.push({ ...document.requirements[0] });
  document.requirements.push({
    id: "E-TEST-01",
    stage: "RELEASE",
    summary: "External fixture",
    gateType: "external",
    blockingFor: ["CORE_IMPLEMENTATION_COMPLETE"],
    manualEvidence: "Dated sanitized report",
  });
  const errors = validateRequirements(document, {
    packageScripts: { "check:test": "node scripts/check-test.mjs" },
    enforcedStages: new Set(["CORE"]),
  });
  assert.ok(errors.some((error) => error.includes("duplicate Requirement ID")));
  assert.ok(errors.some((error) => error.includes("cannot block a source implementation stage")));
});

test("goal state rejects undefined PASS and accepts a fully evidenced PASS", () => {
  const valid = state("PASS");
  assert.deepEqual(validateGoalState(valid, requirements()), []);
  valid.stages.core.passedRequirements = [];
  assert.ok(validateGoalState(valid, requirements()).some((error) => error.includes("undefined PASS")));
});

test("goal state secret scan reports paths but never echoes secret values", () => {
  const document = state();
  document.environment.apiKey = "sk-example-value-that-must-never-be-echoed";
  const findings = findSecretLikeState(document);
  assert.ok(findings.some((finding) => finding === "goalState.environment.*: SECRET_FIELD_NAME"));
  assert.equal(findings.some((finding) => finding.includes("apiKey")), false);
  assert.equal(findings.some((finding) => finding.includes("example-value")), false);
  document.environment = { credentialEnvName: "CLOUDFLARE_API_TOKEN" };
  assert.deepEqual(findSecretLikeState(document), []);
});

test("goal state secret scan detects a generic synthetic high-entropy value without echoing it", () => {
  const document = state();
  const syntheticValue = "q7V2mN9xR4cT8bK3wP6dH1sF5jL0zG2uY9eA7iC4";
  document.environment.diagnosticReference = syntheticValue;

  const findings = findSecretLikeState(document);

  assert.deepEqual(findings, ["goalState.environment.diagnosticReference: HIGH_ENTROPY_VALUE"]);
  assert.equal(findings.some((finding) => finding.includes(syntheticValue)), false);
});
