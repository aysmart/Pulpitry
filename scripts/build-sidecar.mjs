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
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
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

/**
 * Refuses to bundle a bridge that has been edited in place.
 *
 * src/index.js is a copy of castavox-core/bridge/index.js, and Castavox ships
 * the same file. An edit made here is an edit Castavox never receives, which is
 * how one product gets a fix and the other keeps the bug — found, eventually,
 * by a church rather than by us.
 */
function verifyBridge() {
  const lock = JSON.parse(readFileSync(resolve(sidecarDir, "src/bridge.lock.json"), "utf8"));
  const found = createHash("sha256")
    // Line endings normalised first: Git for Windows converts LF to CRLF on
    // checkout, so hashing the raw bytes fails every Windows build while macOS
    // and Linux pass, and reports it as the bridge having been tampered with.
    // What is being caught here is a copy edited in place rather than in
    // castavox-core; a newline convention is not that. Must match `hashOf` in
    // castavox-core/bridge/sync.mjs, which writes the lock.
    .update(readFileSync(resolve(sidecarDir, "src/index.js"), "utf8").replace(/\r\n/g, "\n"), "utf8")
    .digest("hex");
  if (found === lock.sha256) return;

  throw new Error(
    [
      "src/index.js is not the bridge it was copied from.",
      `  expected ${lock.sha256}`,
      `  found    ${found}`,
      "",
      "The bridge is shared with Castavox. Make the change in",
      "castavox-core/bridge/index.js and run `node bridge/sync.mjs` there,",
      "which updates both products together.",
    ].join("\n"),
  );
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
  verifyBridge();
  ensureDependencies();
  await bundleSidecar();
  const size = (statSync(outputPath).size / 1024 / 1024).toFixed(1);
  console.log(`sidecar bundled: ${outputPath} (${size} MB)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
