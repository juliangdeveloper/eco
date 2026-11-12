import { emitActivity, faceVoiceSettings, setFaceVoiceSetting } from "./face-config.js";
import { requestHelp } from "./help.js";
import { registerComponent } from "./runtime.js";

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
const LOCALES = { en: "en-US", es: "es-ES", pt: "pt-BR", fr: "fr-FR", de: "de-DE", it: "it-IT" };
export const START_TIMEOUT_MS = 3000;
export const INSTANT_END_MS = 80;
export const TEST_VOICE_TEXT = "This is Eco's voice.";
const KEEP_ALIVE_MS = 4000;
let queue = [];
let speaking = false;
let draining = false;
let generation = 0;
let piper = null;
let piperSession = null;
let piperVoice = "";
let audioContext = null;
let currentSource = null;
let levelTimer = null;
let keepAlive = null;
let held = [];
let micCapture = false;
let listenSession = false;
const sessionHistory = [];
const SESSION_HISTORY = 12;
const listeners = new Set();
const startListeners = new Set();
const idleListeners = new Set();
const MAX_PENDING = 5;
const START_MIC_MS = 50;
let pending = [];
let gestured = false;
let lastError = null;
let lastVoice = "";
let lastUtterance = null;
let currentSentence = "";
let currentLanguage = "";
let micRetryUsed = false;
export const speechStats = { neural: null };

function fail(message) {
  lastError = { message: String(message).slice(0, 240), at: new Date().toISOString() };
}

function noticeVoice(message) {
  fail(message);
  window.dispatchEvent(new CustomEvent("eco-voice-notice", { detail: message }));
  requestHelp(message);
}

function notifyStart() {
  for (const listener of startListeners) { try { listener(); } catch {} }
}

function notifyIdle() {
  if (speechBusy()) return;
  for (const listener of [...idleListeners]) { try { listener(); } catch {} }
}

export function onUtteranceStart(listener) { startListeners.add(listener); return () => startListeners.delete(listener); }

export function onSpeechIdle(listener) { idleListeners.add(listener); return () => idleListeners.delete(listener); }

export function speechBusy() {
  return pending.length > 0 || queue.length > 0 || draining || speaking || held.length > 0;
}

export function afterSpeechStarts(fn) {
  if (!speechBusy() || speaking) { fn(); return; }
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    unsub();
    fn();
  };
  const unsub = onUtteranceStart(go);
  const timer = setTimeout(go, START_MIC_MS);
}

export async function restartCurrentUtterance() {
  if (micRetryUsed || !currentSentence) return { retried: false };
  if (lastUtterance?.started && !lastUtterance.ended && !lastUtterance.error) return { retried: false, ok: true };
  if (draining && lastUtterance && !lastUtterance.started && !lastUtterance.ended && !lastUtterance.error) {
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); unsub(); resolve(); };
      const unsub = onUtteranceStart(finish);
      const timer = setTimeout(finish, 400);
    });
    if (lastUtterance?.started && !lastUtterance.ended && !lastUtterance.error) return { retried: false, ok: true };
  }
  const failed = !lastUtterance || !lastUtterance.started || lastUtterance.error || (lastUtterance.ended && (!lastUtterance.started || (lastUtterance.endMs - (lastUtterance.startMs || 0)) <= INSTANT_END_MS));
  if (!failed) return { retried: false, ok: true };
  micRetryUsed = true;
  if (lastUtterance) lastUtterance.micRetry = { attempted: true, afterMic: true, reason: lastUtterance.error || (lastUtterance.started ? "ended" : "did-not-start"), audioSession: audioSessionInfo() };
  const prior = lastUtterance;
  const run = generation;
  await systemSay(currentSentence, currentLanguage, run);
  const ok = Boolean(lastUtterance?.started && !lastUtterance.error);
  if (lastUtterance) lastUtterance.micRetry = { ...(prior?.micRetry || lastUtterance.micRetry || {}), attempted: true, afterMic: true, ok };
  return { retried: true, ok, utterance: lastUtterance };
}

export function onSpeakingChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }

function setSpeaking(value) {
  if (speaking === value) return;
  speaking = value;
  emitActivity("speaking", { on: value });
  for (const listener of listeners) { try { listener(value); } catch {} }
  if (!value) notifyIdle();
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

function localeFor(language) {
  const value = String(language || "");
  if (value.includes("-")) return value;
  const code = value.slice(0, 2).toLowerCase();
  return LOCALES[code] || (typeof navigator !== "undefined" && navigator.language) || "en-US";
}

export function appleWebKit(source = typeof navigator === "undefined" ? {} : navigator) {
  const ua = String(source.userAgent || "");
  const iOS = /iPad|iPhone|iPod/.test(ua) || (source.platform === "MacIntel" && (source.maxTouchPoints || 0) > 1);
  const safari = /Safari/i.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|EdgiOS|Android/i.test(ua);
  return iOS || safari;
}

export function inIframe() {
  try { return window.self !== window.top; } catch { return true; }
}


export function setMicCapture(value) {
  micCapture = Boolean(value);
}

export const micCaptureActive = () => micCapture;

export const listenSessionWanted = () => listenSession;

function currentSessionType() {
  try {
    const session = typeof navigator !== "undefined" ? navigator.audioSession : null;
    return session ? String(session.type || "") : "";
  } catch {
    return "";
  }
}

function recordSession(entry) {
  sessionHistory.push({ at: new Date().toISOString(), ...entry });
  if (sessionHistory.length > SESSION_HISTORY) sessionHistory.splice(0, sessionHistory.length - SESSION_HISTORY);
}

function utteranceActive() {
  return speaking || held.length > 0;
}

export function setAudioSessionType(wanted, reason = "", { force = false } = {}) {
  const session = typeof navigator !== "undefined" ? navigator.audioSession : null;
  if (!session) {
    recordSession({ type: "", wanted, reason, supported: false });
    return { supported: false, type: "", wanted };
  }
  if (!force && utteranceActive()) {
    recordSession({ type: currentSessionType(), wanted, reason, skipped: "utterance" });
    return { supported: true, type: currentSessionType(), wanted, skipped: "utterance" };
  }
  const previous = currentSessionType();
  if (previous === wanted) return { supported: true, type: previous, wanted };
  try {
    session.type = wanted;
    recordSession({ type: currentSessionType(), previous, wanted, reason });
    return { supported: true, type: currentSessionType(), wanted };
  } catch (error) {
    if (wanted === "play-and-record") {
      try {
        session.type = "auto";
        recordSession({ type: currentSessionType(), previous, wanted, reason, fallback: "auto", error: String(error?.message || error) });
        return { supported: true, type: currentSessionType(), wanted, fallback: "auto", error: String(error?.message || error) };
      } catch (error2) {
        recordSession({ type: currentSessionType(), previous, wanted, reason, error: String(error2?.message || error2) });
        return { supported: true, type: currentSessionType(), wanted, error: String(error2?.message || error2) };
      }
    }
    recordSession({ type: currentSessionType(), previous, wanted, reason, error: String(error?.message || error) });
    return { supported: true, type: currentSessionType(), wanted, error: String(error?.message || error) };
  }
}

export function applyAudioSession(reason = "", options = {}) {
  return setAudioSessionType(listenSession ? "play-and-record" : "playback", reason, options);
}

export function setListenSession(on, reason = "listen") {
  listenSession = Boolean(on);
  return applyAudioSession(reason);
}

export function prepareListenSession(reason = "tap") {
  return applyAudioSession(reason, { force: true });
}

function langMatches(voice, language) {
  const prefix = String(language || "").slice(0, 2).toLowerCase();
  return Boolean(prefix && String(voice?.lang || "").toLowerCase().startsWith(prefix));
}

function pickVoice(language) {
  const voices = speechSynthesis.getVoices();
  const chosen = faceVoiceSettings().voiceName;
  const named = chosen && voices.find((voice) => voice.name === chosen);
  if (named && langMatches(named, language)) return named;
  const prefix = String(language || "").slice(0, 2).toLowerCase();
  return voices.find((voice) => voice.lang?.toLowerCase().startsWith(prefix) && voice.localService) || voices.find((voice) => voice.lang?.toLowerCase().startsWith(prefix)) || null;
}

export function displayMode() {
  try {
    if (typeof navigator !== "undefined" && navigator.standalone) return "standalone";
    if (window.matchMedia("(display-mode: standalone)").matches) return "standalone";
    if (window.matchMedia("(display-mode: fullscreen)").matches) return "fullscreen";
    if (window.matchMedia("(display-mode: minimal-ui)").matches) return "minimal-ui";
  } catch {}
  return "browser";
}

export function snapshotSynthesis() {
  try {
    return { speaking: Boolean(speechSynthesis.speaking), pending: Boolean(speechSynthesis.pending), paused: Boolean(speechSynthesis.paused) };
  } catch {
    return { speaking: false, pending: false, paused: false };
  }
}

function audioContextState() {
  return audioContext ? String(audioContext.state || "unknown") : "none";
}

function audioSessionInfo() {
  const session = typeof navigator !== "undefined" ? navigator.audioSession : null;
  if (!session) return { supported: false, type: "", micCapture, history: sessionHistory.slice() };
  return { supported: true, type: currentSessionType(), micCapture, history: sessionHistory.slice() };
}

function prepareAudioSession() {
  applyAudioSession("speak");
}

function hold(utterance) {
  held.push(utterance);
}

function release(utterance) {
  held = held.filter((item) => item !== utterance);
}

function startKeepAlive() {
  clearInterval(keepAlive);
  keepAlive = setInterval(() => {
    try { if (speechSynthesis.paused || speaking || draining) speechSynthesis.resume(); } catch {}
  }, KEEP_ALIVE_MS);
}

function stopKeepAlive() {
  clearInterval(keepAlive);
  keepAlive = null;
}

function systemSay(sentence, language, run) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window) || run !== generation) { resolve(); return; }
    currentSentence = sentence;
    currentLanguage = language;
    const t0 = performance.now();
    try { speechSynthesis.cancel(); } catch {}
    try { speechSynthesis.resume(); } catch {}
    prepareAudioSession();
    let startTimer = 0;
    let settled = false;
    const utterance = new SpeechSynthesisUtterance(sentence);
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(startTimer);
      release(utterance);
      if (!held.length) stopKeepAlive();
      if (lastUtterance) {
        lastUtterance.synthesis = snapshotSynthesis();
        lastUtterance.audioContext = audioContextState();
        lastUtterance.audioSession = audioSessionInfo();
      }
      resolve();
    };
    try {
      const voice = pickVoice(language);
      const lang = voice?.lang || localeFor(language);
      utterance.lang = lang;
      utterance.volume = 1;
      utterance.rate = appleWebKit() ? 1 : faceVoiceSettings().speechRate;
      utterance.pitch = appleWebKit() ? 1 : faceVoiceSettings().speechPitch;
      let assigned = false;
      if (voice) {
        try { utterance.voice = voice; assigned = true; } catch {}
      }
      lastVoice = assigned ? voice.name : "system default";
      lastUtterance = {
        text: String(sentence).slice(0, 80),
        voice: { name: assigned ? voice.name : "", lang, localService: assigned ? Boolean(voice.localService) : false },
        started: false,
        ended: false,
        error: "",
        startMs: null,
        endMs: null,
        errorMs: null,
        synthesis: snapshotSynthesis(),
        audioContext: audioContextState(),
        displayMode: displayMode(),
        audioSession: audioSessionInfo(),
        iframe: inIframe(),
        at: new Date().toISOString()
      };
      const trace = lastUtterance;
      utterance.onstart = () => {
        if (trace.started) return;
        trace.started = true;
        trace.startMs = Math.round(performance.now() - t0);
        trace.synthesis = snapshotSynthesis();
        if (run === generation) setSpeaking(true);
        emitActivity("mouth", {});
        notifyStart();
      };
      utterance.onboundary = () => emitActivity("mouth", {});
      utterance.onend = () => {
        trace.ended = true;
        trace.endMs = Math.round(performance.now() - t0);
        trace.synthesis = snapshotSynthesis();
        const duration = trace.started ? (trace.endMs - (trace.startMs || 0)) : trace.endMs;
        const instant = !trace.started || duration <= INSTANT_END_MS;
        if (run === generation && !trace.error && instant) {
          const syn = snapshotSynthesis();
          noticeVoice("The system voice ended immediately (" + duration + " ms). speaking=" + syn.speaking + " pending=" + syn.pending + " paused=" + syn.paused + ".");
        }
        if (run === generation) setSpeaking(false);
        finish();
      };
      utterance.onerror = (event) => {
        const error = String(event?.error || "unknown");
        trace.error = error;
        trace.errorMs = Math.round(performance.now() - t0);
        trace.synthesis = snapshotSynthesis();
        if (run === generation && !/interrupted|canceled/.test(error)) noticeVoice("The system voice failed: " + error + ".");
        if (run === generation) setSpeaking(false);
        finish();
      };
      hold(utterance);
      startKeepAlive();
      startTimer = setTimeout(() => {
        if (settled || trace.started) return;
        const syn = snapshotSynthesis();
        noticeVoice("The system voice did not start (" + (START_TIMEOUT_MS / 1000).toFixed(1) + " s). speaking=" + syn.speaking + " pending=" + syn.pending + " paused=" + syn.paused + ".");
        try { speechSynthesis.cancel(); } catch {}
        if (run === generation) setSpeaking(false);
        finish();
      }, START_TIMEOUT_MS);
      if (run !== generation) { finish(); return; }
      speechSynthesis.speak(utterance);
    } catch (error) {
      noticeVoice("The system voice failed: " + (error?.message || "unknown") + ".");
      if (run === generation) setSpeaking(false);
      finish();
    }
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
  lastVoice = "Piper " + voiceId;
  const wav = await session.predict(sentence);
  speechStats.neural ||= { voiceId, firstMs: Math.round(performance.now() - started), downloadBytes: downloaded };
  if (run !== generation) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (Ctx) audioContext ||= new Ctx();
  if (audioContext?.state === "suspended") await audioContext.resume().catch(() => {});
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
    source.onended = () => { clearInterval(levelTimer); emitActivity("mouth", { level: -1 }); setSpeaking(false); resolve(); };
    currentSource = source;
    setSpeaking(true);
    source.start();
  });
}

async function drain(run) {
  draining = true;
  try {
    while (queue.length && run === generation) {
      const { sentence, language } = queue.shift();
      if (faceVoiceSettings().neuralVoice && !appleWebKit()) {
        try { await neuralSay(sentence, language, run); continue; }
        catch (error) { speechStats.neural = { error: String(error?.message || error).slice(0, 200) }; noticeVoice("The neural voice could not load. Using the system voice."); }
      }
      await systemSay(sentence, language, run);
    }
  } finally {
    if (run === generation) {
      draining = false;
      if (!held.length) setSpeaking(false);
      notifyIdle();
    }
  }
}

export function speak(text, { final = true } = {}) {
  const { sentences, skipped } = speakable(text);
  const language = detectLanguage(text);
  if (skipped && final) sentences.push(DETAILS[language] || DETAILS.en);
  if (!sentences.length) return false;
  const idle = !draining;
  micRetryUsed = false;
  queue.push(...sentences.map((sentence) => ({ sentence, language })));
  if (idle) drain(generation);
  return true;
}

export function speakNow(text) {
  gestured = true;
  pending = [];
  stopSpeaking();
  return speak(text, { final: false });
}

export function stopSpeaking() {
  generation += 1;
  queue = [];
  draining = false;
  try { speechSynthesis.cancel(); } catch {}
  try { currentSource?.stop(); } catch {}
  clearInterval(levelTimer);
  stopKeepAlive();
  held = [];
  setSpeaking(false);
  notifyIdle();
}

export function unlockSpeech() {
  if (!appleWebKit()) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) {
        audioContext ||= new Ctx();
        const resume = audioContext.resume();
        if (resume && typeof resume.catch === "function") resume.catch(() => {});
      }
    } catch {}
  }
  try {
    if (!("speechSynthesis" in window)) return;
    try { if (speechSynthesis.paused) speechSynthesis.resume(); } catch {}
  } catch {}
}

export function systemVoices() {
  try { return speechSynthesis.getVoices().map((voice) => ({ name: voice.name, lang: voice.lang, localService: Boolean(voice.localService) })); } catch { return []; }
}

export const speechUnlocked = () => gestured;

export function queueUntilGesture(text, interrupt = false) {
  if (interrupt) pending = [];
  pending.push(String(text));
  if (pending.length > MAX_PENDING) pending.splice(0, pending.length - MAX_PENDING);
  return pending.length;
}

const GESTURE_EVENTS = ["pointerdown", "pointerup", "touchstart", "touchend", "mousedown", "click", "keydown"];
const PARENT_EVENTS = ["pointerdown", "pointerup", "touchstart", "touchend", "mousedown", "click"];
const gestureBindings = [];

function addGesture(target, type, handler) {
  if (!target?.addEventListener) return;
  target.addEventListener(type, handler, { capture: true, passive: true });
  gestureBindings.push([target, type, handler]);
}

function onUserGesture() {
  const items = pending.slice();
  if (!items.length && gestured) return;
  try { window.focus(); } catch {}
  try { if (listenSession) prepareListenSession("tap"); } catch {}
  unlockSpeech();
  gestured = true;
  if (!items.length) {
    notifyIdle();
    return;
  }
  pending = [];
  for (const text of items) speak(text, { final: false });
}

function bindSpeechGestures() {
  for (const type of GESTURE_EVENTS) {
    addGesture(window, type, onUserGesture);
    addGesture(document, type, onUserGesture);
    addGesture(document.documentElement, type, onUserGesture);
    addGesture(document.body, type, onUserGesture);
  }
  try {
    if (window.parent && window.parent !== window) {
      const parent = window.parent;
      for (const type of PARENT_EVENTS) {
        addGesture(parent, type, onUserGesture);
        addGesture(parent.document, type, onUserGesture);
        addGesture(parent.document.documentElement, type, onUserGesture);
        addGesture(parent.document.body, type, onUserGesture);
        addGesture(window.frameElement, type, onUserGesture);
      }
    }
  } catch {}
  if (typeof document !== "undefined" && !document.body && document.addEventListener) {
    document.addEventListener("DOMContentLoaded", () => {
      for (const type of GESTURE_EVENTS) addGesture(document.body, type, onUserGesture);
    }, { once: true });
  }
}

bindSpeechGestures();

export function speechStatus() {
  return {
    speaking,
    queued: pending.length + queue.length,
    waitingForTap: pending.length,
    voice: lastVoice || (faceVoiceSettings().neuralVoice && !appleWebKit() ? "Piper" : faceVoiceSettings().voiceName || "automatic"),
    neural: faceVoiceSettings().neuralVoice,
    lastError,
    utterance: lastUtterance,
    synthesis: snapshotSynthesis(),
    audioContext: audioContextState(),
    displayMode: displayMode(),
    audioSession: audioSessionInfo(),
    micCapture,
    iframe: inIframe()
  };
}

export function clearPendingSpeech() {
  pending = [];
}

export function hasAudioContext() {
  return Boolean(audioContext);
}

registerComponent("speech", {
  keys: new Set(["voiceName", "neuralVoice", "speechRate", "speechPitch"]),
  status: () => speechStatus(),
  config: () => {
    const current = faceVoiceSettings();
    return { voiceName: current.voiceName, neuralVoice: current.neuralVoice, speechRate: current.speechRate, speechPitch: current.speechPitch };
  },
  configure(patch) {
    for (const [key, value] of Object.entries(patch)) {
      if (!setFaceVoiceSetting(key, value)) throw new Error("Could not set " + key);
    }
    const current = faceVoiceSettings();
    return { ok: true, name: "speech", config: { voiceName: current.voiceName, neuralVoice: current.neuralVoice, speechRate: current.speechRate, speechPitch: current.speechPitch } };
  },
  reload() {
    try { speechSynthesis.cancel(); } catch {}
    return { ok: true, name: "speech", status: speechStatus() };
  }
});

