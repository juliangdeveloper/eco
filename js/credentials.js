import { connectorStatus, redirectUri, saveManualCredential, startOAuth, STATUS } from "./connectors.js";

const ERROR_TEXT = "No se pudo conectar. Inténtalo de nuevo.";
const CONNECTED_TEXT = "Conectado";
const SKIPPED_TEXT = "Sin conectar";
const GOOGLE_HOST = "accounts.google.com";
const COPY_DONE_MS = 1500;
const GUIDE_TITLE = "¿Cómo obtengo un Client ID?";
const GOOGLE_STEPS = [
  "Abre console.cloud.google.com y crea un proyecto nuevo.",
  "En «APIs y servicios › Biblioteca», habilita la API del servicio (por ejemplo Gmail API).",
  "En «Pantalla de consentimiento de OAuth», elige Externo y agrégate como usuario de prueba.",
  "En «Credenciales», crea un «ID de cliente de OAuth» de tipo «Aplicación web».",
  "Agrega estos dos valores y copia el Client ID que te entrega:"
];
const GENERIC_STEPS = [
  "Entra a la consola de desarrolladores del servicio y crea una aplicación OAuth.",
  "Elige el tipo «aplicación web» o «cliente público».",
  "Agrega estos dos valores y copia el Client ID que te entrega:"
];
const FIELDS = {
  bearer: [{ name: "token", label: "Token", secret: true }],
  api_key: [{ name: "key", label: "Clave de API", secret: true }],
  basic: [
    { name: "username", label: "Usuario", secret: false },
    { name: "password", label: "Contraseña", secret: true }
  ]
};

function create(tag, text = "", className = "") {
  const item = document.createElement(tag);
  if (className) {
    item.className = className;
  }
  item.textContent = text;
  return item;
}

function field(spec) {
  const label = create("label", spec.label);
  const input = document.createElement("input");
  input.name = spec.name;
  input.type = spec.secret ? "password" : "text";
  input.autocomplete = spec.secret ? "new-password" : "off";
  input.spellcheck = false;
  label.append(input);
  return { label, input };
}

function copyRow(label, value) {
  const row = create("div", "", "copyRow");
  const text = create("div", "");
  text.append(create("small", label), create("code", value));
  const copy = create("button", "Copiar");
  copy.type = "button";
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(value);
      copy.textContent = "Copiado";
    } catch {
      copy.textContent = "Selecciona y copia";
    }
    setTimeout(() => {
      copy.textContent = "Copiar";
    }, COPY_DONE_MS);
  };
  row.append(text, copy);
  return row;
}

function guide(connector) {
  const details = create("details", "", "oauthGuide");
  details.append(create("summary", GUIDE_TITLE));
  let host = "";
  try {
    host = new URL(connector.auth.authorize_url).host;
  } catch {
    host = "";
  }
  const list = document.createElement("ol");
  for (const step of host === GOOGLE_HOST ? GOOGLE_STEPS : GENERIC_STEPS) {
    list.append(create("li", step));
  }
  details.append(list, copyRow("Origen de JavaScript autorizado", location.origin), copyRow("URI de redireccionamiento", redirectUri()));
  return details;
}

function scrollChat(chat) {
  chat.scrollTop = chat.scrollHeight;
}

export function showCredentialCard(connector) {
  const chat = document.getElementById("chat");
  document.getElementById("empty")?.remove();
  const card = create("div", "", "credentialCard");
  card.dataset.connector = connector.id;
  const form = document.createElement("form");
  const title = create("strong", "Iniciar sesión en " + connector.name);
  const note = create("small", "Tus datos se guardan cifrados en este navegador.");
  const error = create("p", "", "credentialError");
  error.hidden = true;
  const inputs = [];
  form.append(title, note);
  const type = connector.auth.type;
  if (type === "oauth2") {
    if (!connector.auth.client_id) {
      const client = field({ name: "client_id", label: "Client ID de OAuth", secret: false });
      inputs.push(client.input);
      const hint = create("small", "Usa el Client ID de tu propia app OAuth.");
      form.append(client.label, hint, guide(connector));
    }
  } else {
    for (const spec of FIELDS[type] || []) {
      const item = field(spec);
      inputs.push(item.input);
      form.append(item.label);
    }
  }
  const actions = create("div", "", "actions");
  const skip = create("button", "Ahora no");
  skip.type = "button";
  const submit = create("button", type === "oauth2" ? "Iniciar sesión" : "Guardar", "primary");
  submit.type = "submit";
  actions.append(skip, submit);
  form.append(error, actions);
  card.append(form);
  chat.append(card);
  scrollChat(chat);
  inputs[0]?.focus();

  return new Promise((resolve) => {
    const done = (text, status) => {
      for (const input of inputs) {
        input.value = "";
      }
      card.replaceChildren(create("span", connector.name + " · " + text));
      card.classList.add("done");
      resolve(status);
    };
    skip.onclick = () => done(SKIPPED_TEXT, STATUS.DISCONNECTED);
    form.onsubmit = async (event) => {
      event.preventDefault();
      submit.disabled = true;
      error.hidden = true;
      const values = Object.fromEntries(inputs.map((input) => [input.name, input.value.trim()]));
      let ok = false;
      try {
        ok = type === "oauth2"
          ? await startOAuth(connector.id, values.client_id || connector.auth.client_id)
          : await saveManualCredential(connector.id, values);
      } catch {
        ok = false;
      }
      submit.disabled = false;
      if (ok) {
        done(CONNECTED_TEXT, await connectorStatus(connector.id));
        return;
      }
      error.textContent = ERROR_TEXT;
      error.hidden = false;
    };
  });
}
