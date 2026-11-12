export const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js";
export const TRANSFORMERS_WASM = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/";
export const ORT_WASM = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/";

export function wasmOnly(source = typeof self !== "undefined" ? self.navigator || {} : {}) {
  const ua = source.userAgent || "";
  const platform = source.platform || "";
  const touch = source.maxTouchPoints || 0;
  return /iPad|iPhone|iPod/.test(ua) || (platform === "MacIntel" && touch > 1) || (/Safari/i.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|EdgiOS|Android/i.test(ua));
}

export function transcriberDtype(quantization, webgpu) {
  if (quantization === "fp32") return { encoder_model: "fp32", decoder_model_merged: "fp32" };
  if (quantization === "q4" || quantization === "q4f16") return { encoder_model: "fp32", decoder_model_merged: quantization };
  if (quantization === "q8") return { encoder_model: "fp32", decoder_model_merged: "q8" };
  return webgpu ? { encoder_model: "fp32", decoder_model_merged: "q4" } : { encoder_model: "fp32", decoder_model_merged: "q8" };
}

async function gpuAvailable() {
  try { return Boolean(self.navigator?.gpu && await self.navigator.gpu.requestAdapter()); } catch { return false; }
}

export function applyWasmEnv(env, wasmPaths) {
  if (!env.backends?.onnx?.wasm) return;
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
  env.backends.onnx.wasm.wasmPaths = wasmPaths || TRANSFORMERS_WASM;
}

export async function loadTranscriber(options = {}) {
  const started = performance.now();
  const { pipeline, env } = await import(TRANSFORMERS_URL);
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  const wasmPaths = options.wasmPaths || TRANSFORMERS_WASM;
  applyWasmEnv(env, wasmPaths);
  const files = new Map();
  const preferGpu = options.backend === "webgpu" || options.backend === "auto" || options.backend == null;
  const webgpu = preferGpu && options.backend !== "wasm" && !wasmOnly() && await gpuAvailable();
  const device = webgpu ? "webgpu" : "wasm";
  const dtype = transcriberDtype(options.quantization, webgpu);
  const model = options.source || options.model;
  if (!model) throw new Error("No transcriber model or source was set");
  const recognizer = await pipeline("automatic-speech-recognition", model, {
    device,
    dtype,
    progress_callback: (event) => { if (event.status === "progress" && event.total) files.set(event.file, event.total); }
  });
  return {
    recognizer,
    info: {
      device,
      source: model,
      quantization: dtype.decoder_model_merged,
      wasmPaths,
      mode: options.mode || "main",
      loadMs: Math.round(performance.now() - started),
      downloadBytes: [...files.values()].reduce((sum, value) => sum + value, 0)
    }
  };
}

export async function runTranscribe(recognizer, audio, language) {
  const options = { task: "transcribe", chunk_length_s: 30, return_timestamps: false };
  if (language) options.language = language;
  let result;
  try { result = await recognizer(audio, options); }
  catch (error) { if (!options.language) throw error; delete options.language; result = await recognizer(audio, options); }
  return String(result?.text || "").trim();
}

export function transcriberAttempts(options = {}, tiny = "onnx-community/whisper-tiny") {
  const attempts = [];
  const seen = new Set();
  const push = (attempt) => {
    const key = [attempt.mode, attempt.backend, attempt.source, attempt.quantization || "", attempt.wasmPaths].join("|");
    if (seen.has(key)) return;
    seen.add(key);
    attempts.push(attempt);
  };
  const source = options.source || options.model;
  push({ mode: "worker", backend: options.backend || "auto", source, quantization: options.quantization || "", wasmPaths: TRANSFORMERS_WASM });
  push({ mode: "worker", backend: "wasm", source, quantization: options.quantization || "q8", wasmPaths: TRANSFORMERS_WASM });
  push({ mode: "worker", backend: "wasm", source, quantization: "q8", wasmPaths: ORT_WASM });
  if (source !== tiny) push({ mode: "worker", backend: "wasm", source: tiny, quantization: "q8", wasmPaths: TRANSFORMERS_WASM });
  push({ mode: "main", backend: "wasm", source, quantization: options.quantization || "q8", wasmPaths: TRANSFORMERS_WASM });
  if (source !== tiny) push({ mode: "main", backend: "wasm", source: tiny, quantization: "q8", wasmPaths: TRANSFORMERS_WASM });
  return attempts;
}
