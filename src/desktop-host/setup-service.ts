import type { CloudflareCredential } from "../setup/cloudflare-adapter.js";
import { createCloudflareFetchAdapter } from "../setup/cloudflare-fetch-adapter.js";
import { createManualCloudflaredAdapter } from "../setup/cloudflared-adapter.js";
import { createSetupService, type SetupService } from "../setup/setup-service.js";
import type { SetupManifest } from "../setup/types.js";
import type { DesktopServiceMethod } from "./host.js";

export type DesktopSetupMethod = Extract<DesktopServiceMethod, `setup.${string}`>;

export interface DesktopSetupService {
  invoke(method: DesktopSetupMethod, params: unknown): Promise<unknown>;
}

const FORBIDDEN_RESPONSE_KEYS = new Set([
  "credential",
  "token",
  "apikey",
  "api_key",
  "key",
  "email",
  "acknowledgement",
  "authorization",
  "password",
  "secret",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsForbiddenResponseKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenResponseKey);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) =>
    FORBIDDEN_RESPONSE_KEYS.has(key.toLowerCase()) || containsForbiddenResponseKey(child)
  );
}

function credentialValues(credential: CloudflareCredential | undefined): string[] {
  if (credential === undefined) return [];
  return [credential.token];
}

function assertSecretFreeResult(
  result: unknown,
  credential: CloudflareCredential | undefined,
): void {
  if (containsForbiddenResponseKey(result)) {
    throw new Error("Setup service produced a response outside the secret-free contract");
  }
  const encoded = JSON.stringify(result);
  if (credentialValues(credential).some((secret) => secret !== "" && encoded.includes(secret))) {
    throw new Error("Setup service produced a response outside the secret-free contract");
  }
}

function requireCredential(
  input: Record<string, unknown>,
): CloudflareCredential | undefined {
  const credential = input.credential as CloudflareCredential | undefined;
  delete input.credential;
  return credential;
}

export function createDesktopSetupService(service: SetupService): DesktopSetupService {
  return {
    async invoke(method, params): Promise<unknown> {
      const input = params as Record<string, unknown>;
      let credential: CloudflareCredential | undefined;
      let result: unknown;
      switch (method) {
        case "setup.getSnapshot":
          result = await service.snapshot({ sessionId: input.sessionId as string | undefined });
          result ??= null;
          break;
        case "setup.preflight":
          credential = requireCredential(input);
          if (credential === undefined) {
            throw new Error("Setup preflight requires an in-memory credential");
          }
          result = await service.preflight({
            sessionId: input.sessionId as string,
            idempotencyKey: input.idempotencyKey as string,
            zoneName: input.zoneName as string,
            manifest: input.manifest as SetupManifest,
            credential,
          });
          break;
        case "setup.plan":
          result = await service.plan({ sessionId: input.sessionId as string });
          break;
        case "setup.apply":
        case "setup.rollback":
        case "setup.reconcile": {
          credential = requireCredential(input);
          if (method === "setup.apply") {
            result = await service.apply({
              sessionId: input.sessionId as string,
              confirmation: "APPLY",
              ...(credential === undefined ? {} : { credential }),
            });
          } else if (method === "setup.rollback") {
            result = await service.rollback({
              sessionId: input.sessionId as string,
              confirmation: "ROLLBACK",
              ...(credential === undefined ? {} : { credential }),
            });
          } else {
            result = await service.reconcile({
              sessionId: input.sessionId as string,
              ...(credential === undefined ? {} : { credential }),
            });
          }
          break;
        }
        case "setup.discardCredential":
          await service.discard({ sessionId: input.sessionId as string });
          result = { discarded: true, sessionId: input.sessionId };
          break;
      }
      assertSecretFreeResult(result, credential);
      return result;
    },
  };
}

export function createProductionDesktopSetupService(directory: string): DesktopSetupService {
  return createDesktopSetupService(createSetupService({
    directory,
    cloudflare: createCloudflareFetchAdapter(),
    cloudflared: createManualCloudflaredAdapter(),
  }));
}
