import { mkdir, writeFile } from "node:fs/promises";

await mkdir(new URL("./output/", import.meta.url), { recursive: true });
await writeFile(
  new URL("./output/job-result.txt", import.meta.url),
  "toolspan-release-e2e-job: completed\n",
  "utf8",
);
process.stdout.write("ToolSpan release fixture job completed\n");
