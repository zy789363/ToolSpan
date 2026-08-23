const FORBIDDEN_PERSISTED_KEYS = new Set([
  "authorization",
  "credential",
  "credentials",
  "token",
  "apiToken",
  "apiKey",
  "key",
  "password",
  "ownerHash",
  "runtimeCredential",
]);

const SENSITIVE_TEXT_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[^\s,;]+/giu,
  /\bX-Auth-Key\s*[:=]\s*[^\s,;]+/giu,
  /\bX-Auth-Email\s*[:=]\s*[^\s,;]+/giu,
  /\bAuthorization\s*[:=]\s*[^\r\n]+/giu,
];

export function redactText(value: string, secrets: readonly string[] = []): string {
  let redacted = value;
  for (const pattern of SENSITIVE_TEXT_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  for (const secret of secrets) {
    if (secret.length > 0) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

export function assertPersistable(value: unknown, secrets: readonly string[] = []): void {
  const visit = (candidate: unknown, path: string): void => {
    if (typeof candidate === "string") {
      for (const secret of secrets) {
        if (secret.length > 0 && candidate.includes(secret)) {
          throw new Error(`Refusing to persist credential material at ${path}`);
        }
      }
      if (SENSITIVE_TEXT_PATTERNS.some((pattern) => {
        pattern.lastIndex = 0;
        return pattern.test(candidate);
      })) {
        throw new Error(`Refusing to persist secret-like text at ${path}`);
      }
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (candidate !== null && typeof candidate === "object") {
      for (const [key, entry] of Object.entries(candidate)) {
        if (FORBIDDEN_PERSISTED_KEYS.has(key)) {
          throw new Error(`Refusing to persist secret-like field ${path}.${key}`);
        }
        visit(entry, `${path}.${key}`);
      }
    }
  };
  visit(value, "$setup");
}

export function credentialSecrets(credential: import("./cloudflare-adapter.js").CloudflareCredential): string[] {
  return [credential.token];
}
