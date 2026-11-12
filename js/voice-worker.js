const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js";
let recognizer = null;
let loading = null;

function wasmOnly() {
  const ua = self.navigator?.userAgent || "";
  const platform = self.navigator?.platform || "";
  const touch = self.navigator?.maxTouchPoints || 0;
  return /iPad|iPhone|iPod/.test(ua) || (platform === "MacIntel" && touch > 1) || (/Safari/i.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|EdgiOS|Android/i.test(ua));
}

async function gpuAvailable() {
  try { return Boolean(self.navigator?.gpu && await self.navigator.gpu.requestAdapter()); } catch { return false; }
}

async function load(model, device) {
  const started = performance.now();
  const { pipeline, env } = await import(TRANSFORMERS_URL);
  env.allowLocalModels = false;
  if (env.backends?.onnx?.wasm) env.backends.onnx.wasm.numThreads = 1;
  const files = new Map();
  const webgpu = device !== "wasm" && !wasmOnly() && await gpuAvailable();
  const options = {
    device: webgpu ? "webgpu" : "wasm",
    dtype: webgpu ? { encoder_model: "fp32", decoder_model_merged: "q4" } : { encoder_model: "fp32", decoder_model_merged: "q8" },
    progress_callback: (event) => { if (event.status === "progress" && event.total) files.set(event.file, event.total); }
  };
  recognizer = await pipeline("automatic-speech-recognition", model, options);
  return { device: options.device, loadMs: Math.round(performance.now() - started), downloadBytes: [...files.values()].reduce((sum, value) => sum + value, 0) };
}

self.onmessage = async (event) => {
  const { type, id, model, audio, language, device } = event.data || {};
  try {
    if (type === "load") {
      loading ||= load(model, device);
      self.postMessage({ type: "loaded", id, ...(await loading) });
      return;
    }
    if (type === "transcribe") {
      if (!recognizer) { loading ||= load(model, device); await loading; }
      const options = { task: "transcribe", chunk_length_s: 30, return_timestamps: false };
      if (language) options.language = language;
      let result;
      try { result = await recognizer(audio, options); }
      catch (error) { if (!options.language) throw error; delete options.language; result = await recognizer(audio, options); }
      self.postMessage({ type: "text", id, text: String(result?.text || "").trim() });
    }
  } catch (error) {
    self.postMessage({ type: "error", id, error: String(error?.message || error) });
  }
};
