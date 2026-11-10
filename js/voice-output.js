import { deviceCapabilities } from "./capabilities.js";
import { faceVoiceSettings } from "./face-config.js";
import { ecoName } from "./identity.js";
import { queueUntilGesture, speak, speechStatus, speechUnlocked, stopSpeaking } from "./speech.js";

const MAX_TEXT = 4000;

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
