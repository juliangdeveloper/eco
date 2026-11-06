import { setting } from "./storage.js";
import { byId } from "./ui.js";

export const GIS_URL = "https://accounts.google.com/gsi/client";
export const GMAIL_SCOPES = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose";

let gisPromise;

function tokenValid() {
  return Number(sessionStorage.getItem("eco.gmailExpires") || 0) > Date.now();
}

export function gmailToken() {
  return tokenValid() ? sessionStorage.getItem("eco.gmailToken") || "" : "";
}

export function updateGmailStatus() {
  byId("gmailStatus").textContent = gmailToken() ? "Gmail conectado" : "Sin conectar";
}

function loadGis() {
  if (window.google?.accounts?.oauth2) {
    return Promise.resolve();
  }
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = GIS_URL;
      script.onload = resolve;
      script.onerror = reject;
      document.head.append(script);
    });
  }
  return gisPromise;
}

export async function connectGmail() {
  const clientId = setting("googleClientId").trim();
  if (!clientId) {
    byId("gmailStatus").textContent = "Agrega tu Client ID de Google.";
    return;
  }
  await loadGis();
  await new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: GMAIL_SCOPES,
      callback: (response) => {
        if (response.error) {
          reject(new Error(response.error));
          return;
        }
        sessionStorage.setItem("eco.gmailToken", response.access_token);
        sessionStorage.setItem("eco.gmailExpires", String(Date.now() + Number(response.expires_in || 0) * 1000));
        updateGmailStatus();
        resolve();
      }
    });
    client.requestAccessToken({ prompt: "" });
  });
}
