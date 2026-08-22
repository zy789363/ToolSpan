import path from "node:path";
import { pathToFileURL } from "node:url";

import { publicHostError, runPackedProtocolE2e } from "./e2e-mcp-inspector.mjs";

async function main() {
  if (process.argv.length !== 2) throw new Error("This command accepts no command-line arguments");
  const summary = await runPackedProtocolE2e({
    command: "npm run e2e:host:local",
    evidenceFileName: "release-host-local.json",
  });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${publicHostError(error)}\n`);
    process.exitCode = 1;
  });
}
