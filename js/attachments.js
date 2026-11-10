import { all, get, remove, store } from "./storage.js";
import { connectorFetch } from "./connectors.js";
import { byId, element, scrollChat } from "./ui.js";

const STORE = "attachments";
const IMAGE = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/;
const REF = /^img-[0-9a-f]{10}$/;
const FOLDER = /^[A-Za-z0-9_-]{1,200}$/;
const MAX_IMAGES = 8;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_PARENTS = 10;
const MAX_NAME = 200;
const DRIVE_CONNECTOR = "google-drive-archivos";
const UPLOAD_PATH = "/upload/drive/v3/files";
const IMAGE_KEYS = new Set(["dataUrl", "dataURL", "data_url", "image", "src"]);
const EXTENSIONS = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" };
const urls = new Map();

export const hasImages = raw => typeof raw === "string" && raw.includes("data:image/");

function decode(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function dimensions(blob, width, height) {
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) return [Math.round(width), Math.round(height)];
  try {
    const bitmap = await createImageBitmap(blob);
    const size = [bitmap.width, bitmap.height];
    bitmap.close?.();
    return size;
  } catch { return [0, 0]; }
}

export async function keepImages(value, context) {
  const saved = [];
  const save = async (text, width, height) => {
    const match = text.match(IMAGE);
    const bytes = decode(match[2]);
    if (saved.length >= MAX_IMAGES || bytes.length > MAX_BYTES) return { omitted: "Image not kept: too many or too large", mimeType: match[1], bytes: bytes.length };
    const [w, h] = await dimensions(new Blob([bytes], { type: match[1] }), Number(width), Number(height));
    const record = { id: "img-" + crypto.randomUUID().replaceAll("-", "").slice(0, 10), session: String(context.session || ""), job: String(context.job || ""), tool: String(context.tool || ""), anchor: String(context.anchor || ""), mimeType: match[1], width: w, height: h, bytes: bytes.length, data: bytes.buffer, createdAt: Date.now() };
    await store(STORE, record);
    saved.push(record);
    return { ref: record.id, mimeType: record.mimeType, width: w, height: h, bytes: record.bytes };
  };
  const isImage = item => typeof item === "string" && item.startsWith("data:image/") && IMAGE.test(item);
  const walk = async node => {
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index++) node[index] = isImage(node[index]) ? await save(node[index]) : await walk(node[index]);
      return node;
    }
    if (!node || typeof node !== "object") return node;
    for (const key of Object.keys(node)) {
      const item = node[key];
      if (!isImage(item)) { node[key] = await walk(item); continue; }
      const summary = await save(item, node.width, node.height);
      if (IMAGE_KEYS.has(key) && node.ref === undefined && summary.ref) {
        delete node[key];
        Object.assign(node, { ref: summary.ref, mimeType: summary.mimeType, width: summary.width, height: summary.height, bytes: summary.bytes });
      } else node[key] = summary;
    }
    return node;
  };
  const result = isImage(value) ? await save(value) : await walk(value);
  return { value: result, saved };
}

function objectUrl(record) {
  if (!urls.has(record.id)) urls.set(record.id, URL.createObjectURL(new Blob([record.data], { type: record.mimeType })));
  return urls.get(record.id);
}

function figure(record) {
  const box = element("figure", "", "toolImage");
  box.dataset.ref = record.id;
  if (record.job) box.dataset.subagentId = record.job;
  const image = document.createElement("img");
  image.src = objectUrl(record);
  image.alt = "Image from " + (record.tool || "a tool");
  image.decoding = "async";
  if (record.width && record.height) { image.width = record.width; image.height = record.height; }
  box.append(image, element("figcaption", record.id + (record.width ? " · " + record.width + "×" + record.height : "")));
  return box;
}

export function showImages(records) {
  const chat = byId("chat");
  for (const record of records) if (!chat.querySelector('[data-ref="' + CSS.escape(record.id) + '"]')) chat.append(figure(record));
  if (records.length) scrollChat();
}

export async function sessionImages(sessionId) {
  return (await all(STORE)).filter(record => record.session === sessionId).sort((a, b) => a.createdAt - b.createdAt);
}

export async function renderSessionImages(sessionId, current) {
  const records = await sessionImages(sessionId).catch(() => []);
  if (!current()) return;
  const chat = byId("chat");
  for (const record of records) {
    if (chat.querySelector('[data-ref="' + CSS.escape(record.id) + '"]')) continue;
    const anchor = record.anchor && chat.querySelector('[data-message-id="' + CSS.escape(record.anchor) + '"]');
    if (!anchor) { chat.append(figure(record)); continue; }
    let point = anchor;
    while (point.nextElementSibling?.classList.contains("toolImage")) point = point.nextElementSibling;
    point.after(figure(record));
  }
}

export async function pruneAttachments(sessionIds) {
  const keep = new Set(sessionIds);
  for (const record of await all(STORE)) if (!keep.has(record.session)) { await remove(STORE, record.id); urls.delete(record.id); }
}

function cleanName(value, record) {
  const name = String(value ?? "").replace(/[\u0000-\u001f\u007f/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  return name || record.id + (EXTENSIONS[record.mimeType] || "");
}

export async function uploadAttachment(args, sessionId) {
  const ref = String(args?.ref || "");
  if (!REF.test(ref)) return { error: "ref must be an attachment ref like img-0123456789." };
  const record = await get(STORE, ref).catch(() => null);
  if (!record || record.session !== sessionId) return { error: "No attachment with that ref in this conversation." };
  const parents = args?.parents === undefined ? [] : args.parents;
  if (!Array.isArray(parents) || parents.length > MAX_PARENTS || !parents.every(item => typeof item === "string" && FOLDER.test(item))) return { error: "parents must be a list of up to " + MAX_PARENTS + " Drive folder ids." };
  const metadata = { name: cleanName(args?.name, record), mimeType: record.mimeType, ...(parents.length ? { parents } : {}) };
  const boundary = "eco-" + crypto.randomUUID();
  const body = new Blob(["--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify(metadata) + "\r\n--" + boundary + "\r\nContent-Type: " + record.mimeType + "\r\n\r\n", record.data, "\r\n--" + boundary + "--\r\n"], { type: "multipart/related; boundary=" + boundary });
  const response = await connectorFetch(DRIVE_CONNECTOR, "POST", UPLOAD_PATH, { uploadType: "multipart", fields: "id,name,webViewLink" }, null, false, undefined, { raw: { body, type: "multipart/related; boundary=" + boundary } });
  if (response.error === "Connector not found") return { error: "Google Drive isn't connected. Connect the Google Drive memory first." };
  if (!response.ok) return { error: response.error || "Drive did not accept the upload.", status: response.status, api_message: typeof response.data === "object" ? response.data?.error?.message || "" : "" };
  const data = response.data || {};
  return { ok: true, id: String(data.id || ""), name: String(data.name || metadata.name), webViewLink: String(data.webViewLink || ""), ref, contenido_no_confiable: true };
}
