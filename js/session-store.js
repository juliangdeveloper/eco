import { all, json, store } from "./storage.js";
import { sessionSnapshot } from "./session-data.js";

const JOURNAL_PREFIX = "sessionJournal:";
const queues = new Map();

const latest = new Map();

export function saveSession(session) {
  session.revision = (session.revision || 0) + 1;
  session.updatedAt = Date.now();
  const snapshot = sessionSnapshot(session);
  session.results = snapshot.results;
  for (const job of session.subagents || []) job.results = snapshot.subagents.find(row => row.id === job.id)?.results || {};
  latest.set(session.id, snapshot);
  if (queues.has(session.id)) return queues.get(session.id);
  const pending = (async () => {
    while (latest.has(session.id)) {
      const next = latest.get(session.id);
      await store("sessions", next);
      if (latest.get(session.id) === next) latest.delete(session.id);
    }
  })();
  queues.set(session.id, pending);
  pending.finally(() => { if (queues.get(session.id) === pending) queues.delete(session.id); }).catch(() => {});
  return pending;
}

export function flushSessions(sessions) {
  return Promise.all([...sessions].map(saveSession));
}

export async function recoverSessions(resume = null) {
  const rows = await all("sessions");
  for (const key of Object.keys(localStorage).filter((name) => name.startsWith("eco." + JOURNAL_PREFIX))) {
    const name = key.slice("eco.".length);
    const journal = json(name);
    if (!journal?.id || !Array.isArray(journal.messages)) continue;
    const index = rows.findIndex((row) => row.id === journal.id);
    const previous = rows[index] || { todos: [], results: {}, subagents: [] };
    if ((journal.revision || 0) >= (previous.revision || 0)) {
      const restored = sessionSnapshot({ ...previous, ...journal });
      await store("sessions", restored);
      if (index < 0) rows.push(restored);
      else rows[index] = restored;
    }
    localStorage.removeItem(key);
  }
  for (const row of rows) {
    row.messages ||= [];
    for (const message of row.messages) message.id ||= "m-" + crypto.randomUUID();
    if ((row.inFlight || row.pendingTurns?.length) && !resume?.sessions?.some((item) => item.id === row.id)) {
      row.messages.push({ id: "m-" + crypto.randomUUID(), role: "assistant", content: "La respuesta se interrumpió. Tus mensajes están guardados; puedes pedir que continúe." });
      const context = row.contextMessages || [];
      const answered = new Set(context.filter((message) => message.role === "tool").map((message) => message.tool_call_id));
      for (const call of context.flatMap((message) => message.tool_calls || [])) {
        if (!answered.has(call.id)) context.push({ id: "m-" + crypto.randomUUID(), role: "tool", tool_call_id: call.id, name: call.function.name, content: "La ejecución se interrumpió. Comprueba el estado antes de repetir la acción." });
      }
      row.inFlight = null;
      row.pendingTurns = [];
    }
    Object.assign(row, sessionSnapshot(row));
    await store("sessions", row);
  }
  return rows;
}
