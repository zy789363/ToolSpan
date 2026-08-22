import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(projectRoot, "dist");
if (path.basename(outputDirectory) !== "dist" || path.dirname(outputDirectory) !== projectRoot) {
  throw new Error("Refusing to clean an unexpected output directory");
}
rmSync(outputDirectory, { recursive: true, force: true });
