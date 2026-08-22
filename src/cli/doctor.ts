import { loadConfig, resolveConfigPath } from "../config.js";
import { createProductionRunners, inspectRunnerAvailability } from "../jobs/runner-registry.js";
import { createRuntime } from "../runtime.js";
import { SERVICE_INFO } from "../service-info.js";

async function main(): Promise<void> {
  const config = await loadConfig(resolveConfigPath({ argv: process.argv.slice(2) }));
  const runtime = await createRuntime(config);
  try {
    const runners = await inspectRunnerAvailability(createProductionRunners());
    process.stdout.write(`${JSON.stringify({
      status: "ok",
      service: SERVICE_INFO.service,
      version: SERVICE_INFO.version,
      node: process.version,
      listener: `http://${config.host}:${String(config.port)}`,
      resource: `${config.publicBaseUrl}/mcp`,
      allowedRootCount: config.allowedRoots.length,
      stateDirectory: config.stateDirectory,
      runners,
    }, null, 2)}\n`);
  } finally {
    await runtime.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Diagnostics failed"}\n`);
  process.exitCode = 1;
});
