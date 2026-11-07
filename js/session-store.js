import { all, json, store } from "./storage.js";

const JOURNAL_PREFIX = "sessionJournal:";
const queues = new Map();

export function checkpointSession(session) {
  const value = { id: session.id, title: session.title, messages: session.messages, results: session.results, pendingTurns: session.pendingTurns || [], inFlight: session.inFlight || null, contextMessages: session.contextMessages || [], contextKnownIds: session.contextKnownIds || [], replyDraft: session.replyDraft || null, draft: session.draft || "", subagents: session.subagents || [], todos: session.todos || [], updatedAt: session.updatedAt, revision: session.revision };
  try { json(JOURNAL_PREFIX + session.id, value); }
  catch { window.dispatchEvent(new Event("eco-storage-error")); }
}

export function saveSession(session) {
  session.revision = (session.revision || 0) + 1;
  session.updatedAt = Date.now();
  checkpointSession(session);
  const snapshot = structuredClone(session);
  const previous = queues.get(session.id) || Promise.resolve();
  const pending = previous.catch(() => {}).then(() => store("sessions", snapshot)).then(() => {
    const journal = json(JOURNAL_PREFIX + session.id);
    if (journal?.revision === snapshot.revision) localStorage.removeItem("eco." + JOURNAL_PREFIX + session.id);
  });
  queues.set(session.id, pending);
  pending.finally(() => { if (queues.get(session.id) === pending) queues.delete(session.id); }).catch(() => {});
  return pending;
}

export function flushSessions(sessions) {
  for (const session of sessions) checkpointSession(session);
  return Promise.allSettled([...queues.values()]);
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
      const restored = { ...previous, ...journal };
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
    await store("sessions", row);
  }
  return rows;
}
