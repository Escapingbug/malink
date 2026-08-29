import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const output = resolve("dist");
const configured = process.env.MALINK_PWA_BASE_PATH?.trim() || "/malink/";
const base = `${configured.replace(/\/+$/u, "")}/`.replace(/^\/\//u, "/");
const index = readFileSync(resolve(output, "index.html"), "utf8");
const fallback = readFileSync(resolve(output, "404.html"), "utf8");

if (index !== fallback) {
  throw new Error("The static 404 fallback must match the built index.html.");
}

const entrypoints = [
  ...index.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gu),
  ...index.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/gu),
].map((match) => match[1]!);

if (entrypoints.length < 2) {
  throw new Error("The static build is missing its JavaScript or stylesheet entrypoint.");
}

for (const entrypoint of entrypoints) {
  if (!entrypoint.startsWith(`${base}assets/`)) {
    throw new Error(
      `Static entrypoint ${entrypoint} does not use the configured base path ${base}.`,
    );
  }
  const relative = entrypoint.slice(base.length);
  if (!existsSync(resolve(output, relative))) {
    throw new Error(`Static entrypoint ${entrypoint} was not emitted into dist/.`);
  }
}

process.stdout.write(`Verified static PWA base path ${base}.\n`);
