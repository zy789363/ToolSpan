export type CloudflareCredential = { kind: "api_token"; token: string };

export interface CloudflareRequestContext {
  credential: CloudflareCredential;
  page?: number;
  perPage?: number;
  signal?: AbortSignal;
}

export interface CloudflarePage<T> {
  items: T[];
  page: number;
  totalPages: number;
}

export interface CloudflareAccount {
  id: string;
  name: string;
}

export interface CloudflareZone {
  id: string;
  accountId: string;
  name: string;
  status: "active" | "pending" | "initializing" | "moved" | "deactivated" | string;
  nameservers: string[];
}

export interface CloudflareTunnel {
  id: string;
  accountId: string;
  name: string;
  status: "healthy" | "degraded" | "down" | "inactive" | string;
  ownedByToolSpan?: boolean;
  ownershipKey?: string;
}

export interface CloudflareIngressRule {
  hostname?: string;
  service: string;
}

export interface CloudflareTunnelConfig {
  ingress: CloudflareIngressRule[];
}

export interface CloudflareDnsRecord {
  id: string;
  zoneId: string;
  type: "CNAME";
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
  ownedByToolSpan?: boolean;
  ownershipKey?: string;
}

export interface CloudflareAdapter {
  verifyCredential(input: { credential: CloudflareCredential; signal?: AbortSignal }): Promise<{ valid: true }>;
  listAccounts(input: CloudflareRequestContext): Promise<CloudflarePage<CloudflareAccount>>;
  listZones(input: CloudflareRequestContext & { accountId?: string; name?: string }): Promise<CloudflarePage<CloudflareZone>>;
  listTunnels(input: CloudflareRequestContext & { accountId: string; name?: string }): Promise<CloudflarePage<CloudflareTunnel>>;
  createTunnel(input: CloudflareRequestContext & { accountId: string; name: string; idempotencyKey: string }): Promise<CloudflareTunnel>;
  readTunnelConfig(input: CloudflareRequestContext & { accountId: string; tunnelId: string }): Promise<CloudflareTunnelConfig | undefined>;
  updateTunnelConfig(input: CloudflareRequestContext & { accountId: string; tunnelId: string; config: CloudflareTunnelConfig; expectedFingerprint?: string }): Promise<CloudflareTunnelConfig>;
  getTunnelRuntimeCredential(input: CloudflareRequestContext & { accountId: string; tunnelId: string }): Promise<{ token: string }>;
  listDnsRecords(input: CloudflareRequestContext & { zoneId: string; name?: string }): Promise<CloudflarePage<CloudflareDnsRecord>>;
  createDnsRecord(input: CloudflareRequestContext & { zoneId: string; record: Omit<CloudflareDnsRecord, "id" | "zoneId">; idempotencyKey: string }): Promise<CloudflareDnsRecord>;
  updateOwnedDnsRecord(input: CloudflareRequestContext & { zoneId: string; recordId: string; record: Omit<CloudflareDnsRecord, "id" | "zoneId">; expectedFingerprint: string }): Promise<CloudflareDnsRecord>;
  verifyTunnelHealth(input: CloudflareRequestContext & { accountId: string; tunnelId: string }): Promise<{ healthy: boolean; checkedAt: string }>;
  deleteOwnedTunnel?(input: CloudflareRequestContext & { accountId: string; tunnelId: string; expectedFingerprint: string }): Promise<{ deleted: boolean }>;
  deleteOwnedDnsRecord?(input: CloudflareRequestContext & { zoneId: string; recordId: string; expectedFingerprint: string }): Promise<{ deleted: boolean }>;
  restoreOwnedDnsRecord?(input: CloudflareRequestContext & { zoneId: string; record: CloudflareDnsRecord; expectedFingerprint: string }): Promise<CloudflareDnsRecord>;
}

export function validateCredential(credential: CloudflareCredential): void {
  if (credential.token.trim().length === 0) throw new Error("Cloudflare API token is required");
}
