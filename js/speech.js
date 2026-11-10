import { emitActivity, faceVoiceSettings } from "./face-config.js";

const PIPER_URL = "https://esm.sh/@mintplex-labs/piper-tts-web@1.0.5?deps=onnxruntime-web@1.22.0";
const PIPER_PHONEMIZE = "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize";
const PIPER_WASM = { onnxWasm: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/", piperData: PIPER_PHONEMIZE + ".data", piperWasm: PIPER_PHONEMIZE + ".wasm" };
const PIPER_VOICES = { en: "en_US-hfc_female-medium", es: "es_ES-davefx-medium", pt: "pt_BR-faber-medium", fr: "fr_FR-siwis-medium", de: "de_DE-thorsten-medium", it: "it_IT-paola-medium" };
const DETAILS = { en: "The details are in the chat.", es: "Los detalles están en el chat.", pt: "Os detalhes estão no chat.", fr: "Les détails sont dans le chat.", de: "Die Details stehen im Chat.", it: "I dettagli sono nella chat." };
const WORDS = {
  es: /\b(el|la|los|las|que|de|y|en|un|una|es|por|para|con|está|tienes|puedo|hola|sí)\b/g,
  pt: /\b(o|os|as|que|de|e|em|um|uma|é|para|com|não|você|está|olá|sim)\b/g,
  fr: /\b(le|la|les|que|de|et|en|un|une|est|pour|avec|pas|vous|je|bonjour|oui)\b/g,
  de: /\b(der|die|das|und|ist|nicht|ich|du|ein|eine|mit|für|auf|ja|hallo)\b/g,
  it: /\b(il|lo|gli|che|di|e|un|una|è|per|con|non|sono|ciao|sì)\b/g,
  en: /\b(the|and|is|are|you|to|of|in|that|it|for|with|this|can|hello|yes)\b/g
};
let queue = [];
let speaking = false;
let generation = 0;
let piper = null;
let piperSession = null;
let piperVoice = "";
let audioContext = null;
let currentSource = null;
let levelTimer = null;
const listeners = new Set();
export const speechStats = { neural: null };

export function onSpeakingChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }

function setSpeaking(value) {
  if (speaking === value) return;
  speaking = value;
  emitActivity("speaking", { on: value });
  for (const listener of listeners) { try { listener(value); } catch {} }
}

export const isSpeaking = () => speaking;

export function detectLanguage(text) {
  const sample = String(text).toLocaleLowerCase().slice(0, 2000);
  let best = "";
  let score = 0;
  for (const [language, pattern] of Object.entries(WORDS)) {
    const count = (sample.match(pattern) || []).length;
    if (count > score) { best = language; score = count; }
  }
  return best || (navigator.language || "en").slice(0, 2).toLowerCase();
}

export function speakable(text) {
  let skipped = false;
  let value = String(text || "");
  value = value.replace(/```[\s\S]*?(```|$)/g, () => { skipped = true; return " "; });
  value = value.split("\n").filter((line) => { if (/^\s*\|.*\|\s*$/.test(line) || /^\s*\|?\s*:?-{3,}/.test(line)) { skipped = true; return false; } return true; }).join("\n");
  value = value.replace(/\[([^\]]*)\]\((?:[^)]*)\)/g, (match, label) => { skipped = true; return label; });
  value = value.replace(/https?:\/\/\S+/g, () => { skipped = true; return ""; });
  value = value.replace(/`[^`]*`/g, () => { skipped = true; return ""; });
  value = value.replace(/[*_#>~]+/g, "").replace(/^\s*[-•]\s+/gm, "").replace(/[ \t]+/g, " ");
  const sentences = value.split(/(?<=[.!?…])\s+|\n+/).map((part) => part.trim()).filter((part) => /[\p{L}\p{N}]/u.test(part));
  return { sentences, skipped };
}

function pickVoice(language) {
  const voices = speechSynthesis.getVoices();
  const chosen = faceVoiceSettings().voiceName;
  return voices.find((voice) => voice.name === chosen) || voices.find((voice) => voice.lang?.toLowerCase().startsWith(language) && voice.localService) || voices.find((voice) => voice.lang?.toLowerCase().startsWith(language)) || null;
}

function systemSay(sentence, language, run) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) { resolve(); return; }
    const utterance = new SpeechSynthesisUtterance(sentence);
    const values = faceVoiceSettings();
    const voice = pickVoice(language);
    if (voice) utterance.voice = voice;
    utterance.lang = voice?.lang || language;
    utterance.rate = values.speechRate;
    utterance.pitch = values.speechPitch;
    utterance.onboundary = () => emitActivity("mouth", {});
    utterance.onend = utterance.onerror = () => resolve();
    if (run !== generation) { resolve(); return; }
    speechSynthesis.speak(utterance);
  });
}

async function loadPiper() {
  if (!piper) piper = import(PIPER_URL).catch((error) => { piper = null; throw error; });
  return piper;
}

async function neuralSay(sentence, language, run) {
  const started = performance.now();
  const tts = await loadPiper();
  const voiceId = PIPER_VOICES[language] || PIPER_VOICES.en;
  let downloaded = 0;
  if (piperVoice !== voiceId) {
    tts.TtsSession._instance = null;
    piperVoice = voiceId;
    piperSession = tts.TtsSession.create({ voiceId, wasmPaths: PIPER_WASM, progress: (progress) => { downloaded = Math.max(downloaded, progress?.total || 0); } }).catch((error) => { piperVoice = ""; tts.TtsSession._instance = null; throw error; });
  }
  const session = await piperSession;
  const wav = await session.predict(sentence);
  speechStats.neural ||= { voiceId, firstMs: Math.round(performance.now() - started), downloadBytes: downloaded };
  if (run !== generation) return;
  audioContext ||= new AudioContext();
  if (audioContext.state === "suspended") await audioContext.resume().catch(() => {});
  const buffer = await audioContext.decodeAudioData(await wav.arrayBuffer());
  if (run !== generation) return;
  await new Promise((resolve) => {
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = faceVoiceSettings().speechRate;
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    analyser.connect(audioContext.destination);
    const data = new Uint8Array(analyser.fftSize);
    clearInterval(levelTimer);
    levelTimer = setInterval(() => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const sample of data) sum += ((sample - 128) / 128) ** 2;
      emitActivity("mouth", { level: Math.sqrt(sum / data.length) });
    }, 60);
    source.onended = () => { clearInterval(levelTimer); emitActivity("mouth", { level: -1 }); resolve(); };
    currentSource = source;
    source.start();
  });
}

async function drain(run) {
  while (queue.length && run === generation) {
    const { sentence, language } = queue.shift();
    if (faceVoiceSettings().neuralVoice) {
      try { await neuralSay(sentence, language, run); continue; }
      catch (error) { speechStats.neural = { error: String(error?.message || error).slice(0, 200) }; window.dispatchEvent(new CustomEvent("eco-voice-notice", { detail: "The neural voice could not load. Using the system voice." })); }
    }
    await systemSay(sentence, language, run);
  }
  if (run === generation) setSpeaking(false);
}

export function speak(text, { final = true } = {}) {
  const { sentences, skipped } = speakable(text);
  const language = detectLanguage(text);
  if (skipped && final) sentences.push(DETAILS[language] || DETAILS.en);
  if (!sentences.length) return false;
  const idle = !speaking;
  queue.push(...sentences.map((sentence) => ({ sentence, language })));
  if (idle) { setSpeaking(true); drain(generation); }
  return true;
}

export function stopSpeaking() {
  generation += 1;
  queue = [];
  try { speechSynthesis.cancel(); } catch {}
  try { currentSource?.stop(); } catch {}
  clearInterval(levelTimer);
  setSpeaking(false);
}

export function unlockSpeech() {
  try { if ("speechSynthesis" in window && !speaking) { const utterance = new SpeechSynthesisUtterance(""); utterance.volume = 0; speechSynthesis.speak(utterance); } } catch {}
  try { audioContext ||= new AudioContext(); audioContext.resume().catch(() => {}); } catch {}
}

export function systemVoices() {
  try { return speechSynthesis.getVoices().map((voice) => ({ name: voice.name, lang: voice.lang })); } catch { return []; }
}
