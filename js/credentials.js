import { connectorStatus, redirectUri, saveManualCredential, startOAuth, STATUS } from "./connectors.js";

const ERROR_TEXT = "No se pudo conectar. Inténtalo de nuevo.";
const CONNECTED_TEXT = "Conectado";
const SKIPPED_TEXT = "Sin conectar";
const EXPIRED_TEXT = "Tu acceso expiró y no se pudo renovar solo. Inicia sesión para seguir.";
const GOOGLE_HOST = "accounts.google.com";
const COPY_DONE_MS = 1500;
const GUIDE_TITLE = "¿Cómo obtengo un Client ID?";
const GOOGLE_CONSOLE = "https://console.cloud.google.com";
const GOOGLE_API_HOST_SUFFIX = ".googleapis.com";
const GOOGLE_STEPS = [
  ["Crea un ", ["proyecto nuevo", GOOGLE_CONSOLE + "/projectcreate"], " en Google Cloud."],
  ["Habilita la ", ["API del servicio", "API"], " en la biblioteca de APIs."],
  ["Configura la ", ["Plataforma de autenticación de Google", GOOGLE_CONSOLE + "/auth/overview"], " y elige Externo."],
  ["En ", ["Público", GOOGLE_CONSOLE + "/auth/audience"], ", agrégate como usuario de prueba."],
  ["En ", ["Clientes", GOOGLE_CONSOLE + "/auth/clients"], ", crea un cliente de tipo «Aplicación web»."],
  ["Agrega estos dos valores y copia el Client ID que te entrega:"]
];
const GENERIC_STEPS = [
  ["Entra a la ", ["consola de desarrolladores del servicio", "DEVELOPER"], " y crea una aplicación OAuth."],
  ["Elige el tipo «aplicación web» o «cliente público»."],
  ["Agrega estos dos valores y copia el Client ID que te entrega:"]
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

function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function googleLibrary(connector) {
  const library = GOOGLE_CONSOLE + "/apis/library";
  try {
    const host = new URL(connector.base_url).host;
    return host.endsWith(GOOGLE_API_HOST_SUFFIX) ? library + "/" + host : library;
  } catch {
    return library;
  }
}

function link(text, href) {
  if (!href) {
    return text;
  }
  const anchor = create("a", text);
  anchor.href = href;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  return anchor;
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
  const targets = { API: googleLibrary(connector), DEVELOPER: httpsUrl(connector.auth.developer_url) };
  for (const step of host === GOOGLE_HOST ? GOOGLE_STEPS : GENERIC_STEPS) {
    const item = document.createElement("li");
    for (const part of step) {
      item.append(Array.isArray(part) ? link(part[0], targets[part[1]] ?? part[1]) : part);
    }
    list.append(item);
  }
  details.append(list, copyRow("Origen de JavaScript autorizado", location.origin), copyRow("URI de redireccionamiento", redirectUri()));
  return details;
}

function scrollChat(chat) {
  chat.scrollTop = chat.scrollHeight;
}

export function showCredentialCard(connector, options = {}) {
  const chat = document.getElementById("chat");
  document.getElementById("empty")?.remove();
  const card = create("div", "", "credentialCard");
  card.dataset.connector = connector.id;
  const form = document.createElement("form");
  const title = create("strong", "Iniciar sesión en " + connector.name);
  const note = create("small", options.expired ? EXPIRED_TEXT : "Tus datos se guardan cifrados en este navegador.");
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
