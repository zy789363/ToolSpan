import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPublishShrinkwrap } from "./package-runtime-policy.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const packageLockPath = path.join(projectRoot, "package-lock.json");
const shrinkwrapPath = path.join(projectRoot, "npm-shrinkwrap.json");

const lockDocument = JSON.parse(await readFile(packageLockPath, "utf8"));
const shrinkwrapDocument = createPublishShrinkwrap(lockDocument);
await writeFile(shrinkwrapPath, `${JSON.stringify(shrinkwrapDocument, null, 2)}\n`, "utf8");

process.stdout.write(`Generated npm-shrinkwrap.json with ${Object.keys(shrinkwrapDocument.packages).length} locked package paths.\n`);
