const RESULT_LIMIT_BYTES = 8 * 1024 * 1024;
const RESULT_LIMIT_COUNT = 64;
const EMERGENCY_RESULT_COUNT = 4;
const MAX_DEPTH = 80;
const encoder = new TextEncoder();

function plain(value, depth = 0, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (!value || typeof value !== "object" || depth > MAX_DEPTH || seen.has(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return null;
    const next = new Set(seen).add(value);
    if (Array.isArray(value)) return value.map(item => plain(item, depth + 1, next));
    return Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(value)).filter(([, descriptor]) => "value" in descriptor).map(([key, descriptor]) => [key, plain(descriptor.value, depth + 1, next)]));
  } catch { return null; }
}

export function pruneResults(results, emergency = false) {
  const entries = Object.entries(results || {});
  const kept = [];
  let bytes = 0;
  for (const original of entries.reverse()) {
    let entry = original;
    let size = encoder.encode(JSON.stringify(entry)).length;
    if (size > RESULT_LIMIT_BYTES) {
      entry = [original[0], { tool: original[1]?.tool || "", content: JSON.stringify({ error: "El resultado excede los 8 MiB del historial. Solicita datos por partes en el origen.", total_bytes: size }) }];
      size = encoder.encode(JSON.stringify(entry)).length;
    }
    if (kept.length >= (emergency ? EMERGENCY_RESULT_COUNT : RESULT_LIMIT_COUNT) || bytes + size > RESULT_LIMIT_BYTES) continue;
    bytes += size;
    kept.push(entry);
  }
  return Object.fromEntries(kept.reverse());
}

export function sessionSnapshot(session, emergency = false) {
  const snapshot = plain(session);
  snapshot.results = emergency && !snapshot.inFlight && !snapshot.pendingTurns?.length ? {} : pruneResults(snapshot.results, emergency);
  for (const job of snapshot.subagents || []) job.results = emergency && job.status !== "ejecutando" ? {} : pruneResults(job.results, emergency);
  return snapshot;
}
