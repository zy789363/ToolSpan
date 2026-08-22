import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type {
  CloudflaredAdapter,
  CloudflaredInstallInput,
  CloudflaredInstallResult,
  CloudflaredStatus,
} from "./cloudflared-adapter.js";

const execFileAsync = promisify(execFile);

export interface CloudflaredSecureServiceController {
  inspect(): Promise<Omit<CloudflaredStatus, "installed" | "version" | "officialSource">>;
  install(input: CloudflaredInstallInput): Promise<CloudflaredInstallResult>;
  uninstallOwnedService(input: { sessionId: string; serviceId: string; expectedFingerprint: string }): Promise<{ removed: boolean }>;
  verify(input: { serviceId: string }): Promise<{ healthy: boolean; checkedAt: string }>;
}

export interface LocalCloudflaredAdapterOptions {
  executablePath: string;
  serviceController: CloudflaredSecureServiceController;
  allowedInstallRoots?: string[];
}

export function createLocalCloudflaredAdapter(
  options: LocalCloudflaredAdapterOptions,
): CloudflaredAdapter {
  const executablePath = path.resolve(options.executablePath);
  const allowedRoots = options.allowedInstallRoots?.map((root) => path.resolve(root));
  if (path.basename(executablePath).toLowerCase() !== executableName()) {
    throw new Error(`cloudflared executable must be named ${executableName()}`);
  }
  if (allowedRoots !== undefined && !allowedRoots.some((root) => isWithin(root, executablePath))) {
    throw new Error("cloudflared executable is outside the allowed installation roots");
  }

  return {
    async inspect() {
      let version: string | undefined;
      try {
        const result = await execFileAsync(executablePath, ["--version"], {
          windowsHide: true,
          shell: false,
          timeout: 5_000,
          maxBuffer: 16 * 1024,
        });
        version = parseVersion(result.stdout);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { installed: false, serviceInstalled: false };
        }
        throw new Error("Unable to inspect the fixed cloudflared executable", { cause: error });
      }
      const service = await options.serviceController.inspect();
      return {
        installed: true,
        ...(version === undefined ? {} : { version }),
        officialSource: true,
        ...service,
      };
    },

    install(input) {
      // The sensitive runtime credential crosses only this in-memory controller boundary.
      // It is deliberately never passed to execFile or serialized by this adapter.
      return options.serviceController.install(input);
    },

    uninstallOwnedService(input) {
      return options.serviceController.uninstallOwnedService(input);
    },

    verify(input) {
      return options.serviceController.verify(input);
    },
  };
}

function executableName(): string {
  return process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function parseVersion(stdout: string): string | undefined {
  const match = /cloudflared version\s+([^\s]+)/iu.exec(stdout);
  return match?.[1];
}
