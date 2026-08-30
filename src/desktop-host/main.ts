import { resolveConfigPath } from "../config.js";
import { runDesktopHost } from "./host.js";
import { createDesktopProductionService } from "./production-service.js";

async function main(): Promise<void> {
  const service = createDesktopProductionService({
    configPath: resolveConfigPath({ argv: process.argv.slice(2) }),
    logPath: process.env.TOOLSPAN_LOG_PATH,
  });
  try {
    await runDesktopHost({
      input: process.stdin,
      output: process.stdout,
      errorOutput: process.stderr,
      service,
    });
  } finally {
    await service.close();
  }
}

main().catch(() => {
  process.stderr.write("Desktop host failed\n");
  process.exitCode = 1;
});
