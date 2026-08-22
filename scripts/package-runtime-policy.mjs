function requireObject(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(code);
  }
  return value;
}

export const SUPPORTED_NODE_ENGINE = "^22.17.0 || ^24.0.0";

export function isSupportedNodeVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(String(value).trim());
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (major === 22 && minor >= 17) || major === 24;
}

export function createPublishShrinkwrap(lockDocument) {
  const lock = requireObject(lockDocument, "PACKAGE_LOCK_INVALID");
  if (lock.lockfileVersion !== 3) throw new Error("PACKAGE_LOCK_VERSION_UNSUPPORTED");
  if (typeof lock.name !== "string" || typeof lock.version !== "string") {
    throw new Error("PACKAGE_LOCK_IDENTITY_MISSING");
  }

  const lockPackages = requireObject(lock.packages, "PACKAGE_LOCK_PACKAGES_MISSING");
  requireObject(lockPackages[""], "PACKAGE_LOCK_ROOT_MISSING");

  for (const [lockPath, entryValue] of Object.entries(lockPackages)) {
    requireObject(entryValue, `PACKAGE_LOCK_ENTRY_INVALID:${lockPath}`);
  }

  return structuredClone(lock);
}
