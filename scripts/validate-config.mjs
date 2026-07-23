import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

import ts from "typescript";

const { config, error } = ts.parseConfigFileTextToJson(
  "wrangler.jsonc",
  readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
);
if (error) throw new Error(error.messageText);

const failures = [];
const checkEnvironment = (name, value, expectedBucket, expectedOrigins, expectedPublicBaseUrl) => {
  const media = value.r2_buckets?.filter((binding) => binding.binding === "MEDIA") ?? [];
  if (media.length !== 1 || media[0].bucket_name !== expectedBucket) {
    failures.push(`${name} must bind MEDIA to ${expectedBucket}`);
  }
  const origins = value.vars?.ALLOWED_ORIGINS?.split(",").sort() ?? [];
  if (origins.join() !== [...expectedOrigins].sort().join()) {
    failures.push(`${name} ALLOWED_ORIGINS must be ${expectedOrigins.join(",")}`);
  }
  if (value.vars?.PUBLIC_BASE_URL !== expectedPublicBaseUrl) {
    failures.push(`${name} PUBLIC_BASE_URL must be ${expectedPublicBaseUrl}`);
  }
  if ((value.kv_namespaces?.length ?? 0) !== 0) {
    failures.push(`${name} must not configure KV namespaces`);
  }
};

if (config.main !== "src/index.ts") failures.push("Worker entrypoint must be src/index.ts");
const productionRoutes = config.routes ?? [];
if (
  productionRoutes.length !== 1 ||
  productionRoutes[0].pattern !== "media-api.byulmaru.co" ||
  productionRoutes[0].custom_domain !== true
) {
  failures.push("production must expose the Worker at media-api.byulmaru.co");
}
checkEnvironment("production", config, "byulmaru-media", [
  "https://kos.moe",
  "https://dev.kos.moe",
  "http://localhost:5173",
  "http://localhost:5174",
], "https://media.byulma.run");

const environment = process.argv[2];
if (environment !== undefined && environment !== "production") {
  failures.push("deployment environment must be production");
}
if (environment) {
  if (failures.length === 0) {
    const args = ["exec", "wrangler", "secret", "list", "--format", "json"];
    const result = spawnSync("pnpm", args, { encoding: "utf8" });
    if (result.status !== 0) {
      failures.push(result.stderr.trim() || "could not list Worker secrets");
    } else {
      const names = new Set(JSON.parse(result.stdout).map((secret) => secret.name));
      for (const name of ["API_KEY", "UPLOAD_SIGNING_SECRET"]) {
        if (!names.has(name)) failures.push(`${environment} secret ${name} is missing`);
      }
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(environment ? `${environment} deployment configuration is valid` : "configuration is valid");
