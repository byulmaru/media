import { readFile } from "node:fs/promises";

import { initializeCodec } from "./codec";

const wasmPackages = [
  "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm",
  "@jsquash/png/codec/pkg/squoosh_png_bg.wasm",
  "@jsquash/webp/codec/dec/webp_dec.wasm",
  "@jsquash/webp/codec/enc/webp_enc_simd.wasm",
] as const;

async function loadWasmModule(packagePath: string): Promise<WebAssembly.Module> {
  const bytes = await readFile(new URL(import.meta.resolve(packagePath)));
  return WebAssembly.compile(new Uint8Array(bytes));
}

export async function initializeNodeCodec(): Promise<void> {
  const [jpegDecode, pngDecode, webpDecode, webpEncode] = await Promise.all([
    loadWasmModule(wasmPackages[0]),
    loadWasmModule(wasmPackages[1]),
    loadWasmModule(wasmPackages[2]),
    loadWasmModule(wasmPackages[3]),
  ]);
  await initializeCodec({ jpegDecode, pngDecode, webpDecode, webpEncode });
}
