import { interceptSecurityCommand, isWiping } from "./security.js";
import { all } from "./storage.js";
import { byId } from "./ui.js";
import { emitActivity } from "./face-config.js";

const ACTIVE = "ejecutando";
const STATUS_LABELS = { ejecutando: "running", completado: "completed", error: "error", detenido: "stopped", interrumpido: "interrupted" };
const PREVIEW_CHARS = 1600;
const TERMINAL = new Set(["completado", "error", "detenido", "interrumpido"]);
const LIGHT_FIELDS = ["id", "session", "task", "project", "status", "summary", "finishedAt", "seen", "delivered", "revision", "updatedAt"];
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
  return (session.subagents || []).map(({ id, task, project, status, summary, light, finishedAt }) => ({ id, task, project, status, summary: (summary || "").slice(0, PREVIEW_CHARS), ...(light ? { light: true, finishedAt: new Date(finishedAt).toISOString() } : {}) }));
}

export async function jobUpdate(raw, finished) {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (isWiping()) return;
  const session = await api.resolveSession(value.session);
  if (isWiping()) return;
  session.subagents ||= [];
  const previous = session.subagents.find((row) => row.id === value.id);
  const next = { ...previous, ...value, updatedAt: Date.now(), revision: (previous?.revision || 0) + 1, todos: previous?.todos || [] };
  if (finished) { next.delivered = false; next.seen = false; next.finishedAt = Date.now(); }
  if (value.status === ACTIVE) { delete next.finishedAt; next.light = false; }
  const before = previous?.status;
  if (previous) Object.assign(previous, next);
  else session.subagents.push(next);
  if (value.status === ACTIVE && !controllers.has(value.id)) resumeJob(value.id);
  if (value.status !== ACTIVE) controllers.delete(value.id);
  await api.persist(session);
  if (isWiping()) return;
  if (session === api.getSession() && value.status && before !== value.status) emitActivity("job", { id: value.id, status: value.status });
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

const unseen = (job) => TERMINAL.has(job.status) && job.seen === false;

export function lightJob(job) {
  const light = Object.fromEntries(LIGHT_FIELDS.filter((key) => job[key] !== undefined).map((key) => [key, job[key]]));
  return { ...light, finishedAt: job.finishedAt || job.updatedAt || Date.now(), light: true, messages: [], results: {}, todos: [] };
}

export async function compactFinishedJobs(detailMs, now = Date.now()) {
  if (!api || isWiping()) return [];
  const finished = (job) => TERMINAL.has(job.status) && !job.light;
  const old = (job) => finished(job) && job.finishedAt + detailMs <= now;
  const ids = [];
  for (const saved of await all("sessions")) {
    if (!(saved.subagents || []).some((job) => old(job) || (finished(job) && !job.finishedAt))) continue;
    if (isWiping()) return ids;
    const session = await api.resolveSession(saved.id);
    let changed = false;
    session.subagents = (session.subagents || []).map((job) => {
      if (finished(job) && !job.finishedAt) { job.finishedAt = now; changed = true; return job; }
      if (!old(job)) return job;
      ids.push(job.id);
      changed = true;
      return lightJob(job);
    });
    if (changed) await api.persistQuiet(session);
  }
  if (ids.length) { try { await api.getPyodide()?.globals.get("forget_jobs")(JSON.stringify(ids)); } catch {} }
  if (ids.length) renderSubagents();
  return ids;
}

function markSeen(job) {
  if (!job || !unseen(job) || !byId("subagentsPanel").open) return;
  job.seen = true;
  api.persistQuiet(api.getSession()).catch(() => {});
}

export function openSubagent(index) {
  const rows = api?.getSession().subagents || [];
  if (!rows.length) return;
  selected = Math.max(0, Math.min(index, rows.length - 1));
  byId("subagentsPanel").showModal();
  renderSubagents();
}

export function subagentHistory() {
  return (api?.getSession().subagents || []).map((job, index) => ({ index, task: job.task, status: STATUS_LABELS[job.status] || job.status, project: job.project || "", light: Boolean(job.light), unseen: unseen(job) }));
}

export function renderSubagents() {
  if (!api) return;
  const rows = api.getSession().subagents || [];
  const active = rows.filter((job) => job.status === ACTIVE).length;
  const fresh = rows.filter(unseen).length;
  byId("subagentsButton").hidden = !(active + fresh);
  byId("subagentsButton").textContent = "Subagents · " + [active ? active + " running" : "", fresh ? fresh + " new" : ""].filter(Boolean).join(" · ");
  selected = Math.max(0, Math.min(selected, rows.length - 1));
  const job = rows[selected];
  byId("subagentPosition").textContent = rows.length ? selected + 1 + " / " + rows.length : "No subagents";
  byId("subagentPrevious").disabled = selected === 0;
  byId("subagentNext").disabled = selected >= rows.length - 1;
  byId("subagentTask").textContent = job?.task || "";
  byId("subagentStatus").textContent = job ? (STATUS_LABELS[job.status] || job.status) + (job.project ? " · " + job.project : "") + (job.light ? " · details cleared" : "") : "";
  byId("subagentResult").textContent = job?.summary?.slice(0, PREVIEW_CHARS) || "";
  byId("subagentStop").disabled = job?.status !== ACTIVE;
  byId("subagentInstruction").disabled = !job || job.light;
  byId("subagentFollow").disabled = !job || job.light;
  if (job && unseen(job) && byId("subagentsPanel").open) { markSeen(job); renderSubagents(); }
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
        job.finishedAt = Date.now();
        job.seen = false;
      }
    }
    await api.persist(session);
  }
  byId("subagentsButton").onclick = () => {
    const rows = api.getSession().subagents || [];
    const index = rows.findIndex((job) => unseen(job) || job.status === ACTIVE);
    openSubagent(index >= 0 ? index : 0);
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
