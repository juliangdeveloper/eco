import { isWiping } from "./security.js";
import { credentialsDue, renewCredential } from "./connectors.js";

const RENEW_CHECK_MS = 60000;
const RENEW_AHEAD_MS = 300000;

let running = false;

async function renewDue(onChange) {
  if (isWiping() || running || !navigator.onLine) {
    return;
  }
  running = true;
  try {
    const due = await credentialsDue(RENEW_AHEAD_MS);
    for (const id of due) {
      await renewCredential(id);
    }
    if (due.length) {
      await onChange();
    }
  } catch {
    return;
  } finally {
    running = false;
  }
}

export function startRenewal(onChange = () => {}) {
  const check = () => renewDue(onChange);
  setInterval(check, RENEW_CHECK_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      check();
    }
  });
  window.addEventListener("online", check);
  window.addEventListener("focus", check);
  check();
  return check;
}
