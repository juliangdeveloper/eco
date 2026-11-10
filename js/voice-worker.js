const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js";
let recognizer = null;
let loading = null;

async function gpuAvailable() {
  try { return Boolean(self.navigator?.gpu && await self.navigator.gpu.requestAdapter()); } catch { return false; }
}

async function load(model) {
  const started = performance.now();
  const { pipeline, env } = await import(TRANSFORMERS_URL);
  env.allowLocalModels = false;
  const webgpu = await gpuAvailable();
  const files = new Map();
  const options = {
    device: webgpu ? "webgpu" : "wasm",
    dtype: webgpu ? { encoder_model: "fp32", decoder_model_merged: "q4" } : { encoder_model: "fp32", decoder_model_merged: "q8" },
    progress_callback: (event) => { if (event.status === "progress" && event.total) files.set(event.file, event.total); }
  };
  recognizer = await pipeline("automatic-speech-recognition", model, options);
  return { device: options.device, loadMs: Math.round(performance.now() - started), downloadBytes: [...files.values()].reduce((sum, value) => sum + value, 0) };
}

self.onmessage = async (event) => {
  const { type, id, model, audio, language } = event.data || {};
  try {
    if (type === "load") {
      loading ||= load(model);
      self.postMessage({ type: "loaded", id, ...(await loading) });
      return;
    }
    if (type === "transcribe") {
      if (!recognizer) { loading ||= load(model); await loading; }
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
