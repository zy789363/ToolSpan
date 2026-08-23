import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { npmInvocation, verificationEnvironment } from "../desktop-install.mjs";
import {
  FIXED_DESKTOP_HOST_RESOURCE,
  runDesktopResourceHello,
  stageDesktopResources,
} from "../desktop-resource-layout.mjs";
import { analyzeDesktopSecurity } from "../check-desktop-security.mjs";
import {
  executableCandidates,
  isSupportedDesktopNodeVersion,
  parseVsWhereInstallationPath,
  projectRoot,
  vsWhereCandidates,
} from "../desktop-verification-utils.mjs";
import {
  REQUIRED_DESKTOP_SCRIPTS,
  sourceVerificationStepNames,
  validateDesktopPackageScripts,
} from "../verify-desktop-source.mjs";
import {
  classifyWindowsPrerequisites,
  validateWindowsTauriBuildPipeline,
  verifyDesktopWindows,
} from "../verify-desktop-windows.mjs";

test("desktop npm orchestration always executes a resolved npm CLI without a shell", () => {
  const cli = path.join("C:\\Program Files\\nodejs", "node_modules", "npm", "bin", "npm-cli.js");
  const invocation = npmInvocation(cli, ["--prefix", "apps/desktop", "run", "test"]);
  assert.equal(invocation.command, process.execPath);
  assert.equal(invocation.arguments[0], cli);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.windowsHide, true);
  assert.throws(() => npmInvocation("npm.cmd", ["ci"]), /resolved npm-cli\.js/u);
  const original = {
    PATH: "safe",
    CloudFlareAPIKEY: "must-not-reach-child",
    NPM_TOKEN: "also-secret",
    TOOLSPAN_E2E_CF_API_TOKEN: "fixture-api-token",
  };
  assert.deepEqual(verificationEnvironment(original), { PATH: "safe" });
  assert.equal(original.CloudFlareAPIKEY, "must-not-reach-child");
  assert.deepEqual(
    executableCandidates("npm", { Path: "C:\\Node", PATHEXT: ".EXE" }, "win32"),
    ["C:\\Node\\npm.EXE"],
  );
});

test("verification children receive only the documented build environment allowlist", () => {
  const filtered = verificationEnvironment({
    PATH: "fixture-path",
    PATHEXT: ".EXE;.CMD",
    SystemRoot: "C:\\Windows",
    TEMP: "C:\\Temp",
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    USERPROFILE: "C:\\Users\\fixture",
    HOME: "/home/fixture",
    LOCALAPPDATA: "C:\\Users\\fixture\\AppData\\Local",
    npm_execpath: "C:\\node\\npm-cli.js",
    CARGO_HOME: "C:\\cargo",
    RUSTUP_HOME: "C:\\rustup",
    HTTPS_PROXY: "https://fixture-user:fixture-pass@proxy.invalid:8443",
    NPM_CONFIG__AUTH: "fixture-auth",
    NPM_CONFIG_OTP: "fixture-otp",
    CI_JOB_JWT: "fixture-jwt",
    GIT_HTTP_EXTRAHEADER: "fixture-header",
    AWS_ACCESS_KEY_ID: "fixture-access-key",
    GH_TOKEN: "fixture-token",
    SESSION_COOKIE: "fixture-cookie",
    UNDOCUMENTED_ENVIRONMENT: "fixture-unknown",
  });

  assert.deepEqual(Object.keys(filtered).sort(), [
    "CARGO_HOME",
    "HOME",
    "LOCALAPPDATA",
    "PATH",
    "PATHEXT",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "RUSTUP_HOME",
    "SystemRoot",
    "TEMP",
    "USERPROFILE",
    "npm_execpath",
  ].sort());
});

test("Desktop source verification requires every named renderer and native entrypoint", () => {
  const scripts = Object.fromEntries([...REQUIRED_DESKTOP_SCRIPTS, "tauri"].map((name) => [name, "node check.mjs"]));
  assert.deepEqual(validateDesktopPackageScripts({ scripts }), []);
  scripts["test:a11y"] = "echo ...";
  assert.deepEqual(validateDesktopPackageScripts({ scripts }), ["DESKTOP_SCRIPT_NOT_REAL:test:a11y"]);
  assert.deepEqual(sourceVerificationStepNames(), [
    "DESKTOP_ORCHESTRATOR_TESTS",
    "DESKTOP_CLEAN_INSTALL",
    "DESKTOP_HOST_STANDALONE_BUNDLE",
    "RENDERER_TESTS",
    "RENDERER_TYPECHECK",
    "RENDERER_BUILD",
    "I18N_KEY_PARITY",
    "A11Y_SERIOUS_CRITICAL_ZERO",
    "DESKTOP_PROTOCOL_V1",
    "RUSTFMT",
    "RUST_CHECK",
    "RUST_CLIPPY",
    "RUST_TESTS",
    "DESKTOP_SECURITY_BOUNDARIES",
    "CORE_HEADLESS_VERIFICATION",
    "CORE_PACKED_RELEASE_SMOKE",
  ]);
});

test("Tauri shipping resources can start the fixed Desktop host and answer system.hello", async (context) => {
  const resourceRoot = await mkdtemp(path.join(tmpdir(), "toolspan-desktop-resource-layout-test-"));
  context.after(async () => await rm(resourceRoot, { recursive: true, force: true }));
  const configPath = path.join(projectRoot, "apps", "desktop", "src-tauri", "tauri.conf.json");
  const tauriConfig = JSON.parse(await readFile(configPath, "utf8"));
  await stageDesktopResources({
    configPath,
    resourceRoot,
    resources: tauriConfig.bundle.resources,
  });

  const request = await readFile(
    path.join(projectRoot, "tests", "fixtures", "desktop-protocol-v1", "hello.request.jsonl"),
    "utf8",
  );
  const result = await runDesktopResourceHello({ resourceRoot, request });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, "");
  const response = JSON.parse(result.stdout.trim());
  assert.equal(response.id, "1");
  assert.equal(response.ok, true);
  assert.equal(response.result.protocolVersion, 1);
  assert.equal(response.result.productVersion, "0.7.0");
  assert.equal(FIXED_DESKTOP_HOST_RESOURCE, "desktop-host/main.js");
});

test("Desktop resource smoke kills a chattering host at its fixed deadline and bounds diagnostics", async (context) => {
  const resourceRoot = await mkdtemp(path.join(tmpdir(), "toolspan-desktop-resource-timeout-test-"));
  const hostDirectory = path.join(resourceRoot, "desktop-host");
  const pidPath = path.join(resourceRoot, "child.pid");
  let childPid;
  context.after(async () => {
    if (childPid === undefined) {
      try {
        childPid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
      } catch {
        // The child may not have reached its PID sentinel before an assertion failed.
      }
    }
    if (Number.isInteger(childPid)) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        // The smoke helper should already have reaped the child.
      }
    }
    await rm(resourceRoot, { recursive: true, force: true });
  });
  await mkdir(hostDirectory, { recursive: true });
  await writeFile(path.join(hostDirectory, "main.js"), [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "fs.writeFileSync(path.join(process.cwd(), 'child.pid'), String(process.pid));",
    "const chunk = 'x'.repeat(16 * 1024);",
    "const chatter = () => { process.stdout.write(chunk); process.stderr.write(chunk); };",
    "chatter();",
    "setInterval(chatter, 1);",
  ].join("\n"), "utf8");

  const deadlineMs = 200;
  const outputLimitBytes = 4 * 1024;
  const startedAt = Date.now();
  let timeoutError;
  try {
    await Promise.race([
      runDesktopResourceHello({
        resourceRoot,
        request: "",
        deadlineMs,
        outputLimitBytes,
      }),
      new Promise((_, reject) => {
        const watchdog = setTimeout(() => reject(new Error("RESOURCE_SMOKE_TEST_WATCHDOG")), 2_000);
        watchdog.unref();
      }),
    ]);
    assert.fail("Expected the chattering host to time out");
  } catch (error) {
    timeoutError = error;
  }
  const elapsedMs = Date.now() - startedAt;

  assert.equal(timeoutError.code, "DESKTOP_RESOURCE_HELLO_TIMEOUT");
  assert.ok(elapsedMs >= deadlineMs, `deadline fired early after ${elapsedMs} ms`);
  assert.ok(elapsedMs < 1_500, `deadline was extended by child output (${elapsedMs} ms)`);
  assert.ok(Buffer.byteLength(timeoutError.stdout, "utf8") <= outputLimitBytes);
  assert.ok(Buffer.byteLength(timeoutError.stderr, "utf8") <= outputLimitBytes);
  assert.equal(timeoutError.stdoutTruncated, true);
  assert.equal(timeoutError.stderrTruncated, true);

  childPid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
  assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
  await rm(resourceRoot, { recursive: true, force: true });
});

test("Visual Studio discovery accepts one absolute installation and checks standard vswhere locations", () => {
  assert.equal(isSupportedDesktopNodeVersion("v22.16.0"), false);
  assert.equal(isSupportedDesktopNodeVersion("v22.17.0"), true);
  assert.equal(isSupportedDesktopNodeVersion("24.9.1"), true);
  assert.equal(isSupportedDesktopNodeVersion("23.1.0"), false);
  assert.equal(isSupportedDesktopNodeVersion("25.0.0"), false);
  assert.equal(
    parseVsWhereInstallationPath("C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\r\n"),
    path.normalize("C:\\Program Files\\Microsoft Visual Studio\\2022\\Community"),
  );
  assert.equal(parseVsWhereInstallationPath("relative\\visual-studio\n"), null);
  assert.equal(parseVsWhereInstallationPath("C:\\one\nC:\\two\n"), null);
  assert.deepEqual(vsWhereCandidates({
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    ProgramFiles: "C:\\Program Files",
  }), [
    "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe",
    "C:\\Program Files\\Microsoft Visual Studio\\Installer\\vswhere.exe",
  ]);
});

test("Windows native verification reports every absent capability as BLOCKED, never PASS", () => {
  assert.deepEqual(classifyWindowsPrerequisites({
    platform: "linux",
    architecture: "x64",
    desktopInputs: false,
    npmCli: false,
    visualStudio: false,
    powershell: false,
    cscript: false,
    vbscript: false,
    webView2: false,
  }), [
    "WINDOWS_X64_REQUIRED",
    "DESKTOP_SOURCE_INPUT_MISSING",
    "NPM_CLI_NOT_FOUND",
    "MSVC_BUILD_TOOLS_NOT_DETECTED",
    "WINDOWS_POWERSHELL_NOT_FOUND",
    "CSCRIPT_NOT_FOUND",
    "VBSCRIPT_ENGINE_UNAVAILABLE",
    "WEBVIEW2_NOT_DETECTED",
  ]);
  assert.deepEqual(classifyWindowsPrerequisites({
    platform: "win32",
    architecture: "x64",
    desktopInputs: true,
    npmCli: true,
    visualStudio: true,
    powershell: true,
    cscript: true,
    vbscript: true,
    webView2: true,
  }), []);
});

test("Windows Tauri build pipeline refuses to package a stale renderer", async () => {
  const [desktopPackage, visualStudioHelper] = await Promise.all([
    readFile(path.join(projectRoot, "apps", "desktop", "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(projectRoot, "scripts", "invoke-desktop-vs.ps1"), "utf8"),
  ]);

  assert.deepEqual(validateWindowsTauriBuildPipeline({
    desktopPackage,
    visualStudioHelper,
  }), []);

  assert.deepEqual(validateWindowsTauriBuildPipeline({
    desktopPackage,
    visualStudioHelper: visualStudioHelper.replace(
      "& $NodePath $NpmCliPath --prefix $DesktopRoot run build",
      "",
    ),
  }), ["DESKTOP_RENDERER_BUILD_NOT_IN_TAURI_PIPELINE"]);
});

test("Windows Tauri build pipeline requires renderer typecheck and Vite build", async () => {
  const [desktopPackage, visualStudioHelper] = await Promise.all([
    readFile(path.join(projectRoot, "apps", "desktop", "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(projectRoot, "scripts", "invoke-desktop-vs.ps1"), "utf8"),
  ]);

  assert.deepEqual(validateWindowsTauriBuildPipeline({
    desktopPackage: {
      ...desktopPackage,
      scripts: { ...desktopPackage.scripts, build: "vite build" },
    },
    visualStudioHelper,
  }), ["DESKTOP_RENDERER_BUILD_SCRIPT_INVALID"]);
});

test("Windows Tauri build pipeline propagates renderer build failure before packaging", async () => {
  const [desktopPackage, visualStudioHelper] = await Promise.all([
    readFile(path.join(projectRoot, "apps", "desktop", "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(projectRoot, "scripts", "invoke-desktop-vs.ps1"), "utf8"),
  ]);
  const withoutRendererFailureCheck = visualStudioHelper.replace(
    /(& \$NodePath \$NpmCliPath --prefix \$DesktopRoot run build)\r?\n\s*if \(\$LASTEXITCODE -ne 0\) \{\r?\n\s*exit \$LASTEXITCODE\r?\n\s*\}/u,
    "$1",
  );

  assert.notEqual(withoutRendererFailureCheck, visualStudioHelper);
  assert.deepEqual(validateWindowsTauriBuildPipeline({
    desktopPackage,
    visualStudioHelper: withoutRendererFailureCheck,
  }), ["DESKTOP_RENDERER_BUILD_FAILURE_NOT_PROPAGATED"]);
});

test("Windows release verification requires the current x64 MSI and NSIS pair and emits a sanitized inventory", async (context) => {
  const temporaryRoot = await mkdtemp(path.join(projectRoot, ".toolspan-dev", "desktop-release-bundle-test-"));
  context.after(async () => await rm(temporaryRoot, { recursive: true, force: true }));
  const msiRoot = path.join(temporaryRoot, "msi");
  const nsisRoot = path.join(temporaryRoot, "nsis");
  await Promise.all([mkdir(msiRoot), mkdir(nsisRoot)]);

  const staleMsi = path.join(msiRoot, "ToolSpan_0.4.0_x64_en-US.msi");
  const staleNsis = path.join(nsisRoot, "ToolSpan_0.4.0_x64-setup.exe");
  const currentMsi = path.join(msiRoot, "ToolSpan_0.5.0_x64_en-US.msi");
  const currentNsis = path.join(nsisRoot, "ToolSpan_0.5.0_x64-setup.exe");
  await Promise.all([
    writeFile(staleMsi, "stale msi", "utf8"),
    writeFile(staleNsis, "stale nsis", "utf8"),
  ]);

  const verify = async () => await verifyDesktopWindows({
    capabilities: {
      platform: "win32",
      architecture: "x64",
      nodeVersion: "24.1.0",
      desktopInputs: true,
      npmCli: "C:\\node\\npm-cli.js",
      visualStudio: { launchVsDevShell: "C:\\VS\\Launch-VsDevShell.ps1" },
      powershell: "C:\\Windows\\powershell.exe",
      cscript: "C:\\Windows\\cscript.exe",
      vbscript: true,
      webView2: true,
    },
    packageVersion: "0.5.0",
    bundleRoot: temporaryRoot,
    install: async () => ({ status: "PASS", exitCode: 0 }),
    runVsOperation: async () => ({ started: true, code: 0 }),
  });

  const staleOnly = await verify();
  assert.equal(staleOnly.status, "FAIL");
  assert.equal(staleOnly.reason, "TAURI_CURRENT_VERSION_BUNDLE_INCOMPLETE");

  const msiContents = "current unsigned msi";
  await writeFile(currentMsi, msiContents, "utf8");
  const singleCurrentInstaller = await verify();
  assert.equal(singleCurrentInstaller.status, "FAIL");
  assert.equal(singleCurrentInstaller.reason, "TAURI_CURRENT_VERSION_BUNDLE_INCOMPLETE");

  const nsisContents = "current unsigned nsis";
  await writeFile(currentNsis, nsisContents, "utf8");
  await rm(currentMsi);
  const singleCurrentNsis = await verify();
  assert.equal(singleCurrentNsis.status, "FAIL");
  assert.equal(singleCurrentNsis.reason, "TAURI_CURRENT_VERSION_BUNDLE_INCOMPLETE");

  await writeFile(currentMsi, msiContents, "utf8");
  const result = await verify();
  assert.equal(result.status, "EXTERNAL_GATE_PENDING");
  assert.equal(result.gate, "WINDOWS_NATIVE_VALIDATION");
  assert.equal(result.validatedSubgate, "WINDOWS_RELEASE_NATIVE_BUILD");
  assert.notEqual(result.status, "PASS");
  assert.equal(result.bundleArtifactCount, 2);
  assert.ok(result.checks.indexOf("DESKTOP_RENDERER_TYPECHECK") >= 0);
  assert.ok(result.checks.indexOf("DESKTOP_RENDERER_TYPECHECK") < result.checks.indexOf("DESKTOP_RENDERER_BUILD"));
  assert.ok(result.checks.indexOf("DESKTOP_RENDERER_BUILD") < result.checks.indexOf("TAURI_RELEASE_BUILD"));
  assert.deepEqual(result.bundleArtifacts, [
    {
      path: path.relative(projectRoot, currentMsi).split(path.sep).join("/"),
      bytes: Buffer.byteLength(msiContents),
      sha256: createHash("sha256").update(msiContents).digest("hex"),
    },
    {
      path: path.relative(projectRoot, currentNsis).split(path.sep).join("/"),
      bytes: Buffer.byteLength(nsisContents),
      sha256: createHash("sha256").update(nsisContents).digest("hex"),
    },
  ]);
  assert.equal(JSON.stringify(result).includes(temporaryRoot), false);
  assert.deepEqual(result.manualEvidencePending, ["INSTALL_SMOKE", "TRAY_SMOKE", "OWNED_PROCESS_SMOKE"]);

  const visualStudioHelper = await readFile(path.join(projectRoot, "scripts", "invoke-desktop-vs.ps1"), "utf8");
  const rootBuild = visualStudioHelper.indexOf("& $NodePath $NpmCliPath --prefix $ProjectRoot run build");
  const tauriBuild = visualStudioHelper.indexOf("& $NodePath $NpmCliPath --prefix $DesktopRoot run tauri -- build");
  assert.ok(rootBuild >= 0 && tauriBuild > rootBuild);
  assert.match(visualStudioHelper, /run tauri -- build\s*$/mu);
  assert.doesNotMatch(visualStudioHelper, /--debug/u);
});

test("security analyzer enforces topology, protocol, password, config and process boundaries", () => {
  const files = [
    { relativePath: "src/http-app.ts", text: "app.get('/healthz', handler);" },
    {
      relativePath: "apps/desktop/src-tauri/src/lib.rs",
      text: [
        "struct OwnedChild { child: std::process::Child, ownership_nonce: String }",
        "fn hash_owner_password() { bcrypt::hash(\"value\", 12); }",
        "fn atomic_config(expected_hash: String) { rename(); backup(); }",
      ].join("\n"),
    },
  ];
  const documents = {
    rootPackage: { dependencies: {}, devDependencies: {} },
    rootLock: { packages: {} },
    tauriConfig: { app: { security: { csp: "default-src 'self'" } } },
    protocolSchema: { properties: { method: { enum: ["system.hello", "runtime.getSnapshot"] } } },
    cargoManifest: "bcrypt = '=0.17.1'",
    capabilities: [{ name: "main.json", document: { permissions: ["core:default", "dialog:allow-open"] } }],
  };
  assert.deepEqual(analyzeDesktopSecurity(files, documents), []);
  files.push({
    relativePath: "apps/desktop/src/danger.ts",
    text: "import '@tauri-apps/plugin-shell'; localStorage.setItem('password', value);",
  });
  const violations = analyzeDesktopSecurity(files, documents);
  assert.ok(violations.some((item) => item.code === "ARBITRARY_SHELL_SURFACE"));
  assert.ok(violations.some((item) => item.code === "PASSWORD_BROWSER_STORAGE"));
});

test("security analyzer requires the single-instance guard before Desktop setup", () => {
  const files = [
    { relativePath: "src/http-app.ts", text: "app.get('/healthz', handler);" },
    {
      relativePath: "apps/desktop/src-tauri/src/lib.rs",
      text: [
        "struct OwnedChild { child: std::process::Child, ownership_nonce: String }",
        "fn hash_owner_password() { bcrypt::hash(\"value\", 12); }",
        "fn atomic_config(expected_hash: String) { rename(); backup(); }",
      ].join("\n"),
    },
    {
      relativePath: "apps/desktop/src-tauri/src/app.rs",
      text: [
        "tauri::Builder::default()",
        "  .plugin(tauri_plugin_dialog::init())",
        "  .setup(|app| { DesktopState::new(); Ok(()) });",
      ].join("\n"),
    },
  ];
  const documents = {
    rootPackage: { dependencies: {}, devDependencies: {} },
    rootLock: { packages: {} },
    tauriConfig: { app: { security: { csp: "default-src 'self'" } } },
    protocolSchema: { properties: { method: { enum: ["system.hello"] } } },
    cargoManifest: "bcrypt = '=0.17.1'",
    capabilities: [{ name: "main.json", document: { permissions: ["core:default"] } }],
  };

  const missingCodes = analyzeDesktopSecurity(files, documents).map((item) => item.code);
  assert.ok(missingCodes.includes("SINGLE_INSTANCE_GUARD_MISSING"));
  assert.ok(missingCodes.includes("SINGLE_INSTANCE_GUARD_NOT_FIRST"));
  assert.ok(missingCodes.includes("SINGLE_INSTANCE_WINDOW_RESTORE_MISSING"));

  files[2].text = [
    "tauri::Builder::default()",
    "  .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {",
    "    show_main_window(app);",
    "  }))",
    "  .plugin(tauri_plugin_dialog::init())",
    "  .setup(|app| { DesktopState::new(); Ok(()) });",
    "fn show_main_window(app: &tauri::AppHandle) {",
    "  if let Some(window) = app.get_webview_window(\"main\") {",
    "    let _ = window.show();",
    "    let _ = window.unminimize();",
    "    let _ = window.set_focus();",
    "  }",
    "}",
  ].join("\n");
  documents.cargoManifest = [
    "bcrypt = '=0.17.1'",
    "tauri-plugin-single-instance = '=2.4.3'",
  ].join("\n");

  const guardedCodes = analyzeDesktopSecurity(files, documents)
    .map((item) => item.code)
    .filter((code) => code.startsWith("SINGLE_INSTANCE_"));
  assert.deepEqual(guardedCodes, []);
});

test("security analyzer preserves the main window while safe quit is confirmed", () => {
  const files = [
    {
      relativePath: "apps/desktop/src-tauri/src/lib.rs",
      text: [
        "struct OwnedChild { child: std::process::Child, ownership_nonce: String }",
        "fn hash_owner_password() { bcrypt::hash(\"value\", 12); }",
        "fn atomic_config(expected_hash: String) { rename(); backup(); }",
      ].join("\n"),
    },
    {
      relativePath: "apps/desktop/src-tauri/src/app.rs",
      text: [
        "tauri::Builder::default()",
        "  .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {",
        "    show_main_window(app);",
        "  }))",
        "  .setup(|app| { DesktopState::new(); Ok(()) });",
        "fn show_main_window(app: &tauri::AppHandle) {",
        "  if let Some(window) = app.get_webview_window(\"main\") {",
        "    let _ = window.show();",
        "    let _ = window.unminimize();",
        "    let _ = window.set_focus();",
        "  }",
        "}",
      ].join("\n"),
    },
  ];
  const documents = {
    rootPackage: { dependencies: {}, devDependencies: {} },
    rootLock: { packages: {} },
    tauriConfig: { app: { security: { csp: "default-src 'self'" } } },
    protocolSchema: { properties: { method: { enum: ["system.hello"] } } },
    cargoManifest: "bcrypt = '=0.17.1'\ntauri-plugin-single-instance = '=2.4.3'",
    capabilities: [{ name: "main.json", document: { permissions: ["core:default"] } }],
  };

  const missingCodes = analyzeDesktopSecurity(files, documents).map((item) => item.code);
  assert.ok(missingCodes.includes("MAIN_WINDOW_CLOSE_GUARD_MISSING"));

  files[1].text = files[1].text.replace(
    "  .setup(|app| { DesktopState::new(); Ok(()) });",
    [
      "  .on_window_event(|window, event| {",
      "    if window.label() != \"main\" { return; }",
      "    if let WindowEvent::CloseRequested { api, .. } = event {",
      "      api.prevent_close();",
      "      request_safe_quit(window.app_handle());",
      "    }",
      "  })",
      "  .setup(|app| { DesktopState::new(); Ok(()) });",
    ].join("\n"),
  );

  const guardedCodes = analyzeDesktopSecurity(files, documents)
    .map((item) => item.code)
    .filter((code) => code === "MAIN_WINDOW_CLOSE_GUARD_MISSING");
  assert.deepEqual(guardedCodes, []);

  files[1].text = files[1].text.replace(
    "      request_safe_quit(window.app_handle());",
    "      request_safe_quit(window.app_handle()); window.close();",
  );
  const destructiveCodes = analyzeDesktopSecurity(files, documents).map((item) => item.code);
  assert.ok(destructiveCodes.includes("MAIN_WINDOW_CLOSE_GUARD_MISSING"));
});

test("security analyzer suppresses the Windows console only for release builds", () => {
  const files = [
    {
      relativePath: "apps/desktop/src-tauri/src/lib.rs",
      text: [
        "struct OwnedChild { child: std::process::Child, ownership_nonce: String }",
        "fn hash_owner_password() { bcrypt::hash(\"value\", 12); }",
        "fn atomic_config(expected_hash: String) { rename(); backup(); }",
      ].join("\n"),
    },
    {
      relativePath: "apps/desktop/src-tauri/src/main.rs",
      text: "fn main() { toolspan_desktop_lib::run(); }",
    },
  ];
  const documents = {
    rootPackage: { dependencies: {}, devDependencies: {} },
    rootLock: { packages: {} },
    tauriConfig: { app: { security: { csp: "default-src 'self'" } } },
    protocolSchema: { properties: { method: { enum: ["system.hello"] } } },
    cargoManifest: "bcrypt = '=0.17.1'",
    capabilities: [{ name: "main.json", document: { permissions: ["core:default"] } }],
  };

  const missingCodes = analyzeDesktopSecurity(files, documents).map((item) => item.code);
  assert.ok(missingCodes.includes("WINDOWS_RELEASE_GUI_SUBSYSTEM_MISSING"));

  files[1].text = [
    "#![cfg_attr(not(debug_assertions), windows_subsystem = \"windows\")]",
    "fn main() { toolspan_desktop_lib::run(); }",
  ].join("\n");

  const guardedCodes = analyzeDesktopSecurity(files, documents)
    .map((item) => item.code)
    .filter((code) => code === "WINDOWS_RELEASE_GUI_SUBSYSTEM_MISSING");
  assert.deepEqual(guardedCodes, []);
});

test("security analyzer rejects inherited environments in Node validation and discovery children", () => {
  const files = [
    {
      relativePath: "apps/desktop/src-tauri/src/lib.rs",
      text: [
        "struct OwnedChild { child: std::process::Child, ownership_nonce: String }",
        "fn hash_owner_password() { bcrypt::hash(\"value\", 12); }",
        "fn atomic_config(expected_hash: String) { rename(); backup(); }",
      ].join("\n"),
    },
    {
      relativePath: "apps/desktop/src-tauri/src/node.rs",
      text: [
        "fn validate_node_executable(path: &Path) {",
        "  Command::new(path).arg(\"--version\");",
        "}",
        "fn where_candidates() {",
        "  Command::new(\"where.exe\").arg(\"node.exe\");",
        "}",
      ].join("\n"),
    },
  ];
  const documents = {
    rootPackage: { dependencies: {}, devDependencies: {} },
    rootLock: { packages: {} },
    tauriConfig: { app: { security: { csp: "default-src 'self'" } } },
    protocolSchema: { properties: { method: { enum: ["system.hello"] } } },
    cargoManifest: "bcrypt = '=0.17.1'",
    capabilities: [{ name: "main.json", document: { permissions: ["core:default"] } }],
  };

  const codes = analyzeDesktopSecurity(files, documents).map((item) => item.code);
  assert.ok(codes.includes("NODE_VERSION_PROBE_ENV_INHERITANCE"));
  assert.ok(codes.includes("NODE_DISCOVERY_ENV_INHERITANCE"));
});

test("requirements matrix contains all 15 Desktop Goal IDs and keeps native validation out of source completion", async () => {
  const requirements = JSON.parse(await readFile(path.join(projectRoot, "goal", "requirements.json"), "utf8"));
  const desktop = requirements.requirements.filter((item) => item.stage === "DESKTOP");
  assert.deepEqual(desktop.map((item) => item.id).sort(), [
    "D-A11Y-01", "D-ARCH-01", "D-CONFIG-01", "D-FEATURE-01", "D-HEADLESS-01",
    "D-I18N-01", "D-NODE-01", "D-PASS-01", "D-PROC-01", "D-PROTO-01",
    "D-THEME-01", "D-TOPO-01", "D-TRAY-01", "D-UI-01", "D-WIN-01",
  ]);
  const native = desktop.find((item) => item.id === "D-WIN-01");
  assert.equal(native.gateType, "native");
  assert.deepEqual(native.blockingFor, ["RELEASE_READY"]);
});
