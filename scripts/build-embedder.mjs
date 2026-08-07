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

/**
 * One float32 to its float16 bit pattern, round-to-nearest-even.
 *
 * Written out rather than using the built-in half-precision typed array, which
 * needs Node 24. Everything else here runs on Node 18, and a build script that
 * dies with a ReferenceError on a supported Node is a worse trade than thirty
 * lines of bit shuffling.
 *
 * Round-to-nearest-even because that is what IEEE 754 specifies and what the
 * built-in does. Truncating instead would bias every weight toward zero -- a
 * small error, repeated across twenty-two million of them.
 */
/** A Float32Array to packed half-precision bytes, little-endian. */
function toHalfBytes(floats) {
  const bits = new Uint32Array(floats.buffer, floats.byteOffset, floats.length);
  const halves = new Uint16Array(floats.length);
  for (let i = 0; i < floats.length; i++) halves[i] = halfFromFloatBits(bits[i]);
  return Buffer.from(halves.buffer, halves.byteOffset, halves.byteLength);
}

function halfFromFloatBits(x) {
  const sign = (x >>> 16) & 0x8000;
  const exponent = (x >>> 23) & 0xff;
  let mantissa = x & 0x7fffff;

  // Infinity and NaN. A NaN has to stay a NaN, so keep a mantissa bit set:
  // dropping them all would silently turn it into an infinity.
  if (exponent === 0xff) return sign | 0x7c00 | (mantissa ? 0x0200 : 0);

  // float32 is biased by 127, float16 by 15.
  const e = exponent - 127 + 15;

  // Too large to represent: saturate to infinity.
  if (e >= 0x1f) return sign | 0x7c00;

  if (e <= 0) {
    // Below the smallest subnormal, everything rounds to a signed zero.
    if (e < -10) return sign;

    // Subnormal: restore the implicit leading bit and shift it down.
    mantissa |= 0x800000;
    const shift = 14 - e;
    const half = mantissa >>> shift;
    const remainder = mantissa & ((1 << shift) - 1);
    const halfway = 1 << (shift - 1);
    const roundUp = remainder > halfway || (remainder === halfway && (half & 1) === 1);
    return sign | (half + (roundUp ? 1 : 0));
  }

  // Normal. A carry out of the mantissa lands in the exponent, which is exactly
  // right -- including when it carries all the way to infinity.
  const half = (e << 10) | (mantissa >>> 13);
  const remainder = mantissa & 0x1fff;
  const roundUp = remainder > 0x1000 || (remainder === 0x1000 && (half & 1) === 1);
  return sign | (half + (roundUp ? 1 : 0));
}

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
      bytes = toHalfBytes(floats);
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
