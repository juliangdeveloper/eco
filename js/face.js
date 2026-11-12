import { emitActivity, faceVoiceSettings } from "./face-config.js";
import { loadPack } from "./face-packs.js";
import { setting } from "./storage.js";
import { byId } from "./ui.js";

const IDLE_STATES = new Set(["idle", "sleepy", "asleep"]);
const VARIANTS = [["blink", "weightBlink"], ["look", "weightLook"], ["tilt", "weightTilt"], ["stretch", "weightStretch"], ["yawn", "weightYawn"]];
const JOB_ACTIVE = "ejecutando";
const LEAVE_MS = 700;
const FAMILIES = [
  ["memory", (name) => name === "memory" || name.startsWith("memoria_") || name === "conectar_memoria" || name === "session_search"],
  ["network", (name) => ["call_connector", "create_connector", "list_connectors", "request_sign_in", "probe_mcp", "replace_connector", "ip_publica_leer"].includes(name)],
  ["device", (name) => name.startsWith("dispositivo_") || ["herramientas_dispositivo_listar", "herramienta_dispositivo_gestionar", "documentacion_dispositivo_leer", "almacenamiento_local_leer", "entorno_descubrir", "python", "run_python"].includes(name)],
  ["planning", (name) => name === "todo_list" || name.startsWith("rutina_")],
  ["skills", (name) => ["skills_list", "skill_view", "skill_manage"].includes(name)],
  ["delegate", (name) => name.startsWith("subagente_")],
  ["system", (name) => ["eco_actualizar", "leer_resultado", "modo_cara"].includes(name)]
];

export function toolFamily(name) {
  const value = String(name || "");
  if (value === "clarify") return "asking";
  if (value === "memoria_rutinas") return "planning";
  return FAMILIES.find(([, test]) => test(value))?.[0] || "generic";
}

function hash(text) {
  let value = 2166136261;
  for (const char of String(text)) value = Math.imul(value ^ char.codePointAt(0), 16777619);
  return value >>> 0;
}

class Sprite {
  constructor(node, kind) {
    this.node = node;
    this.kind = kind;
    this.timer = null;
    this.name = "";
    this.frame = 0;
    this.manual = false;
  }

  manifest(pack) { return this.kind === "face" ? pack.face : pack.characters; }

  draw(pack, state, frame, scale) {
    const manifest = this.manifest(pack);
    const grid = manifest.grid;
    const size = pack.sizes[state.sheet] || [grid * state.frames, grid * ((state.row || 0) + 1)];
    this.node.style.width = this.node.style.height = grid * scale + "px";
    this.node.style.backgroundImage = 'url("' + pack.urls[state.sheet] + '")';
    this.node.style.backgroundSize = size[0] * scale + "px " + size[1] * scale + "px";
    this.node.style.backgroundPosition = -frame * grid * scale + "px " + -(state.row || 0) * grid * scale + "px";
  }

  play(pack, name, scale, onEnd) {
    clearTimeout(this.timer);
    const manifest = this.manifest(pack);
    const state = manifest.states[name] || manifest.states[name.split("_")[0]] || manifest.states.idle || manifest.states.waiting;
    this.name = name;
    this.state = state;
    this.frame = 0;
    this.manual = false;
    this.node.dataset.state = name;
    const step = () => {
      this.draw(pack, state, this.frame, scale);
      if (this.manual) return;
      const last = this.frame >= state.frames - 1;
      if (last && !state.loop) { this.timer = setTimeout(() => onEnd?.(name), 1000 / state.fps); return; }
      this.frame = last ? 0 : this.frame + 1;
      this.timer = setTimeout(step, 1000 / state.fps);
    };
    step();
    return state.frames / state.fps * 1000;
  }

  setFrame(pack, frame, scale) {
    if (!this.state) return;
    this.manual = true;
    clearTimeout(this.timer);
    this.frame = Math.max(0, Math.min(this.state.frames - 1, frame));
    this.draw(pack, this.state, this.frame, scale);
  }

  stop() { clearTimeout(this.timer); }
}

export function createFace({ getSession }) {
  const layer = byId("faceLayer");
  const sprite = new Sprite(byId("faceSprite"), "face");
  const crowd = byId("faceCharacters");
  const subtitle = byId("faceSubtitle");
  const flags = { alert: false, asking: false, tool: null, reaction: null, speaking: false, writingUntil: 0, listening: false, thinking: false, attentive: false, routineUntil: 0, magicUntil: 0 };
  const characters = new Map();
  const toolTokens = new Map();
  let pack = null;
  let active = false;
  let playing = "";
  let transient = "";
  let token = 0;
  let lastActivity = Date.now();
  let lastVariant = "";
  let variantTimer = null;
  let tickTimer = null;
  let mouthTimer = null;
  let mouth = { pulse: 0, level: -1, started: 0 };
  let subtitleTimer = null;

  const stage = layer.querySelector(".faceStage");
  const extend = byId("faceExtend");
  const settings = () => faceVoiceSettings();
  let layoutTok = 0;
  let edgeImage = null;
  let edgeUrl = "";
  const shield = (on) => {
    for (const node of document.querySelector(".app").children) if (node !== layer && node.tagName !== "DIALOG" && !node.classList.contains("header") && node.id !== "voiceNotice") node.inert = on;
  };
  const place = () => {
    const header = document.querySelector(".header");
    layer.style.setProperty("--face-top", header.offsetTop + header.offsetHeight + "px");
  };
  const pickScale = (raw, grid) => {
    raw = Math.max(1 / grid, raw);
    const integer = Math.floor(raw + 1e-9);
    if (integer >= 1 && (integer / raw >= 0.96 || (raw - integer) * grid <= 16)) return integer;
    return raw;
  };
  const metrics = () => {
    const area = stage.getBoundingClientRect();
    const width = Math.max(1, area.width);
    const height = Math.max(1, area.height);
    const faceGrid = pack?.face.grid || 48;
    const charGrid = pack?.characters.grid || 32;
    const user = (settings().faceScale || 100) / 100;
    const fit = Math.min(width, height) / faceGrid;
    const faceScale = Math.min(pickScale(fit, faceGrid), pickScale(fit * user, faceGrid));
    const faceSize = faceGrid * faceScale;
    const charTarget = Math.min(Math.max(faceSize / 5, charGrid), faceSize * 0.28, Math.min(width, height) * 0.22);
    const charScale = pickScale(charTarget / charGrid, charGrid);
    return { width, height, faceGrid, charGrid, faceScale, charScale, faceSize, charSize: charGrid * charScale };
  };
  const scale = (kind = "face") => (kind === "face" ? metrics().faceScale : metrics().charScale);
  const ensureEdgeImage = () => {
    const state = pack?.face.states.idle || Object.values(pack?.face.states || {})[0];
    const url = state && pack.urls[state.sheet];
    if (!url) return null;
    if (edgeUrl === url && edgeImage?.complete && edgeImage.naturalWidth) return edgeImage;
    const image = new Image();
    image.onload = () => requestLayout();
    image.src = url;
    edgeImage = image;
    edgeUrl = url;
    return image.complete && image.naturalWidth ? image : null;
  };
  const applyBackdrop = () => {
    layer.style.setProperty("--face-backdrop", pack?.backdropColor || "#1c1c1e");
    if (!pack?.backdropEdge) { extend.hidden = true; return; }
    const image = ensureEdgeImage();
    if (!image) { extend.hidden = true; return; }
    const { width, height, faceGrid, faceSize } = metrics();
    const state = pack.face.states.idle || Object.values(pack.face.states)[0];
    const srcY = (state.row || 0) * faceGrid;
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const canvasW = Math.max(1, Math.round(width * dpr));
    const canvasH = Math.max(1, Math.round(height * dpr));
    if (extend.width !== canvasW) extend.width = canvasW;
    if (extend.height !== canvasH) extend.height = canvasH;
    const ctx = extend.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, width, height);
    const cx = (width - faceSize) / 2;
    const cy = (height - faceSize) / 2;
    const unit = faceSize / faceGrid;
    const last = faceGrid - 1;
    const mid = faceGrid - 2;
    const midPx = faceSize - 2 * unit;
    const draw = (sx, sy, sw, sh, dx, dy, dw, dh) => {
      if (dw > 0 && dh > 0 && sw > 0 && sh > 0) ctx.drawImage(image, sx, srcY + sy, sw, sh, dx, dy, dw, dh);
    };
    draw(0, 0, 1, 1, 0, 0, cx + unit, cy + unit);
    draw(1, 0, mid, 1, cx + unit, 0, midPx, cy + unit);
    draw(last, 0, 1, 1, cx + faceSize - unit, 0, width - (cx + faceSize - unit), cy + unit);
    draw(0, 1, 1, mid, 0, cy + unit, cx + unit, midPx);
    draw(last, 1, 1, mid, cx + faceSize - unit, cy + unit, width - (cx + faceSize - unit), midPx);
    draw(0, last, 1, 1, 0, cy + faceSize - unit, cx + unit, height - (cy + faceSize - unit));
    draw(1, last, mid, 1, cx + unit, cy + faceSize - unit, midPx, height - (cy + faceSize - unit));
    draw(last, last, 1, 1, cx + faceSize - unit, cy + faceSize - unit, width - (cx + faceSize - unit), height - (cy + faceSize - unit));
    extend.hidden = false;
  };
  const redraw = () => {
    if (!pack) return;
    const faceScale = scale("face");
    const charScale = scale("characters");
    if (sprite.state) sprite.draw(pack, sprite.state, sprite.frame, faceScale);
    for (const item of characters.values()) {
      if (item.sprite.state) item.sprite.draw(pack, item.sprite.state, item.sprite.frame, charScale);
      drawAccessory(item);
    }
    layer.style.setProperty("--face-size", metrics().faceSize + "px");
  };
  const layout = () => {
    if (!active || !pack) return;
    place();
    applyBackdrop();
    redraw();
    placeCharacters();
  };
  const requestLayout = () => {
    if (!active) return;
    if (layoutTok) return;
    layoutTok = requestAnimationFrame(() => { layoutTok = 0; layout(); });
  };

  function idleState() {
    const values = settings();
    const quiet = Date.now() - lastActivity;
    if (quiet >= values.asleepMinutes * 60000) return "asleep";
    if (quiet >= values.sleepyMinutes * 60000) return "sleepy";
    return "idle";
  }

  function compute() {
    const now = Date.now();
    if (flags.alert) return "alert";
    if (flags.reaction?.type === "error" && now < flags.reaction.until) return "error";
    if (now < flags.magicUntil) return pack?.face.states.startle ? "startle" : "happy";
    if (flags.asking) return "asking";
    if (flags.tool) return "tool_" + flags.tool.family;
    if (flags.reaction?.type === "happy" && now < flags.reaction.until) return "happy";
    if (flags.speaking) return "speaking";
    if (now < flags.writingUntil) return "writing";
    if (flags.listening) return "listening";
    if (flags.thinking) return "thinking";
    if (flags.attentive) return "attentive";
    if (now < flags.routineUntil) return "routine";
    return idleState();
  }

  function scheduleVariant() {
    clearTimeout(variantTimer);
    const values = settings();
    const delay = (values.idleMinSeconds + Math.random() * (values.idleMaxSeconds - values.idleMinSeconds)) * 1000;
    variantTimer = setTimeout(playVariant, delay);
  }

  function pickVariant(state) {
    const values = settings();
    let choices = VARIANTS.filter(([name]) => name !== lastVariant).map(([name, key]) => [name, values[key]]);
    if (state === "sleepy") choices = [["yawn", 60], ["blink", 40]].filter(([name]) => name !== lastVariant);
    const total = choices.reduce((sum, [, weight]) => sum + weight, 0);
    if (total <= 0) return "";
    let roll = Math.random() * total;
    for (const [name, weight] of choices) { roll -= weight; if (roll < 0) return name; }
    return choices.at(-1)[0];
  }

  function playVariant() {
    if (!active) return;
    const base = compute();
    if (!["idle", "sleepy"].includes(base) || transient) { scheduleVariant(); return; }
    const name = pickVariant(base);
    if (!name) { scheduleVariant(); return; }
    lastVariant = name;
    transient = name;
    playing = name;
    sprite.play(pack, name, scale(), () => { transient = ""; render(true); scheduleVariant(); });
  }

  function startMouth() {
    clearInterval(mouthTimer);
    mouth = { pulse: 0, level: -1, started: Date.now() };
    mouthTimer = setInterval(() => {
      if (playing !== "speaking") return;
      const now = Date.now();
      if (mouth.level >= 0) { sprite.setFrame(pack, mouth.level > 0.18 ? 2 : mouth.level > 0.05 ? 1 : 0, scale()); return; }
      if (!mouth.pulse && now - mouth.started > 600) { if (sprite.manual) sprite.play(pack, "speaking", scale()); return; }
      if (!mouth.pulse) return;
      const age = now - mouth.pulse;
      sprite.setFrame(pack, age < 140 ? 2 : age < 260 ? 1 : 0, scale());
    }, 50);
  }

  function render(force = false) {
    if (!active || !pack) return;
    const target = compute();
    layer.dataset.state = target;
    if (transient && (IDLE_STATES.has(target) || target === "routine" && transient === "startle")) return;
    if (transient && !IDLE_STATES.has(target)) transient = "";
    if (!force && target === playing) return;
    playing = target;
    sprite.play(pack, target, scale(), () => render(true));
    if (target === "speaking") startMouth(); else clearInterval(mouthTimer);
    if (["idle", "sleepy"].includes(target)) scheduleVariant(); else clearTimeout(variantTimer);
  }

  function touch() {
    const sleeping = ["sleepy", "asleep"].includes(idleState());
    lastActivity = Date.now();
    if (active && sleeping && IDLE_STATES.has(playing)) {
      transient = "startle";
      playing = "startle";
      clearTimeout(variantTimer);
      sprite.play(pack, "startle", scale(), () => { transient = ""; render(true); });
    }
  }

  function slotPoint(index, size) {
    const { width, height, faceSize, charSize } = size;
    const gap = Math.max(8, Math.round(charSize * 0.12));
    const side = (width - faceSize) / 2;
    const vertical = (height - faceSize) / 2;
    const useSide = side >= charSize + gap;
    const useVert = vertical >= charSize + gap;
    let points;
    if (useVert && !useSide) {
      const rowY = faceSize / 2 + gap + charSize / 2;
      const spread = Math.min(faceSize * 0.36, width / 2 - charSize / 2 - 8);
      points = [
        { x: -spread, y: rowY }, { x: spread, y: rowY }, { x: 0, y: rowY },
        { x: -spread, y: -rowY }, { x: spread, y: -rowY }, { x: 0, y: -rowY }
      ];
    } else if (useSide && !useVert) {
      const colX = faceSize / 2 + gap + charSize / 2;
      const spread = Math.min(faceSize * 0.36, height / 2 - charSize / 2 - 8);
      points = [
        { x: -colX, y: 0 }, { x: colX, y: 0 }, { x: 0, y: Math.min(faceSize / 2 - gap - charSize / 2, height / 2 - charSize / 2 - 8) },
        { x: -colX, y: spread }, { x: colX, y: spread }, { x: -colX, y: -spread }
      ];
    } else if (useSide && useVert) {
      const colX = faceSize / 2 + gap + charSize / 2;
      const rowY = faceSize / 2 + gap + charSize / 2;
      points = [
        { x: -colX, y: 0 }, { x: colX, y: 0 }, { x: 0, y: rowY },
        { x: -colX, y: rowY }, { x: colX, y: rowY }, { x: 0, y: -rowY }
      ];
    } else {
      const x = faceSize / 2 - gap - charSize / 2;
      const y = faceSize / 2 - gap - charSize / 2;
      points = [
        { x: -x, y: y * 0.2 }, { x: x, y: y * 0.2 }, { x: 0, y: y },
        { x: -x, y: y }, { x: x, y: y }, { x: 0, y: -y }
      ];
    }
    const point = points[index];
    const maxX = Math.max(0, width / 2 - charSize / 2 - 4);
    const maxY = Math.max(0, height / 2 - charSize / 2 - 4);
    return { x: Math.max(-maxX, Math.min(maxX, point.x)), y: Math.max(-maxY, Math.min(maxY, point.y)) };
  }

  function placeCharacters() {
    const values = settings();
    const session = getSession?.();
    const running = (session?.subagents || []).filter((job) => job.status === JOB_ACTIVE);
    for (const job of running) if (!characters.has(job.id)) addCharacter(job.id);
    const ordered = [...characters.values()];
    const visible = ordered.filter((item) => item.leaving || ordered.filter((other) => !other.leaving).indexOf(item) < values.maxCharacters);
    const extra = ordered.filter((item) => !item.leaving).length - visible.filter((item) => !item.leaving).length;
    for (const item of ordered) item.node.hidden = !visible.includes(item);
    const size = metrics();
    visible.forEach((item, index) => {
      item.node.style.setProperty("--slot", String(index));
      item.node.dataset.slot = String(index % 6);
      const point = slotPoint(index % 6, size);
      item.node.style.setProperty("--dx", point.x + "px");
      item.node.style.setProperty("--dy", point.y + "px");
    });
    let badge = crowd.querySelector(".faceMore");
    if (extra > 0) {
      if (!badge) { badge = document.createElement("span"); badge.className = "faceMore"; crowd.append(badge); }
      badge.textContent = "+" + extra;
    } else badge?.remove();
  }

  function addCharacter(id) {
    if (!pack) return null;
    const node = document.createElement("div");
    node.className = "faceCharacter";
    node.setAttribute("aria-hidden", "true");
    const body = document.createElement("div");
    body.className = "faceCharacterBody";
    const accessory = document.createElement("div");
    accessory.className = "faceCharacterAccessory";
    node.append(body, accessory);
    crowd.prepend(node);
    const value = hash(id);
    const palettes = pack.characters.palettes?.length ? pack.characters.palettes : [0];
    const accessories = Object.keys(pack.characters.accessories || {});
    body.style.filter = "hue-rotate(" + palettes[value % palettes.length] + "deg)";
    const item = { id, node, sprite: new Sprite(body, "characters"), accessoryName: accessories.length ? accessories[(value >>> 4) % accessories.length] : "", accessory, leaving: false, tools: new Map(), timer: null, token: 0 };
    characters.set(id, item);
    drawAccessory(item);
    item.sprite.play(pack, "arriving", scale("characters"), () => characterIdle(item));
    return item;
  }

  function drawAccessory(item) {
    const state = pack.characters.accessories?.[item.accessoryName];
    if (!state) { item.accessory.hidden = true; return; }
    new Sprite(item.accessory, "characters").draw(pack, state, 0, scale("characters"));
  }

  function characterIdle(item) {
    if (item.leaving || item.working) return;
    item.sprite.play(pack, "waiting", scale("characters"));
  }

  function characterLeave(item, state) {
    if (item.leaving) return;
    item.leaving = true;
    clearTimeout(item.timer);
    item.node.dataset.end = state;
    const finish = () => {
      item.node.classList.add("leaving");
      setTimeout(() => { item.node.remove(); characters.delete(item.id); placeCharacters(); }, LEAVE_MS);
    };
    item.sprite.play(pack, state, scale("characters"), finish);
    placeCharacters();
  }

  function onJob({ id, status }) {
    if (!active) return;
    let item = characters.get(id);
    if (status === JOB_ACTIVE) { if (!item) addCharacter(id); placeCharacters(); return; }
    if (!item) return;
    characterLeave(item, status === "completado" ? "done" : status === "error" ? "error" : "stopped");
  }

  function onJobTool({ id, name, phase }) {
    if (!active) return;
    const item = characters.get(id) || addCharacter(id);
    if (!item || item.leaving) return;
    placeCharacters();
    if (phase === "start") {
      clearTimeout(item.timer);
      item.token += 1;
      item.tools.set(name, { token: item.token, start: Date.now() });
      item.working = true;
      const family = toolFamily(name);
      item.sprite.play(pack, "working_" + (family === "asking" ? "generic" : family), scale("characters"));
      return;
    }
    const entry = item.tools.get(name);
    if (!entry) return;
    item.tools.delete(name);
    if (entry.token !== item.token) return;
    clearTimeout(item.timer);
    item.timer = setTimeout(() => { if (entry.token !== item.token) return; item.working = false; characterIdle(item); }, Math.max(0, settings().toolMinMs - (Date.now() - entry.start)));
  }

  function onTool({ name, phase, status }) {
    const family = toolFamily(name);
    if (family === "asking") return;
    if (phase === "start") {
      token += 1;
      toolTokens.set(name, token);
      flags.tool = { family, token, start: Date.now() };
      render();
      return;
    }
    const own = toolTokens.get(name);
    toolTokens.delete(name);
    if (!flags.tool || own !== flags.tool.token) return;
    const current = flags.tool;
    setTimeout(() => {
      if (flags.tool !== current) return;
      flags.tool = null;
      const values = settings();
      flags.reaction = { type: status === "error" ? "error" : "happy", until: Date.now() + values.reactionMs };
      render();
      setTimeout(() => render(), values.reactionMs + 20);
    }, Math.max(0, settings().toolMinMs - (Date.now() - current.start)));
  }

  function showSubtitle(text, final = false) {
    clearTimeout(subtitleTimer);
    subtitle.textContent = text || "";
    subtitle.hidden = !text;
    if (final) subtitleTimer = setTimeout(() => { subtitle.hidden = true; subtitle.textContent = ""; }, 4000);
  }

  function handle(event) {
    const detail = event.detail || {};
    const quiet = detail.type === "routine" || detail.type === "mouth";
    if (!quiet) touch();
    switch (detail.type) {
      case "thinking": flags.thinking = Boolean(detail.on); break;
      case "text": if (!flags.speaking) flags.writingUntil = Date.now() + Math.max(800, Math.min(4000, (detail.length || 0) * 20)); setTimeout(() => render(), Math.max(800, Math.min(4000, (detail.length || 0) * 20)) + 20); break;
      case "tool": onTool(detail); break;
      case "asking": flags.asking = Boolean(detail.on); break;
      case "speaking": flags.speaking = Boolean(detail.on); break;
      case "listening": flags.listening = Boolean(detail.on); break;
      case "attentive": flags.attentive = Boolean(detail.on); break;
      case "sleep": lastActivity = 0; break;
      case "magic": {
        const length = settings().reactionMs;
        flags.magicUntil = Date.now() + length;
        flags.reaction = { type: detail.status === "error" ? "error" : "happy", until: Date.now() + length };
        layer.classList.toggle("magicFlash", detail.status !== "error");
        setTimeout(() => { layer.classList.remove("magicFlash"); render(); }, length + 20);
        break;
      }
      case "routine":
        if (active && IDLE_STATES.has(compute()) && compute() === "idle" && !transient && pack) {
          const state = pack.face.states.routine;
          const length = state ? state.frames / state.fps * 1000 : 600;
          flags.routineUntil = Date.now() + length;
          setTimeout(() => render(), length + 20);
        }
        break;
      case "mouth": if (detail.level !== undefined) mouth.level = detail.level; else mouth.pulse = Date.now(); return;
      case "subtitle": showSubtitle(detail.text, detail.final); return;
      case "job": onJob(detail); return;
      case "jobTool": onJobTool(detail); return;
      default: break;
    }
    render();
  }

  function watchAlert() {
    const node = byId("offlineCountdown");
    const update = () => { flags.alert = !node.hidden; render(); };
    new MutationObserver(update).observe(node, { attributes: true, attributeFilter: ["hidden"] });
    flags.alert = !node.hidden;
  }

  async function set(on) {
    const value = Boolean(on);
    setting("faceMode", value ? "1" : "");
    byId("faceButton").setAttribute("aria-pressed", String(value));
    if (value === active) return active;
    if (value) {
      pack = await loadPack();
      active = true;
      document.body.classList.add("faceMode");
      layer.hidden = false;
      shield(true);
      lastActivity = Date.now();
      transient = "entering";
      playing = "entering";
      layout();
      sprite.play(pack, "entering", scale(), () => { transient = ""; render(true); });
      crowd.replaceChildren();
      characters.clear();
      placeCharacters();
      clearInterval(tickTimer);
      tickTimer = setInterval(() => render(), 1000);
    } else {
      active = false;
      clearInterval(tickTimer);
      clearTimeout(variantTimer);
      clearInterval(mouthTimer);
      document.body.classList.remove("faceMode");
      shield(false);
      sprite.play(pack, "exiting", scale(), () => { if (!active) { layer.hidden = true; sprite.stop(); crowd.replaceChildren(); characters.clear(); } });
    }
    return active;
  }

  window.addEventListener("eco-activity", handle);
  window.addEventListener("eco-face-pack", async () => {
    pack = await loadPack();
    edgeImage = null;
    edgeUrl = "";
    if (!active) return;
    crowd.replaceChildren();
    characters.clear();
    layout();
    render(true);
  });
  window.addEventListener("eco-face-voice-settings", () => { if (active) { layout(); render(true); } });
  new ResizeObserver(requestLayout).observe(layer);
  new ResizeObserver(requestLayout).observe(stage);
  window.addEventListener("resize", requestLayout);
  window.addEventListener("orientationchange", requestLayout);
  visualViewport?.addEventListener("resize", requestLayout);
  visualViewport?.addEventListener("scroll", requestLayout);
  watchAlert();
  byId("faceButton").onclick = () => { set(!active); };
  layer.addEventListener("pointerdown", (event) => event.preventDefault());
  if (setting("faceMode")) set(true);
  return {
    set,
    get active() { return active; },
    get state() { return active ? playing : "off"; },
    refresh: () => { if (active) placeCharacters(); },
    debug: () => ({ flags: { ...flags }, playing, transient, characters: [...characters.keys()] })
  };
}

export { emitActivity };
