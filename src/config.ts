import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { hostname as systemHostname } from "node:os";
import path from "node:path";

import { z } from "zod";

const rawConfigSchema = z.object({
  instanceName: z.string().min(1).max(64).regex(
    /^[A-Za-z0-9 ._-]+$/u,
    "instanceName may contain only letters, numbers, spaces, hyphens, underscores, and dots",
  ).optional(),
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(8787),
  publicBaseUrl: z.string().url(),
  allowedRoots: z.array(z.string().min(1)).min(1),
  stateDirectory: z.string().min(1),
  ownerPasswordHashFile: z.string().min(1),
  allowedOrigins: z.array(z.string().url()).optional(),
}).strict();

export interface ToolSpanConfig {
  instanceName?: string;
  host: "127.0.0.1" | "localhost" | "::1";
  port: number;
  publicBaseUrl: string;
  allowedRoots: string[];
  stateDirectory: string;
  ownerPasswordHash: string;
  previewSecret: Buffer;
  allowedOrigins: string[];
  allowedHosts: string[];
}

export interface ConfigPathResolverOptions {
  argv?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  warn?: (warning: ConfigResolutionWarning) => void;
}

export interface ConfigResolutionWarning {
  code: typeof LEGACY_CONFIG_WARNING_CODE;
  message: string;
}

export const LEGACY_CONFIG_WARNING_CODE = "TOOLSPAN_LEGACY_CONFIG";

let legacyConfigWarningEmitted = false;

function warnLegacyConfig(warn: ConfigPathResolverOptions["warn"]): void {
  if (legacyConfigWarningEmitted) return;
  legacyConfigWarningEmitted = true;
  const warning: ConfigResolutionWarning = {
    code: LEGACY_CONFIG_WARNING_CODE,
    message: "Using legacy WebGPT configuration compatibility; migrate to ToolSpan configuration.",
  };
  if (warn !== undefined) {
    warn(warning);
    return;
  }
  process.emitWarning(warning.message, { code: warning.code });
}

export function resolveConfigPath(options: ConfigPathResolverOptions = {}): string {
  const argv = options.argv ?? [];
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const configIndex = argv.indexOf("--config");
  if (configIndex >= 0) {
    const configPath = argv[configIndex + 1];
    if (configPath === undefined || configPath.length === 0) {
      throw new Error("--config requires a file path");
    }
    return path.resolve(cwd, configPath);
  }
  if (env.TOOLSPAN_CONFIG !== undefined && env.TOOLSPAN_CONFIG.length > 0) {
    return path.resolve(cwd, env.TOOLSPAN_CONFIG);
  }
  if (env.WEBGPT_CONFIG !== undefined && env.WEBGPT_CONFIG.length > 0) {
    warnLegacyConfig(options.warn);
    return path.resolve(cwd, env.WEBGPT_CONFIG);
  }
  const preferredPath = path.resolve(cwd, "toolspan.config.json");
  if (existsSync(preferredPath)) return preferredPath;
  const legacyPath = path.resolve(cwd, "webgpt.config.json");
  if (existsSync(legacyPath)) {
    warnLegacyConfig(options.warn);
    return legacyPath;
  }
  return preferredPath;
}

export function suggestInstanceName(hostname = systemHostname()): string {
  const suggestion = hostname
    .replace(/[^A-Za-z0-9 ._-]+/gu, "-")
    .replace(/^[ ._-]+|[ ._-]+$/gu, "")
    .slice(0, 64);
  return suggestion.length === 0 ? "toolspan-instance" : suggestion;
}

function resolveFrom(baseDirectory: string, value: string): string {
  return path.resolve(baseDirectory, value);
}

function comparisonPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(comparisonPath(root), comparisonPath(candidate));
  return relative === "" || (
    relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  );
}

async function loadOrCreatePreviewSecret(stateDirectory: string): Promise<Buffer> {
  const secretPath = path.join(stateDirectory, "preview-secret.bin");
  try {
    const existing = await readFile(secretPath);
    if (existing.length !== 32) throw new Error("Preview secret must contain exactly 32 bytes");
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const secret = randomBytes(32);
  try {
    await writeFile(secretPath, secret, { flag: "wx", mode: 0o600 });
    return secret;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(secretPath);
    if (existing.length !== 32) throw new Error("Preview secret must contain exactly 32 bytes");
    return existing;
  }
}

export async function loadConfig(configPath: string): Promise<ToolSpanConfig> {
  const absoluteConfigPath = path.resolve(configPath);
  const baseDirectory = path.dirname(absoluteConfigPath);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(await readFile(absoluteConfigPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read config: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
  const parsed = rawConfigSchema.parse(parsedJson);
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.host)) {
    throw new Error("host must be a loopback address");
  }
  const publicUrl = new URL(parsed.publicBaseUrl);
  const isLocalhost = ["127.0.0.1", "[::1]", "localhost"].includes(publicUrl.hostname);
  if (publicUrl.protocol !== "https:" && !isLocalhost) {
    throw new Error("publicBaseUrl must use HTTPS unless it is localhost");
  }
  if (publicUrl.pathname !== "/" || publicUrl.search !== "" || publicUrl.hash !== "") {
    throw new Error("publicBaseUrl must be an origin without a path, query, or fragment");
  }
  if (publicUrl.username !== "" || publicUrl.password !== "") {
    throw new Error("publicBaseUrl must not contain credentials");
  }

  const allowedRoots = await Promise.all(
    parsed.allowedRoots.map((root) => realpath(resolveFrom(baseDirectory, root))),
  );
  const requestedStateDirectory = resolveFrom(baseDirectory, parsed.stateDirectory);
  if (allowedRoots.some((root) => isWithin(requestedStateDirectory, root))) {
    throw new Error("stateDirectory must be outside every allowed root");
  }
  await mkdir(requestedStateDirectory, { recursive: true });
  const stateDirectory = await realpath(requestedStateDirectory);
  if (allowedRoots.some((root) => isWithin(stateDirectory, root))) {
    throw new Error("stateDirectory must be outside every allowed root");
  }
  const ownerPasswordHashPath = await realpath(
    resolveFrom(baseDirectory, parsed.ownerPasswordHashFile),
  );
  if (allowedRoots.some((root) => isWithin(ownerPasswordHashPath, root))) {
    throw new Error("ownerPasswordHashFile must be outside every allowed root");
  }
  const ownerPasswordHash = (await readFile(ownerPasswordHashPath, "utf8")).trim();
  if (!/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/u.test(ownerPasswordHash)) {
    throw new Error("ownerPasswordHashFile does not contain a bcrypt hash");
  }
  const previewSecret = await loadOrCreatePreviewSecret(stateDirectory);
  const publicBaseUrl = publicUrl.origin;
  const configuredOrigins = parsed.allowedOrigins?.map((origin) => new URL(origin));
  if (configuredOrigins?.some((origin) => !["http:", "https:"].includes(origin.protocol))) {
    throw new Error("allowedOrigins entries must use HTTP or HTTPS");
  }
  const allowedOrigins = configuredOrigins?.map((origin) => origin.origin) ?? [
    "http://127.0.0.1",
    "http://localhost",
  ];

  return {
    instanceName: parsed.instanceName,
    host: parsed.host as ToolSpanConfig["host"],
    port: parsed.port,
    publicBaseUrl,
    allowedRoots,
    stateDirectory,
    ownerPasswordHash,
    previewSecret,
    allowedOrigins,
    allowedHosts: [...new Set(["127.0.0.1", "localhost", "[::1]", publicUrl.hostname])],
  };
}
