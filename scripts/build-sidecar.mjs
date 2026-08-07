#!/usr/bin/env node
/**
 * Bundles the speech sidecar into a single script Tauri ships as a resource.
 *
 *   node scripts/build-sidecar.mjs
 *
 * esbuild flattens the sidecar and the Azure Speech SDK into one CommonJS
 * file, and that is the whole build. The app runs it on whatever Node the
 * machine already has.
 *
 * It used to fuse the bundle into a copy of the Node runtime with Single
 * Executable Applications, which produced a 115 MB binary — an entire runtime
 * shipped to deliver one WebSocket client, on every update, for every user who
 * already had a way to install Node. The script is roughly a thousandth of
 * that, and Rust locates a runtime at start-up (see src-tauri/src/node.rs).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sidecarDir = resolve(root, "src-sidecar");
const outputDir = resolve(root, "src-tauri/resources/sidecar");
const outputPath = resolve(outputDir, "pulpitry-speech.cjs");

const onWindows = process.platform === "win32";

/**
 * Runs a command, and copes with npm being a batch file on Windows.
 *
 * Two separate problems, and fixing only the first is why this looked solved
 * and was not. npm is a `.cmd` shim there and execFileSync does not apply
 * PATHEXT, so the bare name is not found -- hence the suffix. Then Node 20.12
 * closed CVE-2024-27980 by refusing to spawn `.cmd` and `.bat` at all without
 * a shell, so the suffixed name started failing with a bare EINVAL that names
 * neither npm nor the reason.
 *
 * `shell: true` is the documented answer. Nothing here interpolates user input
 * into a command line, so handing one to a shell adds no exposure.
 */
const run = (cmd, args, options = {}) =>
  execFileSync(onWindows && cmd === "npm" ? "npm.cmd" : cmd, args, {
    stdio: "inherit",
    cwd: root,
    shell: onWindows,
    ...options,
  });

function ensureDependencies() {
  if (existsSync(resolve(sidecarDir, "node_modules"))) return;
  console.log("installing sidecar dependencies...");
  run("npm", ["install", "--no-audit", "--no-fund"], { cwd: sidecarDir });
}

async function bundleSidecar() {
  console.log("bundling sidecar...");
  mkdirSync(outputDir, { recursive: true });
  await build({
    entryPoints: [resolve(sidecarDir, "src/index.js")],
    outfile: outputPath,
    bundle: true,
    platform: "node",
    format: "cjs",
    // The floor the app enforces before it will spawn anything; see
    // MINIMUM_MAJOR in src-tauri/src/node.rs. These must not drift apart.
    target: "node20",
    minify: true,
    // `ws` probes for these optional native accelerators inside a try/catch;
    // leaving them external keeps them from being resolved at build time.
    external: ["bufferutil", "utf-8-validate"],
    logLevel: "warning",
  });
}

async function main() {
  ensureDependencies();
  await bundleSidecar();
  const size = (statSync(outputPath).size / 1024 / 1024).toFixed(1);
  console.log(`sidecar bundled: ${outputPath} (${size} MB)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
