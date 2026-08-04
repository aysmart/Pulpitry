#!/usr/bin/env node
/**
 * Builds the speech sidecar into a standalone executable that Tauri bundles
 * alongside the app.
 *
 *   node scripts/build-sidecar.mjs
 *
 * Two steps: esbuild flattens the sidecar and the Azure SDK into one CommonJS
 * file, then Node's Single Executable Application support fuses that file into
 * a copy of the Node runtime. The result is named with the Rust host target
 * triple, which is the filename convention Tauri's `externalBin` expects.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sidecarDir = resolve(root, "src-sidecar");
const workDir = resolve(sidecarDir, "build");
const bundle = resolve(workDir, "sidecar.cjs");
const binariesDir = resolve(root, "src-tauri/binaries");

const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, { stdio: "inherit", cwd: root, ...options });

/** Tauri looks for `<name>-<rust target triple>`. */
function hostTargetTriple() {
  try {
    const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
    const host = out.split("\n").find((line) => line.startsWith("host:"));
    if (host) return host.slice("host:".length).trim();
  } catch {
    /* fall through to a platform guess */
  }
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (process.platform === "darwin") return `${arch}-apple-darwin`;
  if (process.platform === "win32") return `${arch}-pc-windows-msvc`;
  return `${arch}-unknown-linux-gnu`;
}

function ensureDependencies() {
  if (existsSync(resolve(sidecarDir, "node_modules"))) return;
  console.log("installing sidecar dependencies...");
  run("npm", ["install", "--no-audit", "--no-fund"], { cwd: sidecarDir });
}

async function bundleSidecar() {
  console.log("bundling sidecar...");
  await build({
    entryPoints: [resolve(sidecarDir, "src/index.js")],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    minify: true,
    // `ws` probes for these optional native accelerators inside a try/catch;
    // leaving them external keeps them from being resolved at build time.
    external: ["bufferutil", "utf-8-validate"],
    logLevel: "warning",
  });
}

/**
 * A universal Node binary carries the SEA sentinel once per architecture slice,
 * which postject rejects as ambiguous. Reduce it to the slice matching the
 * target triple — that is the only one this build could run on anyway.
 */
function thinToNativeSlice(binaryPath, triple) {
  if (process.platform !== "darwin") return;
  const description = execFileSync("file", [binaryPath], { encoding: "utf8" });
  if (!description.includes("universal binary")) return;

  const arch = triple.startsWith("aarch64") ? "arm64" : "x86_64";
  const thinned = `${binaryPath}.${arch}`;
  console.log(`thinning the universal Node binary to ${arch}...`);
  run("lipo", [binaryPath, "-thin", arch, "-output", thinned]);
  renameSync(thinned, binaryPath);
  chmodSync(binaryPath, 0o755);
}

function fuseExecutable(outputPath, triple) {
  const seaConfig = resolve(workDir, "sea-config.json");
  const blob = resolve(workDir, "sidecar.blob");

  writeFileSync(
    seaConfig,
    JSON.stringify(
      { main: bundle, output: blob, disableExperimentalSEAWarning: true },
      null,
      2,
    ),
  );

  console.log("preparing SEA blob...");
  run(process.execPath, ["--experimental-sea-config", seaConfig]);

  copyFileSync(process.execPath, outputPath);
  chmodSync(outputPath, 0o755);
  thinToNativeSlice(outputPath, triple);

  // A signed binary cannot be modified; macOS needs the signature stripped
  // first and an ad-hoc one applied afterwards.
  if (process.platform === "darwin") {
    try {
      run("codesign", ["--remove-signature", outputPath], { stdio: "ignore" });
    } catch {
      /* unsigned already */
    }
  }

  console.log("injecting sidecar into the runtime...");
  const injectArgs = [
    "postject",
    outputPath,
    "NODE_SEA_BLOB",
    blob,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ];
  if (process.platform === "darwin") injectArgs.push("--macho-segment-name", "NODE_SEA");
  run("npx", ["--yes", ...injectArgs]);

  if (process.platform === "darwin") {
    run("codesign", ["--sign", "-", outputPath]);
  }
}

async function main() {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  mkdirSync(binariesDir, { recursive: true });

  ensureDependencies();
  await bundleSidecar();

  const triple = hostTargetTriple();
  const suffix = process.platform === "win32" ? ".exe" : "";
  const outputPath = resolve(binariesDir, `pulpitry-speech-${triple}${suffix}`);
  rmSync(outputPath, { force: true });

  fuseExecutable(outputPath, triple);
  console.log(`sidecar built: ${outputPath}`);
}

await main();
