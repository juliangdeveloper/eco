import { appendMessage, byId, renderEmpty, renderMessages, renderTodos, updateToolCard } from "./ui.js";

export function createChat({ getPyodide, persist, statsSave, incrementMessages, getSession, setSession }) {
  let sending = false;

  function setSending(value) {
    sending = value;
    byId("send").disabled = value || !getPyodide();
    byId("prompt").disabled = value;
    byId("prompt").placeholder = value ? "Pensando…" : "Escribe un mensaje";
    byId("thinkingBubble")?.remove();
    if (value) {
      const bubble = document.createElement("div");
      bubble.id = "thinkingBubble";
      bubble.className = "message assistant thinkingBubble";
      bubble.setAttribute("role", "status");
      bubble.setAttribute("aria-label", "Pensando");
      const dots = document.createElement("span");
      dots.className = "thinking";
      dots.append(document.createElement("span"), document.createElement("span"), document.createElement("span"));
      bubble.append(dots);
      const chat = byId("chat");
      chat.append(bubble);
      chat.scrollTop = chat.scrollHeight;
    }
  }

  async function send(text) {
    const content = text.trim();
    if (!content || sending || !getPyodide()) {
      return;
    }
    if (!localStorage.getItem("eco.openrouterKey")) {
      byId("settings").showModal();
      return;
    }
    const session = getSession();
    appendMessage("user", content);
    session.messages.push({ role: "user", content });
    incrementMessages();
    statsSave();
    setSending(true);
    try {
      const raw = await getPyodide().globals.get("run_turn")(JSON.stringify({ messages: session.messages, results: session.results || {} }));
      const result = JSON.parse(raw);
      if (Array.isArray(result.messages)) {
        session.messages = result.messages.filter((item, index) => !(index === 0 && item.role === "system"));
      }
      if (result.results && typeof result.results === "object") {
        session.results = result.results;
      }
      setSession(session);
      await persist();
      if (result.error) {
        appendMessage("assistant", "Error: " + result.error);
      } else {
        if (result.compressed) {
          updateToolCard("contexto", "resumido", "Contexto resumido");
        }
        appendMessage("assistant", result.message || "");
      }
    } catch (error) {
      appendMessage("assistant", "No se pudo completar la respuesta: " + error.message);
      await persist();
    } finally {
      setSending(false);
    }
  }

  function loadSession(session) {
    setSession(session);
    if (session.messages.length) {
      renderMessages(session.messages);
    } else {
      renderEmpty(send);
    }
    renderTodos(session.todos || []);
  }

  function currentTodos() {
    return getSession().todos || [];
  }

  async function setTodos(todos) {
    const session = getSession();
    session.todos = todos;
    setSession(session);
    renderTodos(todos);
    await persist();
  }

  return { currentTodos, loadSession, send, setSending, setTodos };
}
