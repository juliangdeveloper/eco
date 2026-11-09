import { interceptSecurityCommand, isWiping } from "./security.js";
import { all } from "./storage.js";
import { byId } from "./ui.js";

const ACTIVE = "ejecutando";
const STATUS_LABELS = { ejecutando: "running", completado: "completed", error: "error", detenido: "stopped", interrumpido: "interrupted" };
const PREVIEW_CHARS = 1600;
const controllers = new Map();
let api;
let selected = 0;

export function jobSignal(id) {
  return controllers.get(id)?.signal;
}

export function abortJob(id) {
  controllers.get(id)?.abort();
  window.ecoUI?.cancelJob(id);
}

export function resumeJob(id) {
  if (isWiping()) return;
  controllers.set(id, new AbortController());
}

export async function jobSnapshot(id, sessionId) {
  if (isWiping()) return;
  const session = await api.resolveSession(sessionId);
  return session.subagents?.find((row) => row.id === id) || null;
}

export async function jobRecords(sessionId) {
  if (isWiping()) return;
  const session = await api.resolveSession(sessionId);
  return (session.subagents || []).map(({ id, task, project, status, summary }) => ({ id, task, project, status, summary: (summary || "").slice(0, PREVIEW_CHARS) }));
}

export async function jobUpdate(raw, finished) {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (isWiping()) return;
  const session = await api.resolveSession(value.session);
  if (isWiping()) return;
  session.subagents ||= [];
  const previous = session.subagents.find((row) => row.id === value.id);
  const next = { ...previous, ...value, updatedAt: Date.now(), revision: (previous?.revision || 0) + 1, todos: previous?.todos || [] };
  if (finished) next.delivered = false;
  if (previous) Object.assign(previous, next);
  else session.subagents.push(next);
  if (value.status === ACTIVE && !controllers.has(value.id)) resumeJob(value.id);
  if (value.status !== ACTIVE) controllers.delete(value.id);
  await api.persist(session);
  if (isWiping()) return;
  renderSubagents();
  if (finished) api.receiveJob(session, structuredClone(previous || next)).catch(() => { byId("subagentError").textContent = "The result could not be delivered. Tell the subagent to continue."; });
  return true;
}

async function control(action, instruction = "") {
  if (await interceptSecurityCommand(instruction) || isWiping()) return;
  const rows = api.getSession().subagents || [];
  const job = rows[selected];
  if (!job) return;
  const result = JSON.parse(await api.getPyodide().globals.get("job_control")(JSON.stringify({ session: job.session, id: job.id, action, instruction })));
  byId("subagentError").textContent = result.error || "";
  renderSubagents();
}

export function renderSubagents() {
  if (!api) return;
  const rows = api.getSession().subagents || [];
  const active = rows.filter((job) => job.status === ACTIVE).length;
  byId("subagentsButton").hidden = !rows.length;
  byId("subagentsButton").textContent = active ? "Subagents · " + active + " running" : "Subagents · " + rows.length;
  selected = Math.max(0, Math.min(selected, rows.length - 1));
  const job = rows[selected];
  byId("subagentPosition").textContent = rows.length ? selected + 1 + " / " + rows.length : "No subagents";
  byId("subagentPrevious").disabled = selected === 0;
  byId("subagentNext").disabled = selected >= rows.length - 1;
  byId("subagentTask").textContent = job?.task || "";
  byId("subagentStatus").textContent = job ? (STATUS_LABELS[job.status] || job.status) + (job.project ? " · " + job.project : "") : "";
  byId("subagentResult").textContent = job?.summary?.slice(0, PREVIEW_CHARS) || "";
  byId("subagentStop").disabled = job?.status !== ACTIVE;
  byId("subagentInstruction").disabled = !job;
  byId("subagentFollow").disabled = !job;
}

export async function setupSubagents(options) {
  api = options;
  for (const saved of await all("sessions")) {
    if (!(saved.subagents || []).some((job) => job.status === ACTIVE)) continue;
    if (isWiping()) return;
    const session = await api.resolveSession(saved.id);
    for (const job of session.subagents || []) {
      if (job.status === ACTIVE) {
        job.status = "interrumpido";
        job.summary = "It was interrupted when Eco closed or reloaded. You can tell it to continue.";
        job.delivered = true;
      }
    }
    await api.persist(session);
  }
  byId("subagentsButton").onclick = () => {
    renderSubagents();
    byId("subagentsPanel").showModal();
  };
  byId("subagentPrevious").onclick = () => { selected -= 1; renderSubagents(); };
  byId("subagentNext").onclick = () => { selected += 1; renderSubagents(); };
  byId("subagentStop").onclick = () => control("detener");
  byId("subagentForm").onsubmit = async (event) => {
    event.preventDefault();
    const input = byId("subagentInstruction");
    const instruction = input.value.trim();
    if (!instruction) return;
    input.value = "";
    await control("modificar", instruction);
  };
  renderSubagents();
}

export function stopSubagents() {
  for (const id of controllers.keys()) { try { abortJob(id); } catch {} }
  controllers.clear();
  api = null;
}
