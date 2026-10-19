import jpegDecodeWasm from "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm";
// @ts-expect-error Wrangler exposes imported Wasm files as default WebAssembly.Module values.
import pngWasm from "@jsquash/png/codec/pkg/squoosh_png_bg.wasm";
import webpDecodeWasm from "@jsquash/webp/codec/dec/webp_dec.wasm";
import webpEncodeWasm from "@jsquash/webp/codec/enc/webp_enc_simd.wasm";

import { app } from "./app";
import { initializeCodec } from "./codec";

void initializeCodec({
  jpegDecode: jpegDecodeWasm,
  pngDecode: pngWasm,
  webpDecode: webpDecodeWasm,
  webpEncode: webpEncodeWasm,
});

export default app;
