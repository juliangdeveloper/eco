import { faceVoiceSettings } from "./face-config.js";
import { json } from "./storage.js";

const RECHECK_MS = [0, 1500, 5000];
const state = { listen: false, speak: false, microphones: 0, permission: "unknown", systemVoices: 0, piper: false, checked: false };
const listeners = new Set();
let running = null;
let again = false;
let watching = false;

export const deviceCapabilities = () => ({ ...state });

export function onCapabilities(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function systemVoiceCount() {
  try { return "speechSynthesis" in window && typeof window.SpeechSynthesisUtterance === "function" ? speechSynthesis.getVoices().length : 0; } catch { return 0; }
}

export function piperUsable() {
  return Boolean(faceVoiceSettings().neuralVoice && (window.AudioContext || window.webkitAudioContext) && window.WebAssembly);
}

async function microphone() {
  const media = navigator.mediaDevices;
  if (!media?.getUserMedia) return { available: false, microphones: 0, permission: "unsupported" };
  let permission = "unknown";
  try { permission = (await navigator.permissions.query({ name: "microphone" })).state; } catch {}
  let microphones = null;
  if (media.enumerateDevices) {
    try { microphones = (await media.enumerateDevices()).filter((device) => device.kind === "audioinput").length; } catch {}
  }
  return { available: microphones === null ? permission !== "denied" : microphones > 0, microphones: microphones || 0, permission };
}

async function evaluate() {
  const mic = await microphone();
  const systemVoices = systemVoiceCount();
  const piper = piperUsable();
  const next = { listen: mic.available, speak: systemVoices > 0 || piper, microphones: mic.microphones, permission: mic.permission, systemVoices, piper, checked: true };
  const changed = next.listen !== state.listen || next.speak !== state.speak || !state.checked;
  Object.assign(state, next);
  if (changed) for (const listener of listeners) { try { listener(deviceCapabilities()); } catch {} }
}

export function refreshCapabilities() {
  if (running) { again = true; return running; }
  running = evaluate().catch(() => {}).finally(() => {
    running = null;
    if (again) { again = false; refreshCapabilities(); }
  });
  return running;
}

async function watchPermission() {
  try { const status = await navigator.permissions.query({ name: "microphone" }); status.addEventListener("change", () => refreshCapabilities()); } catch {}
}

export function watchCapabilities() {
  if (watching) return refreshCapabilities();
  watching = true;
  try { navigator.mediaDevices?.addEventListener?.("devicechange", () => refreshCapabilities()); } catch {}
  try { speechSynthesis.addEventListener?.("voiceschanged", () => refreshCapabilities()); } catch {}
  window.addEventListener("eco-face-voice-settings", () => refreshCapabilities());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshCapabilities(); });
  watchPermission();
  for (const wait of RECHECK_MS.slice(1)) setTimeout(() => refreshCapabilities(), wait);
  return refreshCapabilities();
}

export const MICROPHONE_GRANTED_KEY = "microphoneGranted";

export async function microphoneGranted() {
  if (state.permission === "granted") return true;
  if (state.permission === "denied") return false;
  try {
    const status = (await navigator.permissions.query({ name: "microphone" })).state;
    if (status === "granted") { state.permission = "granted"; return true; }
    if (status === "denied") { state.permission = "denied"; json(MICROPHONE_GRANTED_KEY, false); return false; }
  } catch {}
  return json(MICROPHONE_GRANTED_KEY) === true;
}

export function rememberMicrophoneGrant(granted) {
  json(MICROPHONE_GRANTED_KEY, Boolean(granted));
  if (granted) state.permission = "granted";
}

export const listenOn = () => state.listen && faceVoiceSettings().listen;

export const speakOn = () => state.speak && faceVoiceSettings().speak;
