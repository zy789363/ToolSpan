import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(scriptDirectory, "..", "..");

const LIFECYCLE_SCRIPT = path.join(projectRoot, "scripts", "cloudflared-service-lifecycle.ps1");
const UNINSTALL_SCRIPT = path.join(projectRoot, "scripts", "uninstall-cloudflared-service.ps1");
const INSTALL_SCRIPT = path.join(projectRoot, "scripts", "install-cloudflared-service.ps1");

const SECRET_VALUE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]+=*|\bsk-[A-Za-z0-9_-]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[baprs]-[A-Za-z0-9-]{20,})/iu;
const PORT_KILL = /(?:stop-process|taskkill|taskkill\/f|net\s+stop\s+.*pid)/iu;

async function scriptSource(filePath) {
  return readFile(filePath, "utf8");
}

test("E-CF-WIN-01 lifecycle scripts exist at the frozen paths", async () => {
  for (const filePath of [LIFECYCLE_SCRIPT, UNINSTALL_SCRIPT, INSTALL_SCRIPT]) {
    const source = await scriptSource(filePath);
    assert.ok(source.length > 0, `expected non-empty script: ${path.relative(projectRoot, filePath)}`);
  }
});

test("E-CF-WIN-01 lifecycle scripts contain no hardcoded secret values", async () => {
  for (const filePath of [LIFECYCLE_SCRIPT, UNINSTALL_SCRIPT, INSTALL_SCRIPT]) {
    const source = await scriptSource(filePath);
    assert.equal(SECRET_VALUE.test(source), false, `secret pattern found in ${filePath}`);
  }
});

test("E-CF-WIN-01 lifecycle scripts never kill by port or process name", async () => {
  for (const filePath of [LIFECYCLE_SCRIPT, UNINSTALL_SCRIPT]) {
    const source = await scriptSource(filePath);
    assert.equal(PORT_KILL.test(source), false, `port/process kill pattern found in ${filePath}`);
  }
});

test("E-CF-WIN-01 lifecycle script requires administrator elevation", async () => {
  const source = await scriptSource(LIFECYCLE_SCRIPT);
  assert.match(source, /IsInRole\([^)]*Administrator/u, "missing administrator check");
  assert.match(source, /ADMIN_REQUIRED/u, "missing ADMIN_REQUIRED reason code");
});

test("E-CF-WIN-01 lifecycle script freezes the phase set", async () => {
  const source = await scriptSource(LIFECYCLE_SCRIPT);
  assert.match(source, /ValidateSet\([^)]*"preflight"[^)]*\)/u, "missing preflight phase");
  assert.match(source, /"install"/u, "missing install phase");
  assert.match(source, /"verify"/u, "missing verify phase");
  assert.match(source, /"reboot-persistence"/u, "missing reboot-persistence phase");
  assert.match(source, /"uninstall"/u, "missing uninstall phase");
});

test("E-CF-WIN-01 lifecycle script emits a closed-set evidence envelope with secretValues=0", async () => {
  const source = await scriptSource(LIFECYCLE_SCRIPT);
  assert.match(source, /schemaVersion\s*=\s*"1\.0"/u, "missing schemaVersion");
  assert.match(source, /requirementId\s*=\s*"E-CF-WIN-01"/u, "missing requirementId");
  assert.match(source, /sanitized\s*=\s*\$true/u, "missing sanitized flag");
  assert.match(source, /secretValues\s*=\s*0/u, "missing secretValues=0");
  assert.match(source, /BLOCKED_BY_ENVIRONMENT/u, "missing BLOCKED_BY_ENVIRONMENT status");
  assert.match(source, /NEW_EMPTY_ENVELOPE|New-EmptyEnvelope/u, "missing PASS envelope factory");
});

test("E-CF-WIN-01 uninstall script refuses without provable ownership", async () => {
  const source = await scriptSource(UNINSTALL_SCRIPT);
  assert.match(source, /OWNERSHIP_NOT_PROVABLE/u, "missing ownership guard");
  assert.match(source, /Read-Ownership/u, "missing ownership read");
  assert.match(source, /serviceName\s*-ne\s*\$ServiceName/u, "missing service name ownership check");
  assert.match(source, /unrelatedServicePreserved/u, "missing unrelated-service preservation proof");
});

test("E-CF-WIN-01 lifecycle uninstall phase refuses external services", async () => {
  const source = await scriptSource(LIFECYCLE_SCRIPT);
  assert.match(source, /EXTERNAL_SERVICE_PRESERVED/u, "missing external-service preservation code");
  assert.match(source, /OWNERSHIP_NOT_PROVABLE/u, "missing ownership proof guard in uninstall phase");
  assert.match(source, /Test-SameServiceList/u, "missing unrelated-service comparison helper");
});

test("E-CF-WIN-01 install script records session ownership for later safe uninstall", async () => {
  const source = await scriptSource(INSTALL_SCRIPT);
  assert.match(source, /cloudflared-service-ownership\.json/u, "missing ownership file write");
  assert.match(source, /sessionId/u, "missing session id in ownership record");
  assert.match(source, /serviceName/u, "missing service name in ownership record");
});

test("E-CF-WIN-01 lifecycle scripts use only sanctioned cloudflared subcommands", async () => {
  const source = await scriptSource(LIFECYCLE_SCRIPT);
  assert.match(source, /service install/u, "missing cloudflared service install");
  assert.match(source, /service uninstall/u, "missing cloudflared service uninstall");
  assert.match(source, /tunnel run/u, "missing tunnel run ingress command");
  assert.match(source, /--version/u, "missing version probe");
});
