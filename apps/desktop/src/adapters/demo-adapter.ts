import type {
  ConnectionTestResult,
  DesktopAdapter,
  DesktopArtifact,
  DesktopJob,
  DesktopLogEntry,
  FirstRunInput,
  JobFilter,
  LogFilter,
  RuntimeSnapshot,
  SetupSafeManifest,
  SetupSnapshot,
  WorkspaceRoot,
} from "./types";

const demoJobs: DesktopJob[] = [
  {
    id: "job-demo-01",
    label: "Generate release notes",
    runner: "node-script",
    status: "completed",
    createdAt: "2026-01-15T10:20:00.000Z",
    finishedAt: "2026-01-15T10:20:12.000Z",
    sanitizedOutput: "Completed with 3 artifacts. Sensitive values were removed.",
  },
  {
    id: "job-demo-02",
    label: "Verify workspace",
    runner: "npm-script",
    status: "running",
    createdAt: "2026-01-15T10:24:00.000Z",
  },
];

const demoArtifacts: DesktopArtifact[] = [
  {
    id: "artifact-demo-01",
    name: "release-notes.md",
    mediaType: "text/markdown",
    sizeBytes: 4821,
    createdAt: "2026-01-15T10:20:12.000Z",
    localPath: "C:\\ToolSpan-Demo\\artifacts\\release-notes.md",
  },
];

const demoLogs: DesktopLogEntry[] = [
  {
    id: "log-demo-01",
    timestamp: "2026-01-15T10:24:04.000Z",
    level: "info",
    source: "runtime",
    message: "Local endpoint is ready.",
  },
  {
    id: "log-demo-02",
    timestamp: "2026-01-15T10:24:06.000Z",
    level: "warn",
    source: "connection",
    message: "Public endpoint has not been configured.",
  },
];

export const demoSnapshot: RuntimeSnapshot = {
  firstRunRequired: false,
  instanceName: "Demo workstation",
  core: {
    state: "running",
    version: "demo",
    managedByDesktop: true,
    uptimeSeconds: 7325,
    nodeVersion: "v24-demo",
    nodePathConfigured: true,
  },
  connection: {
    localUrl: "http://127.0.0.1:8787/mcp",
    publicBaseUrl: null,
    oauthDiscoveryUrl: null,
    localReady: true,
    publicReady: null,
  },
  toolContract: { available: 27, total: 27 },
  workspaces: [
    {
      id: "workspace-demo-01",
      name: "Demo project",
      path: "C:\\ToolSpan-Demo\\workspace",
      access: "read-write",
    },
  ],
  recentJobs: demoJobs,
  recentArtifacts: demoArtifacts,
  statePath: "C:\\ToolSpan-Demo\\state",
  logPath: "C:\\ToolSpan-Demo\\logs",
  ownerPasswordConfigured: true,
  lastUpdatedAt: "2026-01-15T10:24:07.000Z",
};

export const demoSetupSnapshot: SetupSnapshot = {
  sessionId: "setup-demo-session",
  phase: "IDLE",
  path: null,
  domain: "example.test",
  desiredHostname: "mcp.example.test",
  zone: {
    exists: true,
    status: "active",
    accountId: "account-demo",
    zoneId: "zone-demo",
    assignedNameservers: [],
  },
  plan: null,
  rollback: null,
  verificationEvidence: [],
  duplicateCreates: null,
  requiresCredential: false,
  safeManifest: {
    schemaVersion: "1.0",
    toolSpanVersion: "demo",
    instanceName: "Demo workstation",
    localUrl: "http://127.0.0.1:8787/mcp",
    desiredHostname: "mcp.example.test",
    publicMcpUrl: "https://mcp.example.test/mcp",
    oauthDiscoveryUrl: "https://mcp.example.test/.well-known/oauth-authorization-server",
    expectedToolCount: 27,
    tunnelName: "toolspan-demo",
    domainChoice: "existing",
    officialDocs: [
      "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/",
      "https://platform.openai.com/docs/mcp",
    ],
    generatedAt: "2026-01-15T10:24:07.000Z",
  },
  chatGptStatus: "MANUAL_PENDING",
  guideCurrent: false,
  commercialOffer: { current: false, example: null, coupon: null },
  vendorAssets: "text_only_fallback",
  lastErrorCode: null,
};

export interface DemoAdapterOptions {
  snapshot?: RuntimeSnapshot;
  setupSnapshot?: SetupSnapshot;
  delayMs?: number;
}

export function createDemoDesktopAdapter(options: DemoAdapterOptions = {}): DesktopAdapter {
  let snapshot = structuredClone(options.snapshot ?? demoSnapshot);
  let setupSnapshot = structuredClone(options.setupSnapshot ?? demoSetupSnapshot);
  let workspaces = structuredClone(snapshot.workspaces);

  async function delay(): Promise<void> {
    if ((options.delayMs ?? 0) > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
  }

  async function connectionResult(target: "local" | "public"): Promise<ConnectionTestResult> {
    await delay();
    const isLocal = target === "local";
    return {
      target,
      ok: isLocal ? snapshot.connection.localReady : snapshot.connection.publicReady === true,
      latencyMs: isLocal ? 18 : 0,
      status: isLocal ? "READY" : "NOT_CONFIGURED",
      checkedUrl: isLocal
        ? snapshot.connection.localUrl
        : (snapshot.connection.publicBaseUrl ?? "not-configured"),
      checkedAt: snapshot.lastUpdatedAt,
    };
  }

  return {
    async getSnapshot() {
      await delay();
      return structuredClone({ ...snapshot, workspaces });
    },
    async start() {
      snapshot = { ...snapshot, core: { ...snapshot.core, state: "running" } };
    },
    async stop() {
      snapshot = { ...snapshot, core: { ...snapshot.core, state: "stopped" } };
    },
    async restart() {
      snapshot = { ...snapshot, core: { ...snapshot.core, state: "running" } };
    },
    testLocal: () => connectionResult("local"),
    testPublic: () => connectionResult("public"),
    async pickAllowedRoot() {
      const root: WorkspaceRoot = {
        id: `workspace-demo-${workspaces.length + 1}`,
        name: "Selected folder",
        path: "C:\\ToolSpan-Demo\\selected",
        access: "read-write",
      };
      workspaces = [...workspaces, root];
      return structuredClone(root);
    },
    async removeAllowedRoot(id) {
      workspaces = workspaces.filter((root) => root.id !== id);
    },
    async listJobs(filter?: JobFilter) {
      await delay();
      return demoJobs.filter((job) => {
        const statusMatches = filter?.status === undefined || job.status === filter.status;
        const queryMatches = filter?.query === undefined
          || job.label.toLowerCase().includes(filter.query.toLowerCase());
        return statusMatches && queryMatches;
      });
    },
    async cancelJob() {
      await delay();
    },
    async listArtifacts() {
      await delay();
      return structuredClone(demoArtifacts);
    },
    async getLogs(filter?: LogFilter) {
      await delay();
      return demoLogs.filter((entry) => {
        const levelMatches = filter?.level === undefined || entry.level === filter.level;
        const queryMatches = filter?.query === undefined
          || entry.message.toLowerCase().includes(filter.query.toLowerCase());
        return levelMatches && queryMatches;
      });
    },
    async hashOwnerPassword() {
      await delay();
      return "$2b$demo-hash-without-plaintext";
    },
    async completeFirstRun(input: FirstRunInput) {
      snapshot = {
        ...snapshot,
        firstRunRequired: false,
        instanceName: input.instanceName,
        statePath: input.statePath,
        logPath: input.logPath,
        ownerPasswordConfigured: true,
        core: { ...snapshot.core, state: input.startAfterSave ? "running" : "stopped" },
      };
    },
    async updateOwnerPasswordHash() {
      await delay();
    },
    async chooseNodeExecutable() {
      await delay();
    },
    async getSetupSnapshot() {
      await delay();
      return structuredClone(setupSnapshot);
    },
    async setSetupCredential(_sessionId, _credential) {
      await delay();
    },
    async setupPreflight(sessionId, _idempotencyKey, zoneName, manifest: SetupSafeManifest) {
      await delay();
      setupSnapshot = {
        ...setupSnapshot,
        sessionId,
        phase: "PREFLIGHT",
        path: "scoped_api_token",
        domain: zoneName,
        desiredHostname: manifest.desiredHostname,
        safeManifest: structuredClone(manifest),
      };
      return structuredClone(setupSnapshot);
    },
    async setupPlan() {
      await delay();
      setupSnapshot = {
        ...setupSnapshot,
        phase: "WAITING_FOR_CONFIRMATION",
        plan: {
          sideEffectsApplied: false,
          warnings: [],
          items: [
            { id: "tunnel", resource: "Named tunnel", disposition: "reused", summary: "Reuse a matching healthy tunnel." },
            { id: "ingress", resource: "Ingress", disposition: "updated", summary: "Route the hostname to the configured local Core." },
            { id: "dns", resource: "DNS record", disposition: "created", summary: "Create the missing proxied CNAME." },
            { id: "service", resource: "cloudflared service", disposition: "untouched", summary: "Existing external service remains unchanged." },
          ],
        },
      };
      return structuredClone(setupSnapshot);
    },
    async setupApply() {
      await delay();
      setupSnapshot = {
        ...setupSnapshot,
        phase: "COMPLETE",
        verificationEvidence: [
          { check: "public_endpoint", passed: true, detail: "Configured HTTPS endpoint responded successfully." },
          { check: "tool_contract", passed: true, detail: "Exactly 27 tools were observed." },
        ],
        duplicateCreates: 0,
      };
      return structuredClone(setupSnapshot);
    },
    async setupRollback() {
      await delay();
      setupSnapshot = {
        ...setupSnapshot,
        phase: "ROLLED_BACK",
        rollback: { status: "full", remainingResources: [], manualSteps: [] },
      };
      return structuredClone(setupSnapshot);
    },
    async setupReconcile() {
      await delay();
      setupSnapshot = { ...setupSnapshot, phase: "WAITING_FOR_CONFIRMATION", requiresCredential: false };
      return structuredClone(setupSnapshot);
    },
    async discardSetupCredential() {
      await delay();
    },
    async onTrayAction() {
      return () => undefined;
    },
    async onQuitRequested() {
      return () => undefined;
    },
    async acknowledgeQuitRequest() {
      await delay();
    },
    async confirmQuit() {
      await delay();
    },
  };
}
