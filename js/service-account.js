export const SERVICE_ACCOUNT_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const SERVICE_ACCOUNT_SCOPES = Object.freeze(["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/spreadsheets"]);
const JWT_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const TOKEN_LIFETIME_S = 3600;
const PEM_PATTERN = /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/;
const SIGN_ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };

function httpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function parseServiceAccount(text) {
  let data;
  try {
    data = typeof text === "string" ? JSON.parse(text) : text;
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || data.type !== "service_account") return null;
  const clientEmail = String(data.client_email || "").trim();
  const privateKey = String(data.private_key || "");
  const tokenUri = String(data.token_uri || SERVICE_ACCOUNT_TOKEN_URL).trim();
  if (!clientEmail.includes("@") || !PEM_PATTERN.test(privateKey) || !httpsUrl(tokenUri)) return null;
  return { client_email: clientEmail, private_key: privateKey, token_uri: tokenUri };
}

function base64UrlBytes(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlJson(value) {
  return base64UrlBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function pemBytes(pem) {
  const body = PEM_PATTERN.exec(pem)[1].replace(/\\n/g, "").replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function signServiceJwt(account, scopes = SERVICE_ACCOUNT_SCOPES, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = { iss: account.client_email, scope: [...scopes].join(" "), aud: account.token_uri || SERVICE_ACCOUNT_TOKEN_URL, iat, exp: iat + TOKEN_LIFETIME_S };
  const input = base64UrlJson(header) + "." + base64UrlJson(claims);
  const key = await crypto.subtle.importKey("pkcs8", pemBytes(account.private_key), SIGN_ALGORITHM, false, ["sign"]);
  const signature = await crypto.subtle.sign(SIGN_ALGORITHM.name, key, new TextEncoder().encode(input));
  return input + "." + base64UrlBytes(signature);
}

export async function mintServiceToken(account, scopes, fetcher) {
  const assertion = await signServiceJwt(account, scopes && scopes.length ? scopes : SERVICE_ACCOUNT_SCOPES);
  const body = new URLSearchParams({ grant_type: JWT_GRANT, assertion });
  const response = await fetcher(account.token_uri || SERVICE_ACCOUNT_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!response.ok) return null;
  const data = await response.json();
  if (!data?.access_token) return null;
  return { access_token: data.access_token, expires_at: Date.now() + Number(data.expires_in || TOKEN_LIFETIME_S) * 1000 };
}
