import { forgetDeviceGrants } from "./device-grants.js";
import { all, remove, setting, store } from "./storage.js";
import { timedFetch } from "./network.js";
import { executeDeviceTool } from "./device-runtime.js";

const documents = new Map();
const maxSize = value => new TextEncoder().encode(JSON.stringify(value)).length;
const official = url => url.protocol === "https:" && !url.username && !url.password && ["developer.mozilla.org", "www.w3.org", "w3c.github.io", "webkit.org"].includes(url.hostname);

function deviceId() {
  let id = setting("deviceId");
  if (!id) id = setting("deviceId", crypto.randomUUID());
  return id;
}

export async function readDeviceDocumentation(value) {
  const url = new URL(value);
  if (!official(url)) return { ok: false, error: "Usa una URL oficial de MDN, W3C o WebKit" };
  let target = url.href;
  if (url.hostname === "developer.mozilla.org") {
    const path = url.pathname.split("/docs/")[1];
    if (!path || !/^[A-Za-z0-9_/-]+$/.test(path)) return { ok: false, error: "URL de MDN inválida" };
    target = "https://raw.githubusercontent.com/mdn/content/main/files/en-us/" + path.toLowerCase().replace(/\/$/, "") + "/index.md";
  }
  try {
    const response = await timedFetch(target, { credentials: "omit", referrerPolicy: "no-referrer" });
    if (!response.ok) return { ok: false, error: "No se encontró la documentación oficial", status: response.status };
    const text = await response.text();
    documents.set(url.href, Date.now());
    return { ok: true, untrusted: true, url: url.href, source: target, text: text.slice(0, 24000), truncated: text.length > 24000 };
  } catch { return { ok: false, error: "El sitio no permite leer esta página desde el navegador (CORS o red). Prueba la documentación equivalente en MDN.", url: url.href }; }
}

function validateSchema(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || depth > 8) throw new Error("Esquema inválido");
  const supported = new Set(["type", "description", "properties", "required", "additionalProperties", "items", "enum", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "default", "title"]);
  for (const key of Object.keys(schema)) if (!supported.has(key)) throw new Error("Campo de esquema no soportado: " + key);
  if (!["object", "array", "string", "number", "integer", "boolean", "null"].includes(schema.type)) throw new Error("Cada esquema necesita un type válido");
  if (schema.properties) for (const [key, value] of Object.entries(schema.properties)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Propiedad no permitida");
    validateSchema(value, depth + 1);
  }
  if (schema.required && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== "string" || !schema.properties?.[key]))) throw new Error("required inválido");
  if (schema.items) validateSchema(schema.items, depth + 1);
  for (const name of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]) {
    if (schema[name] !== undefined && (typeof schema[name] !== "number" || !Number.isFinite(schema[name]) || /Length|Items/.test(name) && (!Number.isInteger(schema[name]) || schema[name] < 0))) throw new Error("Límite inválido: " + name);
  }
  if (schema.enum && !Array.isArray(schema.enum)) throw new Error("enum inválido");
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") throw new Error("additionalProperties debe ser booleano");
}

export function validateDeviceParams(value, schema, depth = 0) {
  if (depth > 10) throw new Error("Parámetros demasiado profundos");
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (schema.type === "integer" ? !Number.isInteger(value) : actual !== schema.type) throw new Error("Tipo de parámetro incorrecto");
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) throw new Error("Valor fuera de enum");
  if (actual === "object") {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw new Error("Falta el parámetro " + key);
    for (const [key, item] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Propiedad no permitida");
      if (schema.properties?.[key]) validateDeviceParams(item, schema.properties[key], depth + 1);
      else if (schema.additionalProperties === false) throw new Error("Parámetro no permitido: " + key);
    }
  }
  if (actual === "array") {
    if (value.length < (schema.minItems || 0) || value.length > (schema.maxItems ?? 10000)) throw new Error("Tamaño de lista inválido");
    if (schema.items) value.forEach(item => validateDeviceParams(item, schema.items, depth + 1));
  }
  if (actual === "string" && (value.length < (schema.minLength || 0) || value.length > (schema.maxLength ?? 65536))) throw new Error("Longitud inválida");
  if (actual === "number" && (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) throw new Error("Número fuera de rango");
}

export async function listDeviceTools(name) {
  const rows = (await all("deviceTools")).filter(row => row.device === deviceId());
  return rows.filter(row => !name || row.name === name).map(row => name ? row : { name: row.name, description: row.description, parameters: row.parameters, docs: row.docs });
}

export async function manageDeviceTool(args) {
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(args.name || "")) throw new Error("Nombre inválido; usa letras minúsculas, números y guiones bajos");
  const id = deviceId() + ":" + args.name;
  const previous = (await listDeviceTools(args.name))[0];
  if (args.action === "borrar") { forgetDeviceGrants(args.name); await remove("deviceTools", id); return { ok: true, name: args.name }; }
  if (!["crear", "actualizar"].includes(args.action)) throw new Error("Acción inválida");
  if (args.action === "crear" && previous) throw new Error("La herramienta ya existe; usa actualizar");
  if (args.action === "actualizar" && !previous) throw new Error("Herramienta no encontrada");
  if (!previous && (await listDeviceTools()).length >= 24) throw new Error("Límite de 24 herramientas por dispositivo");
  if (!args.description || args.description.length > 600 || !args.code || args.code.length > 16000) throw new Error("Descripción o código fuera de límite");
  if (!Array.isArray(args.docs) || !args.docs.length || args.docs.length > 5 || args.docs.some(url => !documents.has(url))) throw new Error("Lee primero las URLs oficiales con documentacion_dispositivo_leer; inclúyelas en docs");
  if (maxSize(args.parameters) > 12000 || args.parameters?.type !== "object") throw new Error("El esquema raíz debe ser object y caber en 12 kB");
  validateSchema(args.parameters);
  const tool = { id, device: deviceId(), name: args.name, description: args.description, parameters: args.parameters, code: args.code, docs: args.docs, timeout_ms: Math.min(60000, Math.max(1000, Number(args.timeout_ms) || 30000)), updatedAt: Date.now() };
  await store("deviceTools", tool);
  if (previous && previous.code !== tool.code) forgetDeviceGrants(tool.name);
  return { ok: true, name: tool.name, nativeTool: "dispositivo_" + tool.name };
}

export async function callDeviceTool(name, params, signal) {
  try {
    const tool = (await listDeviceTools(name))[0];
    if (!tool) return { ok: false, error: "Herramienta no encontrada en este dispositivo" };
    if (maxSize(params) > 65536) throw new Error("Parámetros mayores de 64 KiB");
    validateDeviceParams(params, tool.parameters);
    return await executeDeviceTool(tool, params, signal);
  } catch (error) { return { ok: false, untrusted: true, error: String(error.message || error) }; }
}
