import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

function resolveBuildVersion(): string {
  const explicitVersion = process.env.MALINK_BUILD_VERSION?.trim();
  if (explicitVersion) return explicitVersion;

  try {
    const commit = execFileSync(
      "git",
      ["rev-parse", "--short=8", "HEAD"],
      { cwd: repositoryRoot, encoding: "utf8" },
    ).trim();
    const dirty = execFileSync(
      "git",
      ["status", "--porcelain", "--untracked-files=no"],
      { cwd: repositoryRoot, encoding: "utf8" },
    ).trim();
    return dirty ? `${commit}+dirty` : commit;
  } catch {
    return "development";
  }
}

function resolveGatewayRelease(): { releaseId: string; buildId: string } | null {
  const releaseId = process.env.MALINK_GATEWAY_RELEASE_ID?.trim();
  const buildId = process.env.MALINK_GATEWAY_BUILD_ID?.trim();
  if (!releaseId && !buildId) return null;
  if (!releaseId || !buildId) {
    throw new Error(
      "MALINK_GATEWAY_RELEASE_ID and MALINK_GATEWAY_BUILD_ID must be set together.",
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(releaseId)) {
    throw new Error("MALINK_GATEWAY_RELEASE_ID is invalid.");
  }
  if (buildId.length > 256) {
    throw new Error("MALINK_GATEWAY_BUILD_ID is too long.");
  }
  return { releaseId, buildId };
}

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  // Vinext uses AsyncLocalStorage in the SSR environment. Keep the local
  // workerd runtime aligned with the hosted Worker instead of silently
  // running the E2E under a Node-only substitute.
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    define: {
      __MALINK_BUILD_VERSION__: JSON.stringify(resolveBuildVersion()),
      __MALINK_GATEWAY_RELEASE__: JSON.stringify(resolveGatewayRelease()),
    },
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
