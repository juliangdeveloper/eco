import { renderMarkdown } from "./markdown.js";

export const MAX_TOOL_PREVIEW = 2400;

export const TOOL_LABELS = {
  memory: "Memoria",
  todo_list: "Tareas",
  subagente_crear: "Subagente",
  subagente_listar: "Subagentes",
  subagente_control: "Subagente",
  clarify: "Pregunta",
  session_search: "Buscar sesiones",
  skills_list: "Habilidades",
  skill_view: "Habilidades",
  skill_manage: "Habilidades",
  create_connector: "Crear conector",
  list_connectors: "Conectores",
  call_connector: "Conector",
  request_sign_in: "Iniciar sesión"
};

const CANCELLED_ERROR = "Acción cancelada";
const STATUS_CANCELLED = "cancelada";

const URL_PATTERN = /https:\/\/[^\s<]+/g;

export function byId(id) {
  return document.getElementById(id);
}

export function element(tag, text = "", className = "") {
  const item = document.createElement(tag);
  item.className = className;
  item.textContent = text;
  return item;
}

export function toolLabel(name) {
  if (TOOL_LABELS[name]) {
    return TOOL_LABELS[name];
  }
  return name;
}

export function pretty(value) {
  try {
    return JSON.stringify(typeof value === "string" ? JSON.parse(value) : value, null, 2);
  } catch {
    return String(value);
  }
}

export function preview(value) {
  const text = pretty(value);
  return text.length > MAX_TOOL_PREVIEW ? text.slice(0, MAX_TOOL_PREVIEW) + "…" : text;
}

export function appendMessage(role, content, label = "", metadata = {}) {
  byId("empty")?.remove();
  const message = element("div", "", "message " + role);
  if (role === "assistant") {
    try {
      renderMarkdown(message, content || "");
    } catch {
      message.replaceChildren(document.createTextNode(content || ""));
    }
  } else {
    appendTextWithLinks(message, content || "");
  }
  if (metadata.replyTo) {
    const quote = element("blockquote", metadata.replyTo.text, "messageQuote");
    quote.dataset.replyId = metadata.replyTo.id;
    message.prepend(quote);
  }
  if (metadata.id) message.dataset.messageId = metadata.id;
  if (metadata.subagentId) message.dataset.subagentId = metadata.subagentId;
  if (label) message.prepend(element("strong", label, "subagentLabel"));
  byId("chat").append(message);
  scrollChat();
  return message;
}

export function appendTextWithLinks(parent, text) {
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    parent.append(document.createTextNode(text.slice(last, match.index)));
    const link = document.createElement("a");
    link.href = match[0];
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = match[0];
    parent.append(link);
    last = match.index + match[0].length;
  }
  parent.append(document.createTextNode(text.slice(last)));
}

export function renderMessages(messages) {
  const chat = byId("chat");
  chat.replaceChildren();
  for (const item of messages) {
    if (!item.event && item.content && (item.role === "user" || item.role === "assistant")) {
      appendMessage(item.role, item.content, item.uiLabel || "", item);
    }
  }
}

export function renderEmpty(send) {
  const empty = element("div", "", "empty");
  empty.id = "empty";
  empty.append(element("div", "¿En qué te ayudo?"));
  const suggestions = element("div", "", "suggestions");
  const texts = ["Conéctate a mi correo", "Conecta mis repositorios", "Organiza mis tareas"];
  for (const text of texts) {
    const button = element("button", text);
    button.type = "button";
    button.onclick = () => send(text);
    suggestions.append(button);
  }
  empty.append(suggestions);
  byId("chat").replaceChildren(empty);
}

export function updateToolCard(name, status, value) {
  const chat = byId("chat");
  const selector = '[data-tool="' + CSS.escape(name) + '"][data-active="true"]';
  let card = chat.querySelector(selector);
  if (!card) {
    card = document.createElement("details");
    card.className = "tool";
    card.dataset.tool = name;
    card.dataset.active = "true";
    chat.append(card);
  }
  const shown = value && value.error === CANCELLED_ERROR ? STATUS_CANCELLED : status;
  const title = name === "contexto" ? "Contexto resumido" : toolLabel(name) + " · " + shown;
  card.dataset.status = status;
  card.open = false;
  card.replaceChildren(element("summary", title), element("pre", preview(value)));
  if (status !== "trabajando") {
    card.dataset.active = "false";
  }
  scrollChat();
}

export function renderTodos(todos) {
  const active = todos.filter((item) => ["pending", "in_progress"].includes(item.status));
  const bar = byId("todoBar");
  bar.hidden = active.length === 0;
  bar.replaceChildren(...active.map((item) => element("span", item.content)));
}

export function scrollChat() {
  const chat = byId("chat");
  chat.scrollTop = chat.scrollHeight;
}

export function autoExpand(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = Math.min(textarea.scrollHeight, 116) + "px";
}

const REPLY_THRESHOLD = 52;
const REPLY_MAX_DRAG = 92;
const DIRECTION_THRESHOLD = 10;

export function renderReply(reply) {
  byId("replyPreview").hidden = !reply;
  const label = reply?.label?.startsWith("Subagente") ? "Subagente" : reply?.label;
  byId("replyPreviewText").textContent = reply ? (label ? label + ": " : "") + reply.text : "";
}

export function bindReplyGestures(reply) {
  const chat = byId("chat");
  let drag = null;
  const reset = () => {
    if (!drag) return;
    drag.bubble.style.transition = "transform 180ms ease-out";
    drag.bubble.style.transform = "";
    drag.bubble.classList.remove("replyDragging");
    drag = null;
  };
  chat.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("a,button,input,textarea,pre")) return;
    const bubble = event.target.closest(".message[data-message-id]");
    if (!bubble) return;
    drag = { bubble, id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, active: false };
  });
  chat.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.active && Math.abs(dy) > DIRECTION_THRESHOLD && Math.abs(dy) >= Math.abs(dx)) { reset(); return; }
    if (!drag.active && dx > DIRECTION_THRESHOLD && dx > Math.abs(dy)) {
      drag.active = true;
      drag.bubble.setPointerCapture(event.pointerId);
      drag.bubble.style.transition = "none";
      drag.bubble.classList.add("replyDragging");
    }
    if (!drag.active) return;
    drag.dx = Math.max(0, Math.min(REPLY_MAX_DRAG, dx));
    drag.bubble.style.transform = "translateX(" + drag.dx + "px)";
  });
  chat.addEventListener("pointerup", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const id = drag.dx >= REPLY_THRESHOLD ? drag.bubble.dataset.messageId : "";
    reset();
    if (id) reply(id);
  });
  chat.addEventListener("pointercancel", reset);
  byId("cancelReply").onclick = () => reply("");
}
