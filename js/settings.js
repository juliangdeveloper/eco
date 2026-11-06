import { DEFAULT_MODEL } from "./config.js";
import { setting } from "./storage.js";
import { byId } from "./ui.js";
import { connectGmail, updateGmailStatus } from "./gmail.js";

const TEXT_SETTINGS = ["openrouterKey", "model", "githubToken", "googleClientId"];
const TOGGLE_SETTINGS = ["githubEnabled", "gmailEnabled"];

export function bindSettings() {
  for (const id of TEXT_SETTINGS) {
    const field = byId(id);
    field.value = setting(id) || (id === "model" ? DEFAULT_MODEL : "");
    field.oninput = () => {
      setting(id, field.value);
      updateNotice();
    };
  }
  for (const id of TOGGLE_SETTINGS) {
    const field = byId(id);
    field.checked = setting(id) !== "false";
    field.oninput = () => setting(id, String(field.checked));
  }
  byId("settingsButton").onclick = () => {
    updateGmailStatus();
    byId("settings").showModal();
  };
  document.querySelectorAll("[data-open-settings]").forEach((button) => {
    button.onclick = () => byId("settings").showModal();
  });
  byId("gmailConnect").onclick = async () => {
    try {
      await connectGmail();
    } catch (error) {
      byId("gmailStatus").textContent = "No se pudo conectar Gmail.";
    }
  };
  byId("clearData").onclick = () => {
    if (window.confirm("¿Borrar los datos locales?")) {
      Object.keys(localStorage)
        .filter((key) => key.startsWith("eco."))
        .forEach((key) => localStorage.removeItem(key));
      indexedDB.deleteDatabase("eco");
      sessionStorage.removeItem("eco.gmailToken");
      sessionStorage.removeItem("eco.gmailExpires");
      location.reload();
    }
  };
  updateNotice();
  updateGmailStatus();
}

export function updateNotice() {
  byId("notice").hidden = Boolean(setting("openrouterKey"));
}
