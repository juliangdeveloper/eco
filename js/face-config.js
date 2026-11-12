import { json } from "./storage.js";

const KEY = "faceVoice";

export const FACE_VOICE_SETTINGS = Object.freeze([
  { group: "face", name: "idleMinSeconds", label: "Idle gesture from (s)", default: 4, min: 1, max: 60, step: 0.5 },
  { group: "face", name: "idleMaxSeconds", label: "Idle gesture to (s)", default: 8, min: 1, max: 120, step: 0.5 },
  { group: "face", name: "weightBlink", label: "Blink weight", default: 40, min: 0, max: 100, step: 1 },
  { group: "face", name: "weightLook", label: "Look around weight", default: 25, min: 0, max: 100, step: 1 },
  { group: "face", name: "weightTilt", label: "Head tilt weight", default: 15, min: 0, max: 100, step: 1 },
  { group: "face", name: "weightStretch", label: "Stretch weight", default: 10, min: 0, max: 100, step: 1 },
  { group: "face", name: "weightYawn", label: "Yawn weight", default: 10, min: 0, max: 100, step: 1 },
  { group: "face", name: "sleepyMinutes", label: "Sleepy after (min)", default: 3, min: 0.5, max: 120, step: 0.5 },
  { group: "face", name: "asleepMinutes", label: "Asleep after (min)", default: 10, min: 1, max: 240, step: 0.5 },
  { group: "face", name: "toolMinMs", label: "Tool animation min (ms)", default: 600, min: 100, max: 5000, step: 50 },
  { group: "face", name: "reactionMs", label: "Reaction length (ms)", default: 700, min: 200, max: 5000, step: 50 },
  { group: "face", name: "maxCharacters", label: "Subagents shown", default: 3, min: 0, max: 8, step: 1 },
  { group: "face", name: "faceScale", label: "Face size (%)", default: 100, min: 50, max: 200, step: 5 },
  { group: "voice", name: "phraseSilenceSeconds", label: "Phrase ends after (s)", default: 0.8, min: 0.2, max: 5, step: 0.1 },
  { group: "voice", name: "turnSilenceSeconds", label: "Turn ends after (s)", default: 1.5, min: 0.3, max: 10, step: 0.1 },
  { group: "voice", name: "maxSegmentSeconds", label: "Max phrase (s)", default: 15, min: 2, max: 30, step: 1 },
  { group: "voice", name: "unloadSeconds", label: "Unload transcriber after (s)", default: 30, min: 5, max: 600, step: 5 },
  { group: "voice", name: "autoOffMinutes", label: "Stop listening after (min)", default: 10, min: 1, max: 120, step: 1 },
  { group: "voice", name: "followUpSeconds", label: "Follow-up window (s)", default: 8, min: 0, max: 60, step: 0.5 },
  { group: "voice", name: "speechThreshold", label: "Voice detection threshold", default: 0.5, min: 0.1, max: 0.95, step: 0.05 },
  { group: "voice", name: "minSpeechMs", label: "Min speech (ms)", default: 250, min: 50, max: 2000, step: 50 },
  { group: "voice", name: "preSpeechPadMs", label: "Audio before speech (ms)", default: 300, min: 0, max: 2000, step: 50 },
  { group: "voice", name: "aliasTolerance", label: "Name match tolerance", default: 0.25, min: 0, max: 0.6, step: 0.05 },
  { group: "voice", name: "speechRate", label: "Speech rate", default: 1, min: 0.5, max: 2, step: 0.05 },
  { group: "voice", name: "speechPitch", label: "Speech pitch", default: 1, min: 0.5, max: 2, step: 0.05 }
]);

export const SPEECH_LANGUAGES = Object.freeze([["auto", "Automatic (device language)"], ["es", "Spanish"], ["en", "English"], ["pt", "Portuguese"], ["fr", "French"], ["de", "German"], ["it", "Italian"]]);
export const VOICE_TEXT_SETTINGS = Object.freeze({ voiceName: "", transcriber: "whisper-tiny", speechLanguage: "auto", neuralVoice: false });
export const VOICE_SWITCHES = Object.freeze({ listen: true, speak: true });
export const TRANSCRIBERS = Object.freeze({ "whisper-tiny": "onnx-community/whisper-tiny", "whisper-base": "onnx-community/whisper-base" });

const definitions = new Map(FACE_VOICE_SETTINGS.map((entry) => [entry.name, entry]));
const valid = (entry, value) => typeof value === "number" && Number.isFinite(value) && value >= entry.min && value <= entry.max;

export function faceVoiceSettings() {
  const stored = json(KEY) || {};
  const result = {};
  for (const entry of FACE_VOICE_SETTINGS) result[entry.name] = valid(entry, stored[entry.name]) ? stored[entry.name] : entry.default;
  for (const [name, fallback] of Object.entries(VOICE_TEXT_SETTINGS)) result[name] = typeof stored[name] === typeof fallback ? stored[name] : fallback;
  for (const [name, fallback] of Object.entries(VOICE_SWITCHES)) result[name] = typeof stored[name] === "boolean" ? stored[name] : typeof stored.enabled === "boolean" ? stored.enabled : fallback;
  if (!TRANSCRIBERS[result.transcriber]) result.transcriber = VOICE_TEXT_SETTINGS.transcriber;
  if (!SPEECH_LANGUAGES.some((item) => item[0] === result.speechLanguage)) result.speechLanguage = VOICE_TEXT_SETTINGS.speechLanguage;
  if (result.idleMaxSeconds < result.idleMinSeconds) result.idleMaxSeconds = result.idleMinSeconds;
  if (result.asleepMinutes <= result.sleepyMinutes) result.asleepMinutes = result.sleepyMinutes + 0.5;
  return result;
}

export function setFaceVoiceSetting(name, value) {
  const stored = json(KEY) || {};
  const entry = definitions.get(name);
  if (entry) {
    const number = Number(value);
    if (!valid(entry, number)) return false;
    stored[name] = number;
  } else if (Object.hasOwn(VOICE_TEXT_SETTINGS, name)) {
    const fallback = VOICE_TEXT_SETTINGS[name];
    stored[name] = typeof fallback === "boolean" ? Boolean(value) : String(value).slice(0, 80);
  } else if (Object.hasOwn(VOICE_SWITCHES, name)) stored[name] = Boolean(value);
  else return false;
  json(KEY, stored);
  window.dispatchEvent(new Event("eco-face-voice-settings"));
  return true;
}

export function resetFaceVoiceSettings(group) {
  const stored = json(KEY) || {};
  for (const entry of FACE_VOICE_SETTINGS) if (entry.group === group) delete stored[entry.name];
  if (group === "voice") for (const name of Object.keys(VOICE_TEXT_SETTINGS)) delete stored[name];
  json(KEY, stored);
  window.dispatchEvent(new Event("eco-face-voice-settings"));
}

export function emitActivity(type, detail = {}) {
  window.dispatchEvent(new CustomEvent("eco-activity", { detail: { type, ...detail } }));
}
