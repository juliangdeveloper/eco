import { loadTranscriber, runTranscribe } from "./voice-transcribe.js";

let recognizer = null;
let loading = null;

self.onmessage = async (event) => {
  const data = event.data || {};
  const { type, id } = data;
  try {
    if (type === "load") {
      loading = loadTranscriber({ ...data, mode: "worker" }).then((loaded) => {
        recognizer = loaded.recognizer;
        return loaded.info;
      });
      self.postMessage({ type: "loaded", id, ...(await loading) });
      return;
    }
    if (type === "transcribe") {
      if (!recognizer) {
        loading ||= loadTranscriber({ ...data, mode: "worker" }).then((loaded) => {
          recognizer = loaded.recognizer;
          return loaded.info;
        });
        await loading;
      }
      const text = await runTranscribe(recognizer, data.audio, data.language);
      self.postMessage({ type: "text", id, text });
    }
  } catch (error) {
    loading = null;
    recognizer = null;
    self.postMessage({ type: "error", id, error: String(error?.message || error) });
  }
};
