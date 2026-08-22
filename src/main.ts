import { once } from "node:events";

import { loadConfig, resolveConfigPath } from "./config.js";
import { createRuntime } from "./runtime.js";
import { SERVICE_INFO } from "./service-info.js";

async function main(): Promise<void> {
  const config = await loadConfig(resolveConfigPath({ argv: process.argv.slice(2) }));
  const runtime = await createRuntime(config);
  const server = runtime.app.listen(config.port, config.host);
  try {
    await once(server, "listening");
  } catch (error) {
    await runtime.close();
    throw error;
  }
  process.stdout.write(
    `${SERVICE_INFO.package} listening on http://${config.host}:${String(config.port)} (resource ${config.publicBaseUrl}/mcp)\n`,
  );

  let shuttingDown = false;
  const shutdown = (exitCode = 0): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(() => {
      void runtime.close().then(
        () => process.exit(exitCode),
        () => process.exit(1),
      );
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  server.on("error", (error) => {
    process.stderr.write(`HTTP server error: ${error.message}\n`);
    shutdown(1);
  });
  process.once("SIGINT", () => shutdown());
  process.once("SIGTERM", () => shutdown());
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Startup failed"}\n`);
  process.exitCode = 1;
});
