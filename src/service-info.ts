import { createRequire } from "node:module";

interface PackageMetadata {
  name: string;
  version: string;
}

const packageMetadata = createRequire(import.meta.url)("../package.json") as PackageMetadata;

export const SERVICE_INFO = Object.freeze({
  product: "ToolSpan",
  service: "toolspan",
  package: packageMetadata.name,
  version: packageMetadata.version,
});
