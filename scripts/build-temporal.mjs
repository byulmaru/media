import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { build } from "esbuild";
import { bundleWorkflowCode } from "@temporalio/worker";

const common = {
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node24",
};

await build({ ...common, entryPoints: ["src/temporal/worker.ts"], outfile: "dist/worker.js" });
await build({
  ...common,
  entryPoints: ["src/temporal/hope-worker.ts"],
  outfile: "dist/hope-worker.js",
});

const workflowBundle = await bundleWorkflowCode({
  workflowsPath: resolve("src/temporal/workflow.ts"),
});
await writeFile("dist/workflows.js", workflowBundle.code);
