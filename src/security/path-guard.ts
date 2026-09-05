import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

export interface PathGuard {
  openWorkspace(candidatePath: string): Promise<string>;
  resolveExisting(workspaceRoot: string, relativePath: string): Promise<string>;
  resolveEntry(workspaceRoot: string, relativePath: string): Promise<string>;
  resolveForWrite(workspaceRoot: string, relativePath: string): Promise<string>;
  resolveForCreate(workspaceRoot: string, relativePath: string): Promise<string>;
}

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

function comparisonPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

function isWithin(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(comparisonPath(rootPath), comparisonPath(candidatePath));
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function validateRelativePath(relativePath: string): void {
  if (relativePath.length === 0 || relativePath.includes("\0")) {
    throw new Error("Path must be a non-empty relative path");
  }
  if (
    path.isAbsolute(relativePath)
    || path.win32.isAbsolute(relativePath)
    || path.posix.isAbsolute(relativePath)
    || /^[A-Za-z]:/u.test(relativePath)
    || /^(?:\\\\|\/\/)/u.test(relativePath)
  ) {
    throw new Error("Path escapes workspace");
  }

  const segments = relativePath.split(/[\\/]+/u);
  for (const segment of segments) {
    if (segment === "..") throw new Error("Path escapes workspace");
    if (segment === "" || segment === ".") continue;
    if (segment.includes(":") || segment.endsWith(".") || segment.endsWith(" ")) {
      throw new Error("Path contains a Windows-unsafe segment");
    }
    if (WINDOWS_RESERVED_NAME.test(segment)) {
      throw new Error("Path contains a reserved Windows device name");
    }
  }
}

function requestedPath(workspaceRoot: string, relativePath: string): string {
  validateRelativePath(relativePath);
  const requested = path.resolve(workspaceRoot, relativePath);
  if (!isWithin(requested, workspaceRoot)) throw new Error("Path escapes workspace");
  return requested;
}

async function assertSafeWriteTarget(targetPath: string, workspaceRoot: string): Promise<void> {
  try {
    const targetStats = await lstat(targetPath);
    if (targetStats.isSymbolicLink()) throw new Error("Path is a symbolic link");
    const canonicalTarget = await realpath(targetPath);
    if (comparisonPath(canonicalTarget) !== comparisonPath(targetPath)
      || !isWithin(canonicalTarget, workspaceRoot)) {
      throw new Error("Path is a reparse point");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function createPathGuard(allowedRoots: readonly string[]): Promise<PathGuard> {
  if (allowedRoots.length === 0) {
    throw new Error("At least one allowed root is required");
  }

  const canonicalRoots = await Promise.all(
    allowedRoots.map(async (root) => {
      const canonicalRoot = await realpath(root);
      if (!(await stat(canonicalRoot)).isDirectory()) {
        throw new Error(`Allowed root is not a directory: ${root}`);
      }
      return canonicalRoot;
    }),
  );

  return {
    async openWorkspace(candidatePath: string): Promise<string> {
      const canonicalCandidate = await realpath(candidatePath);
      if (!(await stat(canonicalCandidate)).isDirectory()) {
        throw new Error("Workspace is not a directory");
      }
      if (!canonicalRoots.some((root) => isWithin(canonicalCandidate, root))) {
        throw new Error("Workspace is outside allowed roots");
      }
      return canonicalCandidate;
    },

    async resolveExisting(workspaceRoot: string, relativePath: string): Promise<string> {
      const canonicalTarget = await realpath(requestedPath(workspaceRoot, relativePath));
      if (!isWithin(canonicalTarget, workspaceRoot)) {
        throw new Error("Path escapes workspace");
      }
      return canonicalTarget;
    },

    async resolveEntry(workspaceRoot: string, relativePath: string): Promise<string> {
      const requestedTarget = requestedPath(workspaceRoot, relativePath);
      if (comparisonPath(requestedTarget) === comparisonPath(workspaceRoot)) {
        await lstat(workspaceRoot);
        return workspaceRoot;
      }
      const canonicalParent = await realpath(path.dirname(requestedTarget));
      if (!isWithin(canonicalParent, workspaceRoot)) {
        throw new Error("Path escapes workspace");
      }
      const entryPath = path.join(canonicalParent, path.basename(requestedTarget));
      await lstat(entryPath);
      return entryPath;
    },

    async resolveForWrite(workspaceRoot: string, relativePath: string): Promise<string> {
      const requestedTarget = requestedPath(workspaceRoot, relativePath);
      const canonicalParent = await realpath(path.dirname(requestedTarget));
      if (!isWithin(canonicalParent, workspaceRoot)) {
        throw new Error("Path escapes workspace");
      }
      const targetPath = path.join(canonicalParent, path.basename(requestedTarget));
      await assertSafeWriteTarget(targetPath, workspaceRoot);
      return targetPath;
    },

    async resolveForCreate(workspaceRoot: string, relativePath: string): Promise<string> {
      const requestedTarget = requestedPath(workspaceRoot, relativePath);
      if (comparisonPath(requestedTarget) === comparisonPath(workspaceRoot)) {
        return workspaceRoot;
      }

      const missingSegments: string[] = [path.basename(requestedTarget)];
      let ancestor = path.dirname(requestedTarget);
      while (true) {
        try {
          const canonicalAncestor = await realpath(ancestor);
          if (!isWithin(canonicalAncestor, workspaceRoot)) {
            throw new Error("Path escapes workspace");
          }
          const targetPath = path.join(canonicalAncestor, ...missingSegments.reverse());
          await assertSafeWriteTarget(targetPath, workspaceRoot);
          return targetPath;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          const parent = path.dirname(ancestor);
          if (parent === ancestor) throw new Error("Path escapes workspace");
          missingSegments.push(path.basename(ancestor));
          ancestor = parent;
        }
      }
    },
  };
}
