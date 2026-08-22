import { builtinModules } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

import { projectRoot } from "./desktop-verification-utils.mjs";

export const DESKTOP_HOST_BUNDLE = path.join(projectRoot, ".toolspan-dev", "desktop-bundle", "main.js");

const nodeBuiltins = new Set(builtinModules.map((name) => name.replace(/^node:/u, "")));

export async function bundleDesktopHost(options = {}) {
  const entryPoint = options.entryPoint ?? path.join(projectRoot, "dist", "desktop-host", "main.js");
  const outfile = options.outfile ?? DESKTOP_HOST_BUNDLE;
  await mkdir(path.dirname(outfile), { recursive: true });
  const result = await build({
    banner: {
      js: "import { createRequire as __toolspanCreateRequire } from 'node:module'; const require = __toolspanCreateRequire(import.meta.url);",
    },
    bundle: true,
    entryPoints: [entryPoint],
    external: ["node:*"],
    format: "esm",
    legalComments: "none",
    logLevel: "silent",
    metafile: true,
    outfile,
    packages: "bundle",
    platform: "node",
    plugins: [{
      name: "normalize-node-builtins",
      setup(buildContext) {
        buildContext.onResolve({ filter: /.*/ }, (args) => {
          if (args.path === "supports-color") {
            return { namespace: "optional-dependency", path: args.path };
          }
          if (args.path.startsWith("node:")) return { external: true, path: args.path };
          if (nodeBuiltins.has(args.path)) return { external: true, path: `node:${args.path}` };
          return undefined;
        });
        buildContext.onLoad({ filter: /^supports-color$/, namespace: "optional-dependency" }, () => ({
          contents: "module.exports = null;",
          loader: "js",
        }));
      },
    }],
    sourcemap: false,
    target: "node22",
  });
  const externalImports = Object.values(result.metafile.outputs)
    .flatMap((output) => output.imports)
    .filter((item) => item.external)
    .map((item) => item.path);
  const nonNodeExternalImports = externalImports.filter((specifier) => !specifier.startsWith("node:"));
  if (nonNodeExternalImports.length > 0) {
    throw new Error(`Desktop host bundle contains non-Node external imports: ${[...new Set(nonNodeExternalImports)].sort().join(", ")}`);
  }
  return { outfile, externalImports: [...new Set(externalImports)].sort() };
}

async function main() {
  await bundleDesktopHost();
  process.stdout.write("Desktop host standalone bundle: PASS\n");
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
