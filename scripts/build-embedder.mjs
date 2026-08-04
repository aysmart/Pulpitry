#!/usr/bin/env node
/**
 * Fetches the sentence-embedding model Pulpitry bundles for offline paraphrase
 * matching, and converts its weights to half precision.
 *
 *   node scripts/build-embedder.mjs
 *
 * Output, in src-tauri/resources/embedder/:
 *   model.safetensors   all-MiniLM-L6-v2 weights, f16
 *   tokenizer.json      the matching WordPiece tokenizer
 *   config.json         BERT hyperparameters
 *
 * Upstream ships f32, which is 91 MB. Nothing here needs that precision:
 * embeddings are compared by cosine similarity, where f16 rounding is far below
 * the noise floor of speech recognition. Halving it saves 45 MB of install
 * size, and candle converts back to f32 when loading so inference speed is
 * unaffected.
 *
 * The converted files are large binaries and are NOT committed; run this once
 * before building. `npm run tauri:build` does it automatically.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = resolve(root, "src-tauri/resources/embedder");

const REPO = "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main";

async function download(name) {
  const response = await fetch(`${REPO}/${name}`);
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Rewrites every F32 tensor in a safetensors buffer as F16.
 *
 * The format is: an 8-byte little-endian header length, a JSON header mapping
 * tensor names to {dtype, shape, data_offsets}, then the raw tensor bytes.
 */
function toHalfPrecision(buffer) {
  const headerLength = Number(buffer.readBigUInt64LE(0));
  const headerJson = buffer.subarray(8, 8 + headerLength).toString("utf8");
  const header = JSON.parse(headerJson);
  const dataStart = 8 + headerLength;

  const metadata = header.__metadata__;
  const entries = Object.entries(header).filter(([name]) => name !== "__metadata__");

  // Preserve declaration order so offsets stay contiguous and ascending.
  entries.sort((a, b) => a[1].data_offsets[0] - b[1].data_offsets[0]);

  const converted = [];
  const nextHeader = {};
  let offset = 0;

  for (const [name, info] of entries) {
    const [start, end] = info.data_offsets;
    const raw = buffer.subarray(dataStart + start, dataStart + end);

    let bytes;
    let dtype = info.dtype;
    if (info.dtype === "F32") {
      const floats = new Float32Array(
        raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
      );
      const halves = new Float16Array(floats);
      bytes = Buffer.from(halves.buffer, halves.byteOffset, halves.byteLength);
      dtype = "F16";
    } else {
      bytes = Buffer.from(raw);
    }

    nextHeader[name] = { dtype, shape: info.shape, data_offsets: [offset, offset + bytes.length] };
    converted.push(bytes);
    offset += bytes.length;
  }

  if (metadata) nextHeader.__metadata__ = metadata;

  let nextJson = Buffer.from(JSON.stringify(nextHeader), "utf8");
  // Safetensors requires the data section to start 8-byte aligned.
  const padding = (8 - (nextJson.length % 8)) % 8;
  if (padding) nextJson = Buffer.concat([nextJson, Buffer.alloc(padding, 0x20)]);

  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(nextJson.length));
  return Buffer.concat([length, nextJson, ...converted]);
}

function report(name, bytes) {
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  console.log(`${name.padEnd(20)} ${(bytes.length / 1e6).toFixed(1).padStart(6)} MB  ${digest}`);
}

async function main() {
  mkdirSync(outputDir, { recursive: true });

  const modelPath = resolve(outputDir, "model.safetensors");
  if (existsSync(modelPath) && !process.argv.includes("--force")) {
    console.log(`already present: ${modelPath} (pass --force to rebuild)`);
    return;
  }

  console.log("downloading all-MiniLM-L6-v2…");
  const [weights, tokenizer, config] = await Promise.all([
    download("model.safetensors"),
    download("tokenizer.json"),
    download("config.json"),
  ]);

  const half = toHalfPrecision(weights);
  if (half.length > weights.length * 0.75) {
    throw new Error("conversion did not shrink the weights; the format may have changed");
  }

  writeFileSync(modelPath, half);
  writeFileSync(resolve(outputDir, "tokenizer.json"), tokenizer);
  writeFileSync(resolve(outputDir, "config.json"), config);

  console.log(`\nsource f32 weights   ${(weights.length / 1e6).toFixed(1)} MB`);
  report("model.safetensors", half);
  report("tokenizer.json", tokenizer);
  report("config.json", config);
  console.log(`\nwritten to ${outputDir}`);
}

await main();
