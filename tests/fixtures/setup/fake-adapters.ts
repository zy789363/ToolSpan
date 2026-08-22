import type {
  CloudflareAccount,
  CloudflareAdapter,
  CloudflareCredential,
  CloudflareDnsRecord,
  CloudflarePage,
  CloudflareRequestContext,
  CloudflareTunnel,
  CloudflareTunnelConfig,
  CloudflareZone,
} from "../../../src/setup/cloudflare-adapter.js";
import type {
  CloudflaredAdapter,
  CloudflaredInstallInput,
  CloudflaredInstallResult,
  CloudflaredStatus,
} from "../../../src/setup/cloudflared-adapter.js";

export class FakeCloudflareAdapter implements CloudflareAdapter {
  readonly calls: string[] = [];
  readonly mutationCalls: string[] = [];
  accounts: CloudflareAccount[] = [{ id: "account-1", name: "Test account" }];
  zones: CloudflareZone[] = [
    {
      id: "zone-1",
      accountId: "account-1",
      name: "example.test",
      status: "active",
      nameservers: ["alice.ns.cloudflare.com", "bob.ns.cloudflare.com"],
    },
  ];
  tunnels: CloudflareTunnel[] = [];
  dnsRecords: CloudflareDnsRecord[] = [];
  tunnelConfigs = new Map<string, CloudflareTunnelConfig>();
  failures = new Map<string, Error>();
  healthy = true;
  runtimeCredential = "fake-runtime-token";

  async verifyCredential(input: { credential: CloudflareCredential }): Promise<{ valid: true }> {
    this.maybeFail("verifyCredential");
    this.record("verifyCredential", input.credential);
    return { valid: true };
  }

  async listAccounts(input: CloudflareRequestContext): Promise<CloudflarePage<CloudflareAccount>> {
    this.maybeFail("listAccounts");
    this.record("listAccounts", input.credential);
    return { items: this.accounts, page: 1, totalPages: 1 };
  }

  async listZones(input: CloudflareRequestContext & { accountId?: string; name?: string }): Promise<CloudflarePage<CloudflareZone>> {
    this.maybeFail("listZones");
    this.record("listZones", input.credential);
    const items = this.zones.filter(
      (zone) =>
        (input.accountId === undefined || zone.accountId === input.accountId) &&
        (input.name === undefined || zone.name === input.name),
    );
    return { items, page: 1, totalPages: 1 };
  }

  async listTunnels(input: CloudflareRequestContext & { accountId: string; name?: string }): Promise<CloudflarePage<CloudflareTunnel>> {
    this.maybeFail("listTunnels");
    this.record("listTunnels", input.credential);
    const items = this.tunnels.filter(
      (tunnel) => input.name === undefined || tunnel.name === input.name,
    );
    return { items, page: 1, totalPages: 1 };
  }

  async createTunnel(input: CloudflareRequestContext & { accountId: string; name: string; idempotencyKey: string }): Promise<CloudflareTunnel> {
    this.maybeFail("createTunnel");
    this.recordMutation("createTunnel", input.credential);
    const tunnel = {
      id: `tunnel-${this.tunnels.length + 1}`,
      accountId: input.accountId,
      name: input.name,
      status: "inactive" as const,
      ownedByToolSpan: true,
      ownershipKey: input.idempotencyKey,
    };
    this.tunnels.push(tunnel);
    return tunnel;
  }

  async readTunnelConfig(input: CloudflareRequestContext & { accountId: string; tunnelId: string }): Promise<CloudflareTunnelConfig | undefined> {
    this.maybeFail("readTunnelConfig");
    this.record("readTunnelConfig", input.credential);
    return this.tunnelConfigs.get(input.tunnelId);
  }

  async updateTunnelConfig(input: CloudflareRequestContext & { accountId: string; tunnelId: string; config: CloudflareTunnelConfig; expectedFingerprint?: string }): Promise<CloudflareTunnelConfig> {
    this.maybeFail("updateTunnelConfig");
    this.recordMutation("updateTunnelConfig", input.credential);
    this.tunnelConfigs.set(input.tunnelId, input.config);
    return input.config;
  }

  async getTunnelRuntimeCredential(input: CloudflareRequestContext & { accountId: string; tunnelId: string }): Promise<{ token: string }> {
    this.maybeFail("getTunnelRuntimeCredential");
    this.record("getTunnelRuntimeCredential", input.credential);
    return { token: this.runtimeCredential };
  }

  async listDnsRecords(input: CloudflareRequestContext & { zoneId: string; name?: string }): Promise<CloudflarePage<CloudflareDnsRecord>> {
    this.maybeFail("listDnsRecords");
    this.record("listDnsRecords", input.credential);
    const items = this.dnsRecords.filter(
      (record) => input.name === undefined || record.name === input.name,
    );
    return { items, page: 1, totalPages: 1 };
  }

  async createDnsRecord(input: CloudflareRequestContext & { zoneId: string; record: Omit<CloudflareDnsRecord, "id" | "zoneId">; idempotencyKey: string }): Promise<CloudflareDnsRecord> {
    this.maybeFail("createDnsRecord");
    this.recordMutation("createDnsRecord", input.credential);
    const record = {
      ...input.record,
      id: `dns-${this.dnsRecords.length + 1}`,
      zoneId: input.zoneId,
      ownedByToolSpan: true,
      ownershipKey: input.idempotencyKey,
    };
    this.dnsRecords.push(record);
    return record;
  }

  async updateOwnedDnsRecord(input: CloudflareRequestContext & { zoneId: string; recordId: string; record: Omit<CloudflareDnsRecord, "id" | "zoneId">; expectedFingerprint: string }): Promise<CloudflareDnsRecord> {
    this.maybeFail("updateOwnedDnsRecord");
    this.recordMutation("updateOwnedDnsRecord", input.credential);
    const existing = this.dnsRecords.find((record) => record.id === input.recordId);
    if (existing === undefined) throw new Error("DNS record not found");
    Object.assign(existing, input.record);
    return existing;
  }

  async verifyTunnelHealth(input: CloudflareRequestContext & { accountId: string; tunnelId: string }): Promise<{ healthy: boolean; checkedAt: string }> {
    this.maybeFail("verifyTunnelHealth");
    this.record("verifyTunnelHealth", input.credential);
    return { healthy: this.healthy, checkedAt: new Date(0).toISOString() };
  }

  async deleteOwnedTunnel(input: CloudflareRequestContext & { accountId: string; tunnelId: string; expectedFingerprint: string }): Promise<{ deleted: boolean }> {
    this.maybeFail("deleteOwnedTunnel");
    this.recordMutation("deleteOwnedTunnel", input.credential);
    const index = this.tunnels.findIndex((tunnel) => tunnel.id === input.tunnelId);
    if (index < 0) return { deleted: false };
    this.tunnels.splice(index, 1);
    this.tunnelConfigs.delete(input.tunnelId);
    return { deleted: true };
  }

  async deleteOwnedDnsRecord(input: CloudflareRequestContext & { zoneId: string; recordId: string; expectedFingerprint: string }): Promise<{ deleted: boolean }> {
    this.maybeFail("deleteOwnedDnsRecord");
    this.recordMutation("deleteOwnedDnsRecord", input.credential);
    const index = this.dnsRecords.findIndex((record) => record.id === input.recordId);
    if (index < 0) return { deleted: false };
    this.dnsRecords.splice(index, 1);
    return { deleted: true };
  }

  async restoreOwnedDnsRecord(input: CloudflareRequestContext & { zoneId: string; record: CloudflareDnsRecord; expectedFingerprint: string }): Promise<CloudflareDnsRecord> {
    this.maybeFail("restoreOwnedDnsRecord");
    this.recordMutation("restoreOwnedDnsRecord", input.credential);
    const index = this.dnsRecords.findIndex((record) => record.id === input.record.id);
    if (index >= 0) this.dnsRecords[index] = { ...input.record };
    else this.dnsRecords.push({ ...input.record });
    return input.record;
  }

  private record(name: string, credential: CloudflareCredential): void {
    expectCredentialIsFake(credential);
    this.calls.push(name);
  }

  private recordMutation(name: string, credential: CloudflareCredential): void {
    this.record(name, credential);
    this.mutationCalls.push(name);
  }

  private maybeFail(name: string): void {
    const failure = this.failures.get(name);
    if (failure !== undefined) throw failure;
  }
}

export class FakeCloudflaredAdapter implements CloudflaredAdapter {
  readonly calls: string[] = [];
  status: CloudflaredStatus = { installed: false, serviceInstalled: false };
  failures = new Map<string, Error>();
  healthy = true;
  lastRuntimeCredential?: string;

  async inspect(): Promise<CloudflaredStatus> {
    this.maybeFail("inspect");
    this.calls.push("inspect");
    return this.status;
  }

  async install(input: CloudflaredInstallInput): Promise<CloudflaredInstallResult> {
    this.maybeFail("install");
    this.calls.push("install");
    this.lastRuntimeCredential = input.runtimeCredential;
    this.status = {
      installed: true,
      serviceInstalled: true,
      serviceId: `service-${input.sessionId}`,
      serviceFingerprint: `service-fingerprint-${input.sessionId}`,
      ownedBySession: true,
      ownerSessionId: input.sessionId,
    };
    return {
      ...this.status,
      installed: true,
      serviceInstalled: true,
      serviceId: this.status.serviceId!,
      serviceFingerprint: this.status.serviceFingerprint!,
      ownedBySession: true,
      ownerSessionId: input.sessionId,
    };
  }

  async uninstallOwnedService(): Promise<{ removed: boolean }> {
    this.maybeFail("uninstallOwnedService");
    this.calls.push("uninstallOwnedService");
    this.status = { installed: true, serviceInstalled: false };
    return { removed: true };
  }

  async verify(): Promise<{ healthy: boolean; checkedAt: string }> {
    this.maybeFail("verify");
    this.calls.push("verify");
    return { healthy: this.healthy, checkedAt: new Date(0).toISOString() };
  }

  private maybeFail(name: string): void {
    const failure = this.failures.get(name);
    if (failure !== undefined) throw failure;
  }
}

function expectCredentialIsFake(credential: CloudflareCredential): void {
  if (credential.kind === "api_token" && credential.token.length === 0) {
    throw new Error("Missing fake token");
  }
}
