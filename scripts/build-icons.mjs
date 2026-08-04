#!/usr/bin/env node
/**
 * Regenerates the Pulpitry icon set from assets/pulpitry-mark.svg.
 *
 *   node scripts/build-icons.mjs
 *
 * Renders the source SVG to a 1024x1024 master PNG, then hands it to the Tauri
 * CLI, which emits the full per-platform set into src-tauri/icons:
 *   - icon.icns  (macOS, 16 -> 1024)
 *   - icon.ico   (Windows, 16 -> 256)
 *   - assorted PNGs for Linux and the Windows Store tiles
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "assets/pulpitry-mark.svg");
const workDir = resolve(root, "assets/generated");
const master = resolve(workDir, "icon-1024.png");

if (!existsSync(source)) {
  console.error(`Missing logo source: ${source}`);
  process.exit(1);
}

mkdirSync(workDir, { recursive: true });

// density scales the SVG rasterisation; the mark is authored on a 512 grid, so
// 2x density gives us a clean 1024 master with no interpolation artefacts.
await sharp(source, { density: 384 }).resize(1024, 1024).png().toFile(master);
console.log(`rendered ${master}`);

// A few preview sizes, so the mark can be eyeballed at the sizes that matter.
for (const size of [16, 32, 64, 128, 256]) {
  const out = resolve(workDir, `preview-${size}.png`);
  await sharp(master).resize(size, size).png().toFile(out);
}
console.log(`rendered previews into ${workDir}`);

execFileSync("npx", ["tauri", "icon", master, "--output", resolve(root, "src-tauri/icons")], {
  cwd: root,
  stdio: "inherit",
});
console.log("icon set written to src-tauri/icons");
