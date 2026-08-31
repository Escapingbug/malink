import { execFileSync } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { gatewayReleaseFromBuildEnvironment } from "./build/gatewayReleaseEnvironment";

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
  return gatewayReleaseFromBuildEnvironment(process.env);
}

function resolveBasePath(): string {
  // GitHub Pages is the production Official PWA. Root-host deployments such
  // as rd.anciety.my.id must opt into `/` explicitly.
  const input = process.env.MALINK_PWA_BASE_PATH?.trim() || "/malink/";
  if (!input.startsWith("/") || input.includes("?") || input.includes("#")) {
    throw new Error("MALINK_PWA_BASE_PATH must be an absolute URL path.");
  }
  return `${input.replace(/\/+$/u, "")}/`.replace(/^\/\//u, "/");
}

function staticReleaseFiles(
  buildVersion: string,
  gatewayRelease: { releaseId: string; buildId: string } | null,
): Plugin {
  let outputDirectory = "dist";
  return {
    name: "malink-static-release-files",
    apply: "build",
    configResolved(config) {
      outputDirectory = resolve(config.root, config.build.outDir);
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: `${JSON.stringify({
          buildVersion,
          ...(gatewayRelease ? { gatewayRelease } : {}),
        })}\n`,
      });
    },
    async closeBundle() {
      await mkdir(outputDirectory, { recursive: true });
      // GitHub Pages and simple object stores can serve this fallback for
      // direct navigations without running an application server.
      await copyFile(
        resolve(outputDirectory, "index.html"),
        resolve(outputDirectory, "404.html"),
      );
    },
  };
}

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";
export default defineConfig(({ command }) => {
  const buildVersion = resolveBuildVersion();
  const gatewayRelease = command === "build" ? resolveGatewayRelease() : null;
  const base = resolveBasePath();
  return {
    base,
    define: {
      __MALINK_BUILD_VERSION__: JSON.stringify(buildVersion),
      __MALINK_GATEWAY_RELEASE__: JSON.stringify(gatewayRelease),
      __MALINK_BASE_PATH__: JSON.stringify(base),
    },
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [react(), staticReleaseFiles(buildVersion, gatewayRelease)],
    build: {
      outDir: "dist",
      emptyOutDir: true,
      sourcemap: false,
    },
  };
});
