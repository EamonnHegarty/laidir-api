// Bundles each Lambda into dist/<name>/index.mjs (handler: index.handler, runtime nodejs24.x, arm64).
// CI zips each directory and ships it with `aws lambda update-function-code`.
import { execSync } from "node:child_process";
import { rmSync, statSync } from "node:fs";
import { build } from "esbuild";

// Size guard rails per bundle (unminified). mcp carries the MCP SDK and zod (~1.5 MB).
const FUNCTIONS = { api: 1_000_000, mcp: 2_000_000, signup: 200_000 };

function gitSha() {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const version = process.env.LAIDIR_VERSION ?? gitSha();
rmSync("dist", { recursive: true, force: true });

for (const [name, maxBytes] of Object.entries(FUNCTIONS)) {
  const outfile = `dist/${name}/index.mjs`;
  await build({
    entryPoints: [`src/${name}/index.ts`],
    outfile,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    // Readable stack traces in CloudWatch without needing source maps.
    minify: false,
    sourcemap: false,
    legalComments: "none",
    // The nodejs24.x runtime ships AWS SDK v3; bundling it would blow the size guard.
    external: ["@aws-sdk/*"],
    define: { LAIDIR_VERSION: JSON.stringify(version) },
    logLevel: "warning",
  });
  const bytes = statSync(outfile).size;
  console.log(`${outfile}  ${(bytes / 1024).toFixed(1)} KiB`);
  if (bytes > maxBytes) {
    console.error(`${outfile} is over ${maxBytes} bytes; check for an accidental dependency.`);
    process.exit(1);
  }
}
console.log(`version ${version}`);
