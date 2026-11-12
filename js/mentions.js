export const MENTION_SEED_MS = 24 * 60 * 60 * 1000;
export const MENTION_ID_CAP = 2000;
const BROADCAST = new Set(["*", "todos", "all"]);

export function foldMention(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export function isBroadcastTo(value) {
  return BROADCAST.has(String(value || "").trim().toLowerCase());
}

export function mentionTokens(eco, handle, name) {
  const tokens = [];
  const seen = new Set();
  const add = (value, skipGeneric) => {
    const text = String(value || "").trim();
    const key = foldMention(text);
    if (!text || !key || seen.has(key)) return;
    if (skipGeneric && key === "eco") return;
    seen.add(key);
    tokens.push(text);
  };
  add(eco, false);
  add(handle, true);
  add(name, true);
  return tokens;
}

export function contentHasMention(content, tokens) {
  const text = foldMention(content);
  if (!text) return false;
  return tokens.some((token) => {
    const needle = foldMention(token);
    if (!needle) return false;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp("(^|[^a-z0-9-])" + escaped + "([^a-z0-9-]|$)", "").test(text);
  });
}

export function isMentionRecord(record, { eco, handle, name } = {}) {
  if (!record || !["message", "ack"].includes(record.type)) return false;
  if (String(record.eco_author || "").trim() === String(eco || "").trim()) return false;
  const to = String(record.to || "").trim();
  if (isBroadcastTo(to) || to === String(eco || "").trim() || (handle && foldMention(to) === foldMention(handle))) return true;
  return contentHasMention(record.content, mentionTokens(eco, handle, name));
}

export function selectMentionWake(records, processed = {}, now = Date.now(), options = {}) {
  const cap = options.cap || MENTION_ID_CAP;
  const seedMs = options.seedMs ?? MENTION_SEED_MS;
  const seen = new Set(processed.ids || []);
  const ids = [...seen];
  const wake = [];
  const cutoff = now - seedMs;
  for (const record of records) {
    const id = String(record?.id || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    const time = Date.parse(record.date);
    const skipOld = !processed.seeded && (!Number.isFinite(time) || time < cutoff);
    if (!skipOld) wake.push(record);
  }
  return { wake, processed: { ids: ids.slice(-cap), seeded: Boolean(processed.seeded || options.caughtUp) } };
}
