import { deviceCapabilities } from "./capabilities.js";
import { faceVoiceSettings } from "./face-config.js";
import { ecoName } from "./identity.js";
import { queueUntilGesture, speak, speechStatus, speechUnlocked, stopSpeaking } from "./speech.js";

const MAX_TEXT = 4000;
const FOLLOW_MAX = 60;
let listenApi = null;

export function bindListenApi(api) {
  listenApi = api;
}

export function speakTool(args = {}) {
  const text = String(args.text || "").trim().slice(0, MAX_TEXT);
  const interrupt = Boolean(args.interrupt);
  if (!deviceCapabilities().speak) return { ok: false, spoken: false, status: "unsupported", error: "This device has no voice output, so nothing was said." };
  if (!faceVoiceSettings().speak) return { ok: false, spoken: false, status: "disabled", error: "Speech is turned off in Settings › Voice › Speak, so nothing was said. Tell the requester." };
  if (!text) return { ok: false, spoken: false, status: "empty", error: "There is no text to say." };
  if (interrupt) stopSpeaking();
  if (!speechUnlocked()) return { ok: true, spoken: false, status: "queued", queued: queueUntilGesture(text, interrupt), message: "Queued until first tap" };
  if (!speak(text, { final: false })) return { ok: false, spoken: false, status: "empty", error: "The text has nothing that can be said aloud." };
  return { ok: true, spoken: true, status: "speaking" };
}

export async function listenTool(args = {}) {
  if (!listenApi) return { ok: false, status: "error", error: "Voice is not ready." };
  const action = String(args.action ?? (args.on === true ? "on" : args.on === false ? "off" : "")).toLowerCase();
  if (!deviceCapabilities().listen) return { ok: false, status: "unsupported", error: "This device has no microphone Eco can use." };
  if (action !== "on" && action !== "off") return { ok: false, status: "invalid", error: "escuchar needs action on or off." };
  const raw = args.follow_up ?? args.listen_for;
  let followUp;
  if (raw !== undefined && raw !== null && raw !== "") {
    followUp = Number(raw);
    if (!Number.isFinite(followUp) || followUp < 0 || followUp > FOLLOW_MAX) return { ok: false, status: "invalid", error: "follow_up must be between 0 and 60 seconds." };
  }
  if (action === "off") return listenApi.stopListen();
  return listenApi.requestListen({ followUp });
}

export function voiceState(voice) {
  const caps = deviceCapabilities();
  const values = faceVoiceSettings();
  const { name, wakeWords, enabled, ...listening } = voice.status();
  return {
    name: name || ecoName(),
    listen: { supported: caps.listen, enabled: caps.listen && values.listen, active: enabled, ...listening, wakeWords, microphones: caps.microphones, permission: caps.permission },
    speak: { supported: caps.speak, enabled: caps.speak && values.speak, ...speechStatus(), systemVoices: caps.systemVoices, piper: caps.piper }
  };
}
