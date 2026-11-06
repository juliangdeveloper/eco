import { all } from "./storage.js";
import { byId, element } from "./ui.js";

const MAX_FRAGMENT_LENGTH = 160;
const SEARCHABLE_ROLES = ["user", "assistant"];

function fragment(text, query) {
  const lower = text.toLowerCase();
  const index = lower.indexOf(query.toLowerCase());
  if (index < 0) {
    return "";
  }
  const start = Math.max(0, index - Math.floor(MAX_FRAGMENT_LENGTH / 2));
  const end = Math.min(text.length, start + MAX_FRAGMENT_LENGTH);
  return (start ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

export async function searchSessions(query, limit, currentId) {
  const term = String(query || "").trim().toLowerCase();
  if (!term) {
    return { results: [] };
  }
  const rows = await all("sessions");
  const results = rows
    .filter((row) => row.id !== currentId)
    .map((row) => {
      const fragments = (row.messages || [])
        .filter((item) => SEARCHABLE_ROLES.includes(item.role))
        .map((item) => fragment(String(item.content || ""), term))
        .filter(Boolean)
        .slice(0, 3);
      return { id: row.id, title: row.title, updatedAt: row.updatedAt, fragments };
    })
    .filter((row) => row.fragments.length || String(row.title || "").toLowerCase().includes(term))
    .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
    .slice(0, Number(limit) || 10);
  return { results };
}

export function createSessions({ loadSession, newSession }) {
  async function render(query = "") {
    const list = byId("sessionList");
    const rows = query
      ? (await searchSessions(query, 50, "")).results
      : (await all("sessions")).sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
    list.replaceChildren(...rows.map((row) => sessionRow(row)));
  }

  function sessionRow(row) {
    const wrapper = element("div", "", "session");
    const open = element("button", row.title || "Nueva conversación");
    open.type = "button";
    open.onclick = async () => {
      const rows = await all("sessions");
      const session = rows.find((item) => item.id === row.id) || row;
      loadSession(session);
      byId("sessionsPanel").hidden = true;
    };
    wrapper.append(open);
    for (const text of row.fragments || []) {
      wrapper.append(element("p", text, "fragment"));
    }
    return wrapper;
  }

  byId("sessionsButton").onclick = async () => {
    byId("sessionSearch").value = "";
    await render();
    byId("sessionsPanel").hidden = false;
  };
  byId("sessionSearch").oninput = (event) => render(event.target.value);
  byId("newSession").onclick = () => {
    newSession();
    byId("sessionsPanel").hidden = true;
  };
  return { render };
}
