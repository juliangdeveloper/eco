import { connectorStatus, getConnector, listConnectors, openOAuthWindow, redirectUri, saveManualCredential, startOAuth, STATUS } from "./connectors.js";
import { verifyMcp } from "./mcp.js";
import { deleteSecret } from "./vault.js";
import { requestHelp } from "./help.js";

const ERROR_TEXT = "Could not connect. Try again.";
const CONNECTED_TEXT = "Connected";
const REJECTED_TEXT = "The service rejected the token. Check that it is valid and has permissions.";
const MCP_KIND = "mcp";
const SKIPPED_TEXT = "Not connected";
const EXPIRED_TEXT = "Your access expired and could not renew itself. Sign in to continue.";
const GOOGLE_HOST = "accounts.google.com";
const COPY_DONE_MS = 1500;
const GUIDE_TITLE = "How do I get a Client ID?";
const GOOGLE_CONSOLE = "https://console.cloud.google.com";
const GOOGLE_API_HOST_SUFFIX = ".googleapis.com";
const GOOGLE_STEPS = [
  ["Create a ", ["new project", GOOGLE_CONSOLE + "/projectcreate"], " in Google Cloud."],
  ["Enable the ", ["service's API", "API"], " in the API library."],
  ["Set up the ", ["Google Auth Platform", GOOGLE_CONSOLE + "/auth/overview"], " and choose External."],
  ["In ", ["Audience", GOOGLE_CONSOLE + "/auth/audience"], ", add yourself as a test user."],
  ["In ", ["Clients", GOOGLE_CONSOLE + "/auth/clients"], ", create a client of type “Web application”."],
  ["Add these two values and copy the Client ID it gives you:"]
];
const GENERIC_STEPS = [
  ["Go to the ", ["service's developer console", "DEVELOPER"], " and create an OAuth application."],
  ["Choose the “web application” or “public client” type."],
  ["Add these two values and copy the Client ID it gives you:"]
];
const FIELDS = {
  bearer: [{ name: "token", label: "Token", secret: true }],
  api_key: [{ name: "key", label: "API key", secret: true }],
  basic: [
    { name: "username", label: "Username", secret: false },
    { name: "password", label: "Password", secret: true }
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
  const copy = create("button", "Copy");
  copy.type = "button";
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(value);
      copy.textContent = "Copied";
    } catch {
      copy.textContent = "Select and copy";
    }
    setTimeout(() => {
      copy.textContent = "Copy";
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
  if (connector.id === "eco-memory-drive") {
    const extra = create("li", "Also enable the ");
    extra.append(link("Google Drive API", GOOGLE_CONSOLE + "/apis/library/drive.googleapis.com"), ". In Data Access add the spreadsheets and drive scopes; they give access to your sheets and your whole Drive.");
    list.append(extra);
  }
  details.append(list, copyRow("Authorized JavaScript origin", location.origin), copyRow("Redirect URI", redirectUri()));
  return details;
}

function scrollChat(chat) {
  chat.scrollTop = chat.scrollHeight;
}

function renderCredentialCard(connector, options = {}) {
  const chat = document.getElementById("chat");
  document.getElementById("empty")?.remove();
  const card = create("div", "", "credentialCard");
  card.dataset.connector = connector.id;
  const form = document.createElement("form");
  const title = create("strong", "Sign in to " + connector.name);
  const note = create("small", options.expired ? EXPIRED_TEXT : "Your data is stored encrypted in this browser.");
  const error = create("p", "", "credentialError");
  error.hidden = true;
  const inputs = [];
  form.append(title, note);
  const type = connector.auth.type;
  if (type === "oauth2") {
    if (!connector.auth.client_id) {
      const client = field({ name: "client_id", label: "OAuth Client ID", secret: false });
      inputs.push(client.input);
      const hint = create("small", "Use the Client ID of your own OAuth app.");
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
  const skip = create("button", "Not now");
  skip.type = "button";
  const submit = create("button", type === "oauth2" ? "Sign in" : "Save", "primary");
  submit.type = "submit";
  actions.append(skip, submit);
  form.append(error, actions);
  card.append(form);
  chat.append(card);
  scrollChat(chat);
  inputs[0]?.focus();

  return new Promise((resolve) => {
    let finished = false;
    let activePopup = null;
    const done = (text, status) => {
      if (finished) return;
      finished = true;
      activePopup?.close();
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
      const popup = type === "oauth2" ? openOAuthWindow() : null;
      activePopup = popup;
      submit.disabled = true;
      error.hidden = true;
      const values = Object.fromEntries(inputs.map((input) => [input.name, input.value.trim()]));
      let ok = false;
      let rejected = false;
      try {
        ok = type === "oauth2"
          ? await startOAuth(connector.id, values.client_id || connector.auth.client_id, popup)
          : await saveManualCredential(connector.id, values);
        if (ok && connector.kind === MCP_KIND) {
          const check = await verifyMcp(connector.id);
          if (!check.ok) {
            await deleteSecret(connector.id);
            ok = false;
            rejected = Boolean(check.auth_required);
          }
        }
      } catch {
        ok = false;
      }
      if (finished) return;
      submit.disabled = false;
      if (ok) {
        done(CONNECTED_TEXT, STATUS.CONNECTED);
        return;
      }
      error.textContent = rejected ? REJECTED_TEXT : ERROR_TEXT;
      error.hidden = false;
    };
  });
}

const credentialCards = new Map();
let reconnecting = false;

export async function showCredentialCard(connector, options = {}) {
  if (connector.auth.secret_of) connector = await getConnector(connector.auth.secret_of) || connector;
  if (credentialCards.has(connector.id)) return credentialCards.get(connector.id);
  const pending = renderCredentialCard(connector, options).finally(() => credentialCards.delete(connector.id));
  credentialCards.set(connector.id, pending);
  return pending;
}

export async function renderReconnectNotice() {
  if (reconnecting) return;
  const notice = document.getElementById("reconnectNotice");
  const text = document.getElementById("reconnectText");
  const button = document.getElementById("reconnectButton");
  let expired = null;
  for (const connector of await listConnectors()) {
    if (connector.auth.type !== "oauth2" || connector.auth.secret_of || !connector.auth.client_id) continue;
    if (await connectorStatus(connector.id) !== STATUS.CONNECTED) { expired = connector; break; }
  }
  notice.hidden = !expired;
  if (!expired) return;
  text.textContent = expired.id === "eco-memory-drive" ? "Drive offline · local memory" : expired.name + " offline";
  requestHelp(text.textContent);
  button.disabled = false;
  button.textContent = "Reconnect";
  button.onclick = async () => {
    const popup = openOAuthWindow();
    reconnecting = true;
    button.disabled = true;
    try {
      const ok = await startOAuth(expired.id, expired.auth.client_id, popup);
      if (ok) notice.hidden = true;
      else { text.textContent = "Could not reconnect. You can keep using Eco and try again."; requestHelp(text.textContent); }
    } catch {
      text.textContent = "Could not save the access. Close other Eco tabs and try again."; requestHelp(text.textContent);
    } finally {
      reconnecting = false;
      button.disabled = false;
      window.dispatchEvent(new Event("eco-reconnect-finished"));
    }
  };
}
