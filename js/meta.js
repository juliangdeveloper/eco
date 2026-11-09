const MAX_STATS = 20;
const MAX_OBJETIVO = 140;

export const FASE = Object.freeze({ IDEA: 1, DEFINICION: 2, DISENO: 3, CONSTRUCCION: 4, VALIDACION: 5, LANZAMIENTO_Y_MANTENIMIENTO: 6, DESCARTADA: 7 });
export const ESTADO_FASE = Object.freeze({ PENDIENTE: 0, EN_CURSO: 1, BLOQUEADA: 2, EN_REVISION: 3, COMPLETADA: 4 });
export const TIPO_STAT = Object.freeze({ TOTAL_ACUMULADO: "total_acumulado", MEJOR_MARCA: "mejor_marca", VALOR_ACTUAL: "valor_actual" });
export const TIPO_PROYECTO = Object.freeze({ PROYECTO: "proyecto", AREA: "area", RECURSO: "recurso", ARCHIVO: "archivo" });

export const PROYECTO = Object.freeze({
  objetivo: "AI agent that runs in the browser and adapts to protocols and APIs.",
  fase: FASE.LANZAMIENTO_Y_MANTENIMIENTO,
  fase_estado: ESTADO_FASE.EN_CURSO,
  fases_completadas: 5,
  tipo: TIPO_PROYECTO.RECURSO,
  aportes: [
    { stat: "Programming", exp: 30, fuente: "creacion" },
    { stat: "Design", exp: 8, fuente: "creacion" },
    { stat: "Productivity", exp: 20, fuente: "uso" },
    { stat: "Programming", exp: 10, fuente: "uso" }
  ],
});

let proyectoSource = PROYECTO;

function proyectoInt(n, lo, hi) {
  return typeof n === "number" && Number.isInteger(n) && n >= lo && n <= hi;
}

export function enumValido(enumeracion, valor) {
  return Object.values(enumeracion).indexOf(valor) !== -1;
}

export function statConservaMaximo(tipo) {
  return tipo === TIPO_STAT.TOTAL_ACUMULADO || tipo === TIPO_STAT.MEJOR_MARCA;
}

export function statsDeclarados(stats) {
  if (Array.isArray(stats)) return stats;
  if (!stats || typeof stats !== "object") return [];
  return Object.keys(stats).map((key) => ({ key, tipo: stats[key] && stats[key].tipo }));
}

const APORTE_STAT_MAX = 32;
const APORTE_EXP_MAX = 99;

function aportesValidos(lista) {
  if (!Array.isArray(lista)) return null;
  const out = [];
  const seen = {};
  for (let i = 0; i < lista.length; i++) {
    const it = lista[i];
    if (!it || typeof it !== "object" || Array.isArray(it)) return null;
    const stat = it.stat;
    const exp = it.exp;
    const fuente = it.fuente;
    if (typeof stat !== "string" || !stat.trim() || stat !== stat.trim() || Array.from(stat).length > APORTE_STAT_MAX) return null;
    if (fuente !== "creacion" && fuente !== "uso") return null;
    if (!(proyectoInt(exp, 1, APORTE_EXP_MAX))) return null;
    const key = stat + "\n" + fuente;
    if (seen[key]) return null;
    if (Object.keys(it).length !== 3) return null;
    seen[key] = true;
    out.push({ stat: stat, exp: exp, fuente: fuente });
  }
  return out;
}

export function metaProyecto(p) {
  try {
    if (!p || typeof p !== "object" || Array.isArray(p)) return null;
    const o = p.objetivo;
    if (typeof o !== "string" || !o.trim() || Array.from(o).length > MAX_OBJETIVO) return null;
    if (!enumValido(FASE, p.fase) || !enumValido(ESTADO_FASE, p.fase_estado) || !proyectoInt(p.fases_completadas, 0, FASE.LANZAMIENTO_Y_MANTENIMIENTO)) return null;
    if (p.tipo !== undefined && !enumValido(TIPO_PROYECTO, p.tipo)) return null;
    const bloque = { objetivo: o, fase: p.fase, fase_estado: p.fase_estado, fases_completadas: p.fases_completadas };
    if (p.tipo !== undefined) bloque.tipo = p.tipo;
    if (p.bloqueada === true) bloque.bloqueada = true;
    if (p.aportes !== undefined) {
      const aportes = aportesValidos(p.aportes);
      if (!aportes) return null;
      bloque.aportes = aportes;
    }
    return bloque;
  } catch (e) {
    return null;
  }
}

export function metaSetProyecto(p) {
  proyectoSource = p === null ? PROYECTO : p;
}

export function metaDeclararProyecto(slug, version) {
  try {
    const store = globalThis.localStorage;
    if (!store || !slug) return null;
    const clave = "meta.v1." + slug;
    const raw = store.getItem(clave);
    let base = null;
    if (raw != null && raw !== "") {
      try {
        const previo = JSON.parse(raw);
        if (previo && typeof previo === "object" && !Array.isArray(previo) && previo.v === 1 && previo.slug === slug) base = previo;
      } catch (e) {
        base = null;
      }
      if (!base) store.setItem(clave + ".corrupt", String(raw));
    }
    if (!base) base = { v: 1, slug: slug, version: String(version == null ? "" : version).replace(/^[vV]/, ""), updatedAt: new Date().toISOString(), stats: {}, logros: [], hitos: {} };
    const p = metaProyecto(proyectoSource);
    if (p) base.proyecto = p;
    const texto = JSON.stringify(base);
    if (texto !== raw) {
      store.setItem(clave, texto);
      if (typeof window !== "undefined" && window.parent && window.parent !== window) window.parent.postMessage({ type: "meta", key: clave, data: base }, location.origin);
    }
    return base;
  } catch (e) {
    return null;
  }
}

export function metaKey(slug) {
  return "meta.v1." + slug;
}

function finiteNumber(v) {
  return typeof v === "number" && isFinite(v);
}

function plainVersion(version) {
  let s = version == null ? "" : String(version);
  if (s.charAt(0) === "v" || s.charAt(0) === "V") s = s.slice(1);
  return s;
}

function declaredList(declare) {
  const list = [];
  const seen = {};
  const items = statsDeclarados(declare);
  for (let i = 0; i < items.length && list.length < MAX_STATS; i++) {
    const item = items[i];
    const key = typeof item === "string" ? item : item && item.key;
    if (typeof key !== "string" || !key || seen[key]) continue;
    seen[key] = true;
    list.push({ key, tipo: item && item.tipo });
  }
  return list;
}

function nowIso(now) {
  if (typeof now === "string" && now) return now;
  if (now instanceof Date) return now.toISOString();
  return new Date().toISOString();
}

function parseRaw(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

function usableRecord(parsed, slug) {
  return !!(parsed && parsed.v === 1 && parsed.slug === slug);
}

function defaultStorage() {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch (e) {
    return null;
  }
}

export function metaRead(slug, opts) {
  const storage = (opts && opts.storage) || defaultStorage();
  if (!storage) return null;
  try {
    const parsed = parseRaw(storage.getItem(metaKey(slug)));
    return usableRecord(parsed, slug) ? parsed : null;
  } catch (e) {
    return null;
  }
}

export function metaUpdate(slug, version, patch, opts) {
  let record = null;
  try {
    opts = opts || {};
    patch = patch || {};
    const storage = opts.storage || defaultStorage();
    if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") return null;

    const key = metaKey(slug);
    let raw = null;
    try { raw = storage.getItem(key); } catch (eRead) { raw = null; }
    let existing = null;
    if (raw != null) {
      const parsed = parseRaw(raw);
      if (!usableRecord(parsed, slug)) {
        try { storage.setItem(key + ".corrupt", String(raw)); } catch (eCopy) { existing = null; }
      } else {
        existing = parsed;
      }
    }

    const stamp = nowIso(opts.now);
    const decl = declaredList(opts.declare);
    const src = existing && existing.stats && typeof existing.stats === "object" && !Array.isArray(existing.stats) ? existing.stats : {};
    const incoming = patch.stats && typeof patch.stats === "object" && !Array.isArray(patch.stats) ? patch.stats : {};
    const stats = {};
    for (const item of decl) {
      const hasNew = Object.prototype.hasOwnProperty.call(incoming, item.key) && finiteNumber(incoming[item.key]);
      const hasOld = finiteNumber(src[item.key]);
      if (hasNew && hasOld && statConservaMaximo(item.tipo)) stats[item.key] = Math.max(src[item.key], incoming[item.key]);
      else if (hasNew) stats[item.key] = incoming[item.key];
      else if (hasOld) stats[item.key] = src[item.key];
    }

    const seen = {};
    const hitosIn = {};
    const oldHitos = existing && existing.hitos && typeof existing.hitos === "object" && !Array.isArray(existing.hitos) ? existing.hitos : {};
    const oldLogros = existing && Array.isArray(existing.logros) ? existing.logros : [];
    for (const id of oldLogros) {
      if (typeof id === "string" && id) seen[id] = true;
    }
    for (const id of Object.keys(oldHitos)) {
      if (typeof oldHitos[id] === "string" && oldHitos[id]) {
        hitosIn[id] = oldHitos[id];
        seen[id] = true;
      }
    }
    const add = Array.isArray(patch.logros) ? patch.logros : [];
    for (const id of add) {
      if (typeof id !== "string" || !id) continue;
      seen[id] = true;
      if (!hitosIn[id]) hitosIn[id] = stamp;
    }
    const ids = Object.keys(seen).sort();
    const hitos = {};
    for (const id of ids) hitos[id] = hitosIn[id] || stamp;

    record = { v: 1, slug, version: plainVersion(version), updatedAt: stamp, stats, logros: ids, hitos };
    const p = metaProyecto(proyectoSource);
    if (p) record.proyecto = p;
    storage.setItem(key, JSON.stringify(record));

    try {
      const view = Object.prototype.hasOwnProperty.call(opts, "window") ? opts.window : typeof window !== "undefined" ? window : null;
      if (view && view.parent && view.parent !== view && typeof view.parent.postMessage === "function") {
        let origin = "";
        try {
          if (opts.location && opts.location.origin) origin = opts.location.origin;
          else if (typeof location !== "undefined" && location && location.origin) origin = location.origin;
        } catch (eOrigin) {
          origin = "";
        }
        view.parent.postMessage({ type: "meta", key, data: record }, origin);
      }
    } catch (ePost) {
      return record;
    }
  } catch (e) {
    return null;
  }
  return record;
}

export function crearEscritor(write, opts) {
  const intervalo = (opts && opts.intervaloMs) || 1000;
  const reloj = (opts && opts.reloj) || (() => Date.now());
  const temporizar = (opts && opts.temporizar) || ((fn, ms) => setTimeout(fn, ms));
  const cancelar = (opts && opts.cancelar) || ((id) => clearTimeout(id));
  let ultimo = -Infinity;
  let pendiente = false;
  let timer = null;

  function escribir() {
    timer = null;
    if (!pendiente) return;
    pendiente = false;
    ultimo = reloj();
    write();
  }

  return {
    pedir() {
      pendiente = true;
      if (timer !== null) return;
      const espera = Math.max(0, ultimo + intervalo - reloj());
      if (espera === 0) escribir();
      else timer = temporizar(escribir, espera);
    },
    vaciar() {
      if (timer !== null) {
        cancelar(timer);
        timer = null;
      }
      if (pendiente) escribir();
    },
    pendiente() {
      return pendiente;
    },
  };
}
