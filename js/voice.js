import { emitActivity, faceVoiceSettings, setFaceVoiceSetting, TRANSCRIBERS } from "./face-config.js";
import { afterSpeechStarts, isSpeaking, onSpeechIdle, onSpeakingChange, onUtteranceStart, restartCurrentUtterance, setMicCapture, speechBusy, stopSpeaking, unlockSpeech } from "./speech.js";
import { ecoName } from "./identity.js";
import { deviceCapabilities, listenOn, microphoneGranted, rememberMicrophoneGrant, refreshCapabilities } from "./capabilities.js";
import { consumeMagicTranscript } from "./magic.js";
import { byId } from "./ui.js";
import { requestHelp } from "./help.js";
import { distance, isTruncation, normalize, phonetic } from "./voice-match.js";

const ORT_URL = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.js";
const VAD_BASE = "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/";
const ORT_BASE = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/";
const ORDINALS = [
  ["first", "primera", "primero", "primer", "primeira", "premier", "première"],
  ["second", "segunda", "segundo", "deuxième", "seconde"],
  ["third", "tercera", "tercero", "terceira", "troisième"],
  ["fourth", "cuarta", "cuarto", "quarta", "quatrième"],
  ["fifth", "quinta", "quinto", "cinquième"],
  ["sixth", "sexta", "sexto"],
  ["seventh", "séptima", "séptimo"],
  ["eighth", "octava", "octavo"],
  ["ninth", "novena", "noveno"]
].map((words) => words.map(normalize));
const CARDINALS = [
  ["1", "one", "uno", "una", "um", "un"],
  ["2", "two", "dos", "dois", "deux"],
  ["3", "three", "tres", "tres", "trois"],
  ["4", "four", "cuatro", "quatro", "quatre"],
  ["5", "five", "cinco", "cinq"],
  ["6", "six", "seis"],
  ["7", "seven", "siete", "sete", "sept"],
  ["8", "eight", "ocho", "oito", "huit"],
  ["9", "nine", "nueve", "nove", "neuf"]
];
const HALLUCINATION = /^\s*[[(].*[\])]\s*$/;
const MAX_TRANSCRIPTIONS = 20;
const STATUS_TRANSCRIPTIONS = 5;

export { normalize } from "./voice-match.js";

export function wakeNames() {
  const names = new Set();
  const wake = normalize(ecoName());
  if (wake) names.add(wake);
  if (!names.size) names.add("eco");
  return [...names].filter(Boolean);
}

export function findAlias(text, names = wakeNames(), tolerance = faceVoiceSettings().aliasTolerance) {
  const original = String(text || "");
  const words = [...original.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)];
  const plain = words.map((match) => phonetic(normalize(match[0])));
  for (const name of names) {
    const parts = name.split(" ").map(phonetic);
    for (let index = 0; index + parts.length <= plain.length; index++) {
      const candidate = plain.slice(index, index + parts.length).join(" ");
      const target = parts.join(" ");
      if (distance(candidate, target) <= Math.floor(target.length * tolerance) && !isTruncation(candidate.replace(/ /g, ""), target.replace(/ /g, ""))) {
        const last = words[index + parts.length - 1];
        const after = original.slice(last.index + last[0].length).replace(/^[\s,.:;!?¡¿-]+/, "").trim();
        return { index, after };
      }
    }
  }
  return null;
}

export function clarifyChoice(text, options, tolerance = faceVoiceSettings().aliasTolerance) {
  const value = normalize(text);
  const words = value.split(" ");
  for (const list of [ORDINALS, CARDINALS]) for (let index = 0; index < Math.min(options.length, list.length); index++) if (list[index].some((word) => words.includes(word))) return index;
  if (/\b(last|ultima|ultimo)\b/.test(value) && options.length) return options.length - 1;
  let best = -1;
  let bestScore = Infinity;
  options.forEach((option, index) => {
    const target = normalize(option);
    if (!target) return;
    if (value.includes(target) || target.includes(value) && value.length >= 3) { if (bestScore > 0) { best = index; bestScore = 0; } return; }
    const score = distance(value, target) / Math.max(target.length, 1);
    if (score < bestScore) { best = index; bestScore = score; }
  });
  return bestScore <= Math.max(tolerance, 0.2) ? best : -1;
}

function script(url, test) {
  if (test()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const node = document.createElement("script");
    node.src = url;
    node.crossOrigin = "anonymous";
    node.onload = () => resolve();
    node.onerror = () => reject(new Error("Voice detection could not load."));
    document.head.append(node);
  });
}

export function createVoice({ sendVoice, faceActive }) {
  const button = byId("micButton");
  const notice = byId("voiceNotice");
  const noticeText = byId("voiceNoticeText");
  const closeNotice = byId("voiceNoticeClose");
  let lastError = null;
  let transcriberLoaded = false;
  const stats = { vad: null, transcriber: null, transcriptions: [] };
  let enabled = false;
  let vad = null;
  let worker = null;
  let workerReady = null;
  let requestId = 0;
  const waiting = new Map();
  let phase = "attentive";
  let buffer = "";
  let turnTimer = null;
  let segmentTimer = null;
  let followUntil = 0;
  let lastVoiceAt = 0;
  let lastAliasAt = 0;
  let speechStartedAt = 0;
  let housekeeping = null;
  let pendingTranscriptions = 0;
  let restarting = false;
  let starting = null;
  let sharedStream = null;
  let pendingListen = false;
  let followFor = null;
  let listeningGestures = false;
  let bargePending = false;
  let speechBeganAt = 0;
  let listenAfterStart = false;

  const settings = () => faceVoiceSettings();

  function followWindow() {
    const value = followFor;
    followFor = null;
    const seconds = Number.isFinite(value) ? value : settings().followUpSeconds;
    return Math.max(0, seconds) * 1000;
  }

  function armFollowUp(seconds) {
    const value = Number(seconds);
    const windowSec = Number.isFinite(value) ? value : settings().followUpSeconds;
    if (isSpeaking() || speechBusy()) followFor = windowSec;
    else {
      followFor = null;
      followUntil = Date.now() + Math.max(0, windowSec) * 1000;
    }
  }

  function needsGesture(error) {
    const text = String(error?.name || "") + " " + String(error?.message || error || "");
    return /NotAllowed|NotAllowedError|SecurityError|gesture|user activation|notallowed/i.test(text);
  }

  async function acquireStream() {
    if (sharedStream && sharedStream.getTracks().some((track) => track.readyState === "live")) return sharedStream;
    sharedStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    rememberMicrophoneGrant(true);
    setMicCapture(true);
    return sharedStream;
  }

  function releaseStream() {
    if (sharedStream) {
      for (const track of sharedStream.getTracks()) try { track.stop(); } catch {}
      sharedStream = null;
    }
    setMicCapture(false);
  }

  function bindListenGesture() {
    if (listeningGestures) return;
    listeningGestures = true;
    const onGesture = () => {
      unlockSpeech();
      if (!pendingListen || listenAfterStart) return;
      listenAfterStart = true;
      afterSpeechStarts(() => {
        listenAfterStart = false;
        if (!pendingListen) return;
        start({ auto: true }).catch(() => {});
      });
    };
    for (const type of ["pointerdown", "keydown", "touchend"]) window.addEventListener(type, onGesture, true);
  }

  function queueListen() {
    pendingListen = true;
    bindListenGesture();
  }

  function say(text) {
    if (text) lastError = { message: text, at: new Date().toISOString() };
    noticeText.textContent = text;
    notice.hidden = !text;
    if (text) requestHelp(text);
  }

  function recover() {
    if (!notice.hidden) say("");
  }

  closeNotice.onclick = () => say("");

  function updateButton() {
    button.setAttribute("aria-pressed", String(enabled));
    button.dataset.phase = enabled ? phase : "off";
    button.setAttribute("aria-label", !enabled ? "Start listening" : phase === "turn" ? "Stop listening" : "Talk to " + ecoName());
    emitActivity("attentive", { on: enabled && phase !== "turn" });
    emitActivity("listening", { on: enabled && phase === "turn" });
  }

  function showText(text, final = false) {
    if (faceActive()) emitActivity("subtitle", { text, final });
    else { byId("prompt").value = text; byId("prompt").dispatchEvent(new Event("input")); }
  }

  function bindWorker() {
    worker = new Worker(new URL("./voice-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (event) => {
      const data = event.data || {};
      const entry = waiting.get(data.id);
      if (!entry) return;
      waiting.delete(data.id);
      if (data.type === "error") entry.reject(new Error(data.error)); else entry.resolve(data);
    };
    worker.onerror = () => { for (const entry of waiting.values()) entry.reject(new Error("Transcriber stopped")); waiting.clear(); };
  }

  function ensureWorker() {
    lastVoiceAt = Date.now();
    if (workerReady) return workerReady;
    workerReady = startWorker();
    return workerReady;
  }

  async function startWorker(device) {
    bindWorker();
    const model = TRANSCRIBERS[settings().transcriber];
    try {
      const info = await request({ type: "load", model, device });
      stats.transcriber = { model, ...info };
      transcriberLoaded = true;
      recover();
      return info;
    } catch (error) {
      unloadWorker(true);
      if (device !== "wasm") {
        workerReady = startWorker("wasm");
        return workerReady;
      }
      workerReady = null;
      say("The voice transcriber could not load. Check the connection.");
      throw error;
    }
  }

  function request(message) {
    const id = ++requestId;
    return new Promise((resolve, reject) => { waiting.set(id, { resolve, reject }); worker.postMessage({ ...message, id }, message.audio ? [message.audio.buffer] : []); });
  }

  function unloadWorker(keepReady = false) {
    worker?.terminate();
    worker = null;
    transcriberLoaded = false;
    for (const entry of waiting.values()) entry.reject(new Error("Transcriber unloaded"));
    waiting.clear();
    if (!keepReady) workerReady = null;
  }

  async function transcribe(audio) {
    pendingTranscriptions += 1;
    const started = performance.now();
    const seconds = Math.round(audio.length / 1600) / 10;
    try {
      await ensureWorker();
      const chosen = settings().speechLanguage;
      const language = chosen && chosen !== "auto" ? chosen : (navigator.language || "").slice(0, 2).toLowerCase();
      const result = await request({ type: "transcribe", audio, language, model: TRANSCRIBERS[settings().transcriber] });
      stats.transcriptions.push({ ms: Math.round(performance.now() - started), seconds, text: result.text, at: new Date().toISOString() });
      if (stats.transcriptions.length > MAX_TRANSCRIPTIONS) stats.transcriptions.splice(0, stats.transcriptions.length - MAX_TRANSCRIPTIONS);
      recover();
      return HALLUCINATION.test(result.text) ? "" : result.text;
    } finally {
      pendingTranscriptions -= 1;
      lastVoiceAt = Date.now();
    }
  }

  function clarifyOpen() { return byId("clarify").open; }

  function answerClarify(text) {
    const buttons = [...byId("clarifyOptions").querySelectorAll("button")];
    if (!buttons.length) {
      byId("clarifyText").value = text;
      byId("clarifyForm").requestSubmit();
      return true;
    }
    const index = clarifyChoice(text, buttons.map((item) => item.textContent));
    if (index >= 0) { buttons[index].click(); return true; }
    byId("clarifyText").value = text;
    return false;
  }

  function scheduleTurnEnd(wait) {
    clearTimeout(turnTimer);
    turnTimer = setTimeout(finishTurn, wait);
  }

  function finishTurn() {
    if (pendingTranscriptions > 0) { scheduleTurnEnd(150); return; }
    const text = buffer.trim();
    buffer = "";
    phase = "attentive";
    updateButton();
    if (!text) { showText("", true); return; }
    showText(text, true);
    if (!faceActive()) { byId("prompt").value = ""; byId("prompt").dispatchEvent(new Event("input")); }
    sendVoice(text);
  }

  function beginTurn(initial = "") {
    if (isSpeaking()) stopSpeaking();
    phase = "turn";
    buffer = initial;
    lastAliasAt = Date.now();
    updateButton();
    if (initial) showText(initial);
    const values = settings();
    scheduleTurnEnd(initial ? Math.max(0, values.turnSilenceSeconds - values.phraseSilenceSeconds) * 1000 : Math.max(values.followUpSeconds, values.turnSilenceSeconds) * 1000);
  }

  async function phrase(audio, startedAt) {
    let text = "";
    try { text = await transcribe(audio); } catch { if (workerReady) say("The voice transcription failed. Try again."); return; }
    if (!enabled || !text) return;
    const values = settings();
    if (clarifyOpen()) { answerClarify(text); return; }
    if (await consumeMagicTranscript(text)) return;
    if (phase === "turn") {
      buffer = (buffer + " " + text).trim();
      showText(buffer);
      scheduleTurnEnd(Math.max(0, values.turnSilenceSeconds - values.phraseSilenceSeconds) * 1000);
      return;
    }
    const alias = findAlias(text);
    if (alias) { bargePending = false; beginTurn(alias.after); return; }
    if (bargePending) { bargePending = false; beginTurn(text); return; }
    if (!isSpeaking() && startedAt <= followUntil) beginTurn(text);
  }

  function options() {
    const values = settings();
    const positive = values.bargeIn && isSpeaking() ? Math.max(values.speechThreshold, values.bargeInThreshold) : values.speechThreshold;
    return {
      positiveSpeechThreshold: positive,
      negativeSpeechThreshold: Math.max(0.05, positive - 0.15),
      redemptionMs: values.phraseSilenceSeconds * 1000,
      minSpeechMs: values.minSpeechMs,
      preSpeechPadMs: values.preSpeechPadMs
    };
  }

  async function createVad() {
    const started = performance.now();
    await script(ORT_URL, () => window.ort);
    await script(VAD_BASE + "bundle.min.js", () => window.vad);
    window.ort.env.wasm.wasmPaths = ORT_BASE;
    const instance = await window.vad.MicVAD.new({
      ...options(),
      model: "v5",
      baseAssetPath: VAD_BASE,
      onnxWASMBasePath: ORT_BASE,
      submitUserSpeechOnPause: true,
      startOnLoad: false,
      getStream: () => acquireStream(),
      onSpeechStart: () => {
        speechStartedAt = Date.now();
        lastVoiceAt = speechStartedAt;
        clearTimeout(turnTimer);
        ensureWorker().catch(() => {});
        clearTimeout(segmentTimer);
        segmentTimer = setTimeout(cutSegment, settings().maxSegmentSeconds * 1000);
        const values = settings();
        if (values.bargeIn && isSpeaking() && (speechBeganAt === 0 || speechStartedAt - speechBeganAt >= 300)) {
          bargePending = true;
          stopSpeaking();
        }
      },
      onSpeechEnd: (audio) => {
        clearTimeout(segmentTimer);
        lastVoiceAt = Date.now();
        phrase(audio, speechStartedAt);
      },
      onVADMisfire: () => {
        clearTimeout(segmentTimer);
        if (bargePending) bargePending = false;
        if (phase === "turn") scheduleTurnEnd(Math.max(0, settings().turnSilenceSeconds - settings().phraseSilenceSeconds) * 1000);
      }
    });
    stats.vad = { loadMs: Math.round(performance.now() - started) };
    return instance;
  }

  async function cutSegment() {
    if (!vad || restarting) return;
    restarting = true;
    try { await vad.pause(); if (enabled && !document.hidden) await vad.start(); } finally { restarting = false; }
  }

  async function start({ auto = false } = {}) {
    if (enabled) return true;
    if (starting) return starting;
    unlockSpeech();
    if (!deviceCapabilities().checked) await refreshCapabilities();
    if (!listenOn()) return false;
    if (!navigator.mediaDevices?.getUserMedia) { say("This browser can't use the microphone."); return false; }
    const granted = await microphoneGranted();
    if (!granted && auto && !navigator.userActivation?.isActive) {
      queueListen();
      return false;
    }
    starting = (async () => {
      try {
        await acquireStream();
        const retried = await restartCurrentUtterance();
        if (retried.retried && lastError && retried.ok) recover();
        vad ||= await createVad();
        await vad.start();
        if (vad.errored) throw new Error(vad.errored);
      } catch (error) {
        const denied = /denied|NotAllowed|Permission/i.test(String(error?.name || "") + String(error?.message || error));
        const stillGranted = await microphoneGranted();
        if (stillGranted && (denied || needsGesture(error))) {
          queueListen();
          try { await vad?.destroy(); } catch {}
          vad = null;
          return false;
        }
        if (denied && !stillGranted) say("Microphone access is blocked. Allow it in the browser to talk to Eco.");
        else say("Listening could not start: " + (error?.name ? error.name + ": " : "") + (error?.message || error || "unknown") + ".");
        try { await vad?.destroy(); } catch {}
        vad = null;
        if (!sharedStream?.getTracks().some((track) => track.readyState === "live")) releaseStream();
        return false;
      }
      enabled = true;
      pendingListen = false;
      phase = "attentive";
      setMicCapture(true);
      recover();
      lastAliasAt = Date.now();
      clearInterval(housekeeping);
      housekeeping = setInterval(tick, 1000);
      updateButton();
      return true;
    })().finally(() => { starting = null; });
    return starting;
  }

  async function autoStart() {
    if (enabled || starting || pendingListen) return enabled;
    if (!settings().listen) return false;
    if (!deviceCapabilities().checked) await refreshCapabilities();
    if (!listenOn()) return false;
    if (!await microphoneGranted()) return false;
    const ok = await start({ auto: true });
    if (!ok && !enabled && listenOn()) queueListen();
    return ok;
  }

  async function requestListen({ followUp } = {}) {
    if (!deviceCapabilities().listen && !(await refreshCapabilities(), deviceCapabilities().listen)) {
      return { ok: false, status: "unsupported", error: "This device has no microphone Eco can use." };
    }
    if (!settings().listen) setFaceVoiceSetting("listen", true);
    const used = followUp !== undefined ? followUp : settings().followUpSeconds;
    armFollowUp(used);
    if (enabled) return { ok: true, status: "listening", active: true, waitingForTap: false, follow_up: used };
    const granted = await microphoneGranted();
    const hasGesture = Boolean(navigator.userActivation?.isActive);
    const canTry = granted || hasGesture;
    if (canTry) {
      const ok = await start({ auto: !hasGesture });
      if (ok) return { ok: true, status: "listening", active: true, waitingForTap: false, follow_up: used };
      if (pendingListen) return { ok: true, status: "queued", waitingForTap: true, queued: 1, message: "Queued until first tap", follow_up: used };
      return { ok: false, status: "error", error: lastError?.message || "Listening could not start.", waitingForTap: false };
    }
    queueListen();
    return { ok: true, status: "queued", waitingForTap: true, queued: 1, message: "Queued until first tap", follow_up: used };
  }

  async function stop(sleep = false) {
    enabled = false;
    phase = "attentive";
    setMicCapture(false);
    buffer = "";
    clearTimeout(turnTimer);
    clearTimeout(segmentTimer);
    clearInterval(housekeeping);
    try { await vad?.destroy(); } catch {}
    vad = null;
    releaseStream();
    pendingListen = false;
    unloadWorker();
    updateButton();
    showText("", true);
    if (sleep) emitActivity("sleep");
  }

  function tick() {
    const values = settings();
    const now = Date.now();
    if (worker && !pendingTranscriptions && now - lastVoiceAt > values.unloadSeconds * 1000) unloadWorker();
    if (phase !== "turn" && !isSpeaking() && now - lastAliasAt > values.autoOffMinutes * 60000) stop(true);
  }

  onUtteranceStart(() => { speechBeganAt = Date.now(); try { vad?.setOptions(options()); } catch {} });
  onSpeakingChange((value) => {
    try { vad?.setOptions(options()); } catch {}
    if (value) return;
    followUntil = Date.now() + followWindow();
    lastAliasAt = Date.now();
  });
  onSpeechIdle(() => {
    if (followFor == null) return;
    followUntil = Date.now() + followWindow();
    lastAliasAt = Date.now();
  });

  document.addEventListener("visibilitychange", () => {
    if (!enabled || !vad) return;
    if (document.hidden) { setMicCapture(false); vad.pause().catch(() => {}); } else { vad.start().catch(() => {}); setMicCapture(true); }
  });
  window.addEventListener("eco-voice-notice", (event) => say(String(event.detail || "")));
  window.addEventListener("eco-face-voice-settings", () => { try { vad?.setOptions(options()); } catch {} });

  button.onclick = async () => {
    unlockSpeech();
    if (!enabled) { if (await start()) beginTurn(); return; }
    if (phase === "turn" && !buffer) { stop(); return; }
    beginTurn(buffer);
  };

  return {
    start,
    stop,
    autoStart,
    requestListen,
    armFollowUp,
    get enabled() { return enabled; },
    get phase() { return phase; },
    get pendingListen() { return pendingListen; },
    stats,
    status: () => ({
      enabled,
      phase: enabled ? phase : "off",
      vadLoaded: Boolean(vad),
      transcriberLoaded,
      waitingForTap: pendingListen,
      transcriberModel: TRANSCRIBERS[settings().transcriber],
      name: ecoName(),
      wakeWords: wakeNames(),
      recentTranscriptions: stats.transcriptions.slice(-STATUS_TRANSCRIPTIONS).map((item) => ({ at: item.at || "", text: String(item.text || "").slice(0, 200), seconds: item.seconds, ms: item.ms })),
      lastError,
      notice: notice.hidden ? "" : noticeText.textContent
    }),
    debug: () => ({ enabled, phase, buffer, followUntil, worker: Boolean(worker), stats })
  };
}
