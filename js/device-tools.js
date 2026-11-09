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
  if (!official(url)) return { ok: false, error: "Use an official MDN, W3C or WebKit URL" };
  let target = url.href;
  if (url.hostname === "developer.mozilla.org") {
    const path = url.pathname.split("/docs/")[1];
    if (!path || !/^[A-Za-z0-9_/-]+$/.test(path)) return { ok: false, error: "Invalid MDN URL" };
    target = "https://raw.githubusercontent.com/mdn/content/main/files/en-us/" + path.toLowerCase().replace(/\/$/, "") + "/index.md";
  }
  try {
    const response = await timedFetch(target, { credentials: "omit", referrerPolicy: "no-referrer" });
    if (!response.ok) return { ok: false, error: "The official documentation was not found", status: response.status };
    const text = await response.text();
    documents.set(url.href, Date.now());
    return { ok: true, untrusted: true, url: url.href, source: target, text: text.slice(0, 24000), truncated: text.length > 24000 };
  } catch { return { ok: false, error: "The site does not allow reading this page from the browser (CORS or network). Try the equivalent documentation on MDN.", url: url.href }; }
}

function validateSchema(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || depth > 8) throw new Error("Invalid schema");
  const supported = new Set(["type", "description", "properties", "required", "additionalProperties", "items", "enum", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "default", "title"]);
  for (const key of Object.keys(schema)) if (!supported.has(key)) throw new Error("Unsupported schema field: " + key);
  if (!["object", "array", "string", "number", "integer", "boolean", "null"].includes(schema.type)) throw new Error("Each schema needs a valid type");
  if (schema.properties) for (const [key, value] of Object.entries(schema.properties)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Property not allowed");
    validateSchema(value, depth + 1);
  }
  if (schema.required && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== "string" || !schema.properties?.[key]))) throw new Error("Invalid required");
  if (schema.items) validateSchema(schema.items, depth + 1);
  for (const name of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]) {
    if (schema[name] !== undefined && (typeof schema[name] !== "number" || !Number.isFinite(schema[name]) || /Length|Items/.test(name) && (!Number.isInteger(schema[name]) || schema[name] < 0))) throw new Error("Invalid limit: " + name);
  }
  if (schema.enum && !Array.isArray(schema.enum)) throw new Error("Invalid enum");
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") throw new Error("additionalProperties must be a boolean");
}

export function validateDeviceParams(value, schema, depth = 0) {
  if (depth > 10) throw new Error("Parameters nested too deeply");
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (schema.type === "integer" ? !Number.isInteger(value) : actual !== schema.type) throw new Error("Wrong parameter type");
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) throw new Error("Value not in enum");
  if (actual === "object") {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw new Error("Missing parameter " + key);
    for (const [key, item] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Property not allowed");
      if (schema.properties?.[key]) validateDeviceParams(item, schema.properties[key], depth + 1);
      else if (schema.additionalProperties === false) throw new Error("Parameter not allowed: " + key);
    }
  }
  if (actual === "array") {
    if (value.length < (schema.minItems || 0) || value.length > (schema.maxItems ?? 10000)) throw new Error("Invalid list size");
    if (schema.items) value.forEach(item => validateDeviceParams(item, schema.items, depth + 1));
  }
  if (actual === "string" && (value.length < (schema.minLength || 0) || value.length > (schema.maxLength ?? 65536))) throw new Error("Invalid length");
  if (actual === "number" && (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) throw new Error("Number out of range");
}

export async function listDeviceTools(name) {
  const rows = (await all("deviceTools")).filter(row => row.device === deviceId());
  return rows.filter(row => !name || row.name === name).map(row => name ? row : { name: row.name, description: row.description, parameters: row.parameters, docs: row.docs });
}

export async function manageDeviceTool(args) {
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(args.name || "")) throw new Error("Invalid name; use lowercase letters, numbers and underscores");
  const id = deviceId() + ":" + args.name;
  const previous = (await listDeviceTools(args.name))[0];
  if (args.action === "borrar") { forgetDeviceGrants(args.name); await remove("deviceTools", id); return { ok: true, name: args.name }; }
  if (!["crear", "actualizar"].includes(args.action)) throw new Error("Invalid action");
  if (args.action === "crear" && previous) throw new Error("The tool already exists; use actualizar");
  if (args.action === "actualizar" && !previous) throw new Error("Tool not found");
  if (!previous && (await listDeviceTools()).length >= 24) throw new Error("Limit of 24 tools per device");
  if (!args.description || args.description.length > 600 || !args.code || args.code.length > 16000) throw new Error("Description or code over the limit");
  if (!Array.isArray(args.docs) || !args.docs.length || args.docs.length > 5 || args.docs.some(url => !documents.has(url))) throw new Error("First read the official URLs with documentacion_dispositivo_leer; include them in docs");
  if (maxSize(args.parameters) > 12000 || args.parameters?.type !== "object") throw new Error("The root schema must be an object and fit in 12 kB");
  validateSchema(args.parameters);
  const tool = { id, device: deviceId(), name: args.name, description: args.description, parameters: args.parameters, code: args.code, docs: args.docs, timeout_ms: Math.min(60000, Math.max(1000, Number(args.timeout_ms) || 30000)), updatedAt: Date.now() };
  await store("deviceTools", tool);
  if (previous && previous.code !== tool.code) forgetDeviceGrants(tool.name);
  return { ok: true, name: tool.name, nativeTool: "dispositivo_" + tool.name };
}

export async function callDeviceTool(name, params, signal) {
  try {
    const tool = (await listDeviceTools(name))[0];
    if (!tool) return { ok: false, error: "Tool not found on this device" };
    if (maxSize(params) > 65536) throw new Error("Parameters larger than 64 KiB");
    validateDeviceParams(params, tool.parameters);
    return await executeDeviceTool(tool, params, signal);
  } catch (error) { return { ok: false, untrusted: true, error: String(error.message || error) }; }
}
