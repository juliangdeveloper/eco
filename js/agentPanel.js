import { all, remove, setting, store } from "./storage.js";
import { byId, element } from "./ui.js";

const TODO_STATUS_LABELS = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Done",
  cancelled: "Cancelled"
};

export function createAgentPanel({ getTodos }) {
  let activeTab = "memory";

  async function render() {
    const content = byId("agentContent");
    content.replaceChildren();
    if (activeTab === "memory") {
      renderMemory(content);
    }
    if (activeTab === "todos") {
      renderTodos(content);
    }
    if (activeTab === "skills") {
      await renderSkills(content);
    }
  }

  function renderMemory(content) {
    for (const [key, label] of [["memory", "Memory"], ["user", "Profile"]]) {
      const area = document.createElement("textarea");
      area.className = "memoryEditor";
      area.placeholder = label;
      area.value = setting(key);
      area.oninput = () => setting(key, area.value);
      content.append(area);
    }
  }

  function renderTodos(content) {
    const todos = getTodos();
    if (!todos.length) {
      content.append(element("p", "No tasks."));
      return;
    }
    for (const todo of todos) {
      content.append(element("div", (TODO_STATUS_LABELS[todo.status] || todo.status) + " · " + todo.content, "todo"));
    }
  }

  async function renderSkills(content) {
    const form = document.createElement("form");
    form.className = "skillForm";
    const name = input("Name", "name");
    const description = input("Description", "description");
    const body = document.createElement("textarea");
    body.name = "content";
    body.placeholder = "Content";
    const save = element("button", "Save");
    save.type = "submit";
    form.append(name, description, body, save);
    form.onsubmit = async (event) => {
      event.preventDefault();
      const id = name.value.trim();
      if (!id) {
        return;
      }
      await store("skills", { id, description: description.value.trim(), content: body.value });
      await render();
    };
    content.append(form);
    for (const skill of await all("skills")) {
      const row = element("div", "", "skill");
      const head = element("div", "", "skillHead");
      const title = element("strong", skill.id);
      const actions = element("div");
      const view = element("button", "View");
      const removeButton = element("button", "Delete");
      view.type = "button";
      removeButton.type = "button";
      view.onclick = () => alert(skill.description + "\n\n" + skill.content);
      removeButton.onclick = async () => {
        await remove("skills", skill.id);
        await render();
      };
      actions.append(view, removeButton);
      head.append(title, actions);
      row.append(head, element("p", skill.description));
      content.append(row);
    }
  }

  function input(placeholder, name) {
    const field = document.createElement("input");
    field.name = name;
    field.placeholder = placeholder;
    return field;
  }

  byId("agentButton").onclick = async () => {
    byId("agentPanel").hidden = false;
    await render();
  };
  document.querySelectorAll(".tabs button").forEach((button) => {
    button.onclick = async () => {
      activeTab = button.dataset.tab;
      document.querySelectorAll(".tabs button").forEach((item) => item.classList.toggle("active", item === button));
      await render();
    };
  });
  document.querySelector('.tabs button[data-tab="memory"]').classList.add("active");
  return { render };
}
