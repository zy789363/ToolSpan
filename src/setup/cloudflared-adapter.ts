export interface CloudflaredStatus {
  installed: boolean;
  version?: string;
  officialSource?: boolean;
  serviceInstalled: boolean;
  serviceId?: string;
  serviceFingerprint?: string;
  ownedBySession?: boolean;
  ownerSessionId?: string;
}

export interface CloudflaredInstallInput {
  sessionId: string;
  tunnelId: string;
  hostname: string;
  localUrl: string;
  runtimeCredential: string;
}

export interface CloudflaredInstallResult extends CloudflaredStatus {
  installed: true;
  serviceInstalled: true;
  serviceId: string;
  serviceFingerprint: string;
  ownedBySession: boolean;
  ownerSessionId: string;
}

export interface CloudflaredAdapter {
  /** Manual adapters must stop before remote mutation; they cannot claim an automatic Apply. */
  readonly automationMode?: "automatic" | "manual";
  inspect(): Promise<CloudflaredStatus>;
  install(input: CloudflaredInstallInput): Promise<CloudflaredInstallResult>;
  uninstallOwnedService(input: { sessionId: string; serviceId: string; expectedFingerprint: string }): Promise<{ removed: boolean }>;
  verify(input: { serviceId: string }): Promise<{ healthy: boolean; checkedAt: string }>;
}

export class CloudflaredManualCheckpointError extends Error {
  readonly code = "MANUAL_OR_UAC_REQUIRED" as const;

  constructor() {
    super("cloudflared installation requires a manual or UAC-approved checkpoint");
    this.name = "CloudflaredManualCheckpointError";
  }
}

export function createManualCloudflaredAdapter(): CloudflaredAdapter {
  return {
    automationMode: "manual",
    async inspect() {
      return { installed: false, serviceInstalled: false };
    },
    async install(input) {
      // JS strings cannot be overwritten in-place; remove the only adapter-owned reference
      // immediately and never log, serialize, or place it on a command line.
      input.runtimeCredential = "";
      throw new CloudflaredManualCheckpointError();
    },
    async uninstallOwnedService() {
      return { removed: false };
    },
    async verify() {
      return { healthy: false, checkedAt: new Date().toISOString() };
    },
  };
}
