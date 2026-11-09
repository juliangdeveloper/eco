import { connectorFetch, connectorVisualization, getConnector } from "./connectors.js";
import { callMcpTool } from "./mcp.js";
import { DriveMemory } from "./memory-drive.js";
import { DatabaseMemory, SupabaseMemory } from "./memory-database.js";
import { ObsidianMemory } from "./memory-obsidian.js";
import { MEMORY_COLUMNS, AGENT_COLUMNS, ROUTINE_COLUMNS, MEMORY_TABLES } from "./memory-protocol.js";
import { isWiping, reportMemoryConnection } from "./security.js";

export const MEMORY_BACKENDS = Object.freeze({
  "google-drive": { name: "Persistent memory in Google Drive", skill: "assets/skills/memoria-google-drive.txt", create: dependencies => new DriveMemory(dependencies) },
  supabase: { name: "Persistent memory in a database", skill: "assets/skills/memoria-database.txt", create: dependencies => new SupabaseMemory(dependencies) },
  database: { name: "Persistent memory in a database", skill: "assets/skills/memoria-database.txt", create: dependencies => new DatabaseMemory(dependencies) },
  obsidian: { name: "Persistent memory in Obsidian", skill: "assets/skills/memoria-obsidian.txt", create: dependencies => new ObsidianMemory(dependencies) }
});
export const OBSIDIAN_ACTIONS = Object.freeze(["list", "read", "write", "delete"]);
const text = value => "'" + String(value ?? "").replaceAll("'", "''") + "'";
const identifier = value => '"' + value.replaceAll('"', '""') + '"';
const likeText = value => text("%" + String(value).replace(/[\\%_]/g, "\\$&") + "%");
const unpack = value => {
  if (typeof value === "string") value = value.trim() ? JSON.parse(value) : null;
  return value?.rows ?? value?.data ?? value;
};

export function databaseSQL(action, args) {
  const q = identifier;
  if (action === "schema") {
    if (args.stage === "protocol") return "SELECT " + q(args.columns.key) + " AS key," + q(args.columns.value) + " AS value FROM " + q(args.table);
    if (args.stage === "map") return args.exists ? "UPDATE " + q(args.table) + " SET " + q(args.columns.value) + "=" + text(args.value) + " WHERE " + q(args.columns.key) + "='map'" : "INSERT INTO " + q(args.table) + " (" + q(args.columns.key) + "," + q(args.columns.value) + ") VALUES ('map'," + text(args.value) + ")";
    if (args.stage === "add") return args.additions.map(item => {
      const definition = key => q(key) + (key === "date" ? " TIMESTAMP DEFAULT CURRENT_TIMESTAMP" : " TEXT" + (["id", "key"].includes(key) ? " PRIMARY KEY" : " DEFAULT ''"));
      return item.create ? "CREATE TABLE " + q(item.name) + " (" + item.columns.map(definition).join(",") + ")" : item.columns.map(key => "ALTER TABLE " + q(item.name) + " ADD COLUMN " + definition(key)).join(";");
    }).join(";");
    return "SELECT table_name,column_name,ordinal_position FROM information_schema.columns WHERE table_schema=CURRENT_SCHEMA ORDER BY table_name,ordinal_position";
  }
  const logical = args.logical || (["agents", "routines"].includes(action) ? action : action === "redact" ? "messages" : args.table);
  if (!MEMORY_TABLES.includes(logical)) throw new Error("Unsupported logical table.");
  const table = args.table || logical, columns = args.columns || Object.fromEntries((logical === "agents" ? AGENT_COLUMNS : logical === "routines" ? ROUTINE_COLUMNS : MEMORY_COLUMNS).map(key => [key, key]));
  const field = key => q(columns[key]);
  if (action === "save") {
    const record = args.record, names = Object.keys(record);
    return "INSERT INTO " + q(table) + " (" + [...names.map(q), ...(Object.hasOwn(record, columns.date) ? [] : [field("date")])].join(",") + ") VALUES (" + [...names.map(key => text(record[key])), ...(Object.hasOwn(record, columns.date) ? [] : ["CURRENT_TIMESTAMP"])].join(",") + ")";
  }
  if (action === "remove") return "DELETE FROM " + q(table) + " WHERE " + field("id") + "=" + text(args.id) + " AND " + field("type") + " IN ('fact','dato')";
  if (action === "redact") return "UPDATE " + q(table) + " SET " + field("content") + "=" + text("[orden de seguridad retirada]") + " WHERE " + field("id") + "=" + text(args.id);
  if (["agents", "routines"].includes(action) && args.action === "actualizar") {
    const names = Object.keys(args.record);
    return "MERGE INTO " + q(table) + " AS target USING (VALUES (" + names.map(key => text(args.record[key])).join(",") + ")) AS incoming (" + names.map(q).join(",") + ") ON target." + field("id") + "=incoming." + field("id") + " WHEN MATCHED" + (logical === "routines" ? " AND target." + field("agent_id") + "=incoming." + field("agent_id") : "") + " THEN UPDATE SET " + names.filter(key => key !== columns.id).map(key => q(key) + "=incoming." + q(key)).join(",") + " WHEN NOT MATCHED THEN INSERT (" + names.map(q).join(",") + ") VALUES (" + names.map(key => "incoming." + q(key)).join(",") + ")";
  }
  const where = [], filters = args.filters || {};
  if (args.id) where.push(field("id") + "=" + text(args.id));
  if (logical === "routines" && args.agent_id) where.push(field("agent_id") + "=" + text(args.agent_id));
  for (const key of ["type", "eco_author", "thread", "id"]) if (filters[key]) { const old = { memory: "recuerdo", fact: "dato", message: "mensaje", ack: "acuse" }[filters[key]]; where.push(key === "type" && old ? field(key) + " IN (" + text(filters[key]) + "," + text(old) + ")" : field(key) + "=" + text(filters[key])); }
  if (filters.content) where.push("LOWER(" + field("content") + ") LIKE " + likeText(String(filters.content).toLocaleLowerCase()) + " ESCAPE '\\'");
  if (filters.tags) { const tag = String(filters.tags).replace(/[\\%_]/g, "\\$&"); where.push("(" + field("tags") + "=" + text(filters.tags) + " OR " + field("tags") + " LIKE " + text(tag + ",%") + " OR " + field("tags") + " LIKE " + text("%," + tag) + " OR " + field("tags") + " LIKE " + text("%," + tag + ",%") + ")"); }
  if (args.cursor) where.push("(" + field("date") + ">" + text(args.cursor.date) + " OR (" + field("date") + "=" + text(args.cursor.date) + " AND " + field("id") + ">" + text(args.cursor.id) + "))");
  return "SELECT " + Object.values(columns).map(q).join(",") + " FROM " + q(table) + (where.length ? " WHERE " + where.join(" AND ") : "") + (["agents", "routines"].includes(logical) ? " ORDER BY " + field("id") : " ORDER BY " + field("date") + "," + field("id") + " FETCH FIRST 100 ROWS ONLY");
}

const reachable = result => result?.ok ? true : result?.status && ![401, 403, 404, 408, 429].includes(result.status) && result.status < 500 ? null : false;
async function observed(pending, report = reportMemoryConnection) {
  let result;
  try { result = await pending; } catch (error) { report(false); throw error; }
  const state = reachable(result);
  if (state !== null) report(state);
  return result;
}

const vaultPath = path => "/vault/" + String(path).split("/").map(encodeURIComponent).join("/");
const textOf = data => typeof data === "string" ? data : data && typeof data === "object" && !Array.isArray(data) && typeof (data.content ?? data.text) === "string" ? data.content ?? data.text : data === null || data === undefined ? "" : JSON.stringify(data);
function listOf(data) {
  if (typeof data === "string") { try { return listOf(JSON.parse(data)); } catch { return data.split("\n").map(line => line.trim()).filter(Boolean); } }
  if (Array.isArray(data)) return data.map(item => typeof item === "string" ? item : item?.path || item?.name || "").filter(Boolean);
  return listOf(data?.files ?? data?.entries ?? data?.items ?? []);
}
const missing = result => result?.status === 404 ? { ...result, ok: true, missing: true } : result;

function obsidianFiles(config, report) {
  const id = config.connector, names = config.arguments || {}, extra = config.operation_args || {};
  const fail = () => { throw new Error("The vault operation failed. Check the connector and its permissions."); };
  const tool = async (action, args) => {
    if (isWiping()) throw new Error("Memory stopped");
    const name = config.operations?.[action];
    if (!name) throw new Error("Missing vault tool for " + action);
    const result = await observed(callMcpTool(id, name, { ...(extra[action] || {}), ...args }).then(value => !value.ok && !value.error && value.status === undefined ? { ...value, status: 422 } : value), report);
    return result;
  };
  const rest = async (method, path, body, accept) => {
    if (isWiping()) throw new Error("Memory stopped");
    return observed(connectorFetch(id, method, path, {}, body, true, undefined, { accept, text: true }).then(missing), report);
  };
  const kind = async () => (await getConnector(id))?.kind === "mcp";
  return {
    async list(dir) {
      if (await kind()) { const result = await tool("list", { [names.path || "path"]: dir }); if (!result.ok) { if (result.status === 422) return []; fail(); } return listOf(result.data); }
      const result = await rest("GET", dir ? vaultPath(dir) + "/" : "/vault/", null, "application/json");
      if (result.missing) return [];
      if (!result.ok) fail();
      return listOf(result.data);
    },
    async read(path) {
      if (await kind()) { const result = await tool("read", { [names.path || "path"]: path }); if (!result.ok) { if (result.status === 422) return null; fail(); } return textOf(result.data); }
      const result = await rest("GET", vaultPath(path), null, "text/markdown");
      if (result.missing) return null;
      if (!result.ok) fail();
      return textOf(result.data);
    },
    async write(path, text) {
      const result = await kind() ? await tool("write", { [names.path || "path"]: path, [names.content || "content"]: text }) : await rest("PUT", vaultPath(path), text, "application/json");
      if (!result.ok || result.missing) fail();
      return true;
    },
    async remove(path) {
      const result = await kind() ? await tool("delete", { [names.path || "path"]: path }) : await rest("DELETE", vaultPath(path), null, "application/json");
      if (!result.ok) fail();
      return true;
    }
  };
}

export function memoryDependencies(config, report = reportMemoryConnection) {
  if (config.backend === "obsidian") return { files: obsidianFiles(config, report) };
  const id = config.backend === "google-drive" ? "eco-memory-drive" : config.connector;
  const invoke = async (action, args) => {
    if (isWiping()) throw new Error("Memory stopped");
    const connector = await getConnector(id);
    if (!connector) throw new Error("Connect the database first.");
    const name = config.operations?.[action] || config.operation;
    if (!name) throw new Error("Missing memory operation " + action);
    const payload = config.mode === "sql" ? { [config.sql_argument || "query"]: databaseSQL(action, args) } : { ...args, action, ...(["agents", "routines"].includes(action) ? { operation: args.action } : {}) };
    let result;
    if (connector.kind === "mcp") result = await observed(callMcpTool(id, name, payload), report);
    else {
      const operation = connector.operations.find(item => item.name === name);
      if (!operation || operation.method !== "POST" || operation.path.includes("{")) throw new Error("The database operation must be POST with a fixed path.");
      result = await observed(connectorFetch(id, "POST", operation.path, {}, payload, true), report);
    }
    if (!result.ok) throw new Error("Memory operation failed: " + action + ". Check the connector and its permissions.");
    if (action === "schema" && ["add", "map"].includes(args.stage) || ["save", "redact", "remove"].includes(action) || ["agents", "routines"].includes(action) && args.action === "actualizar") return { ok: true };
    return unpack(result.data);
  };
  return {
    request: (method, path, query, body, upsert) => observed(connectorFetch(id, method, path, query, body, true, undefined, { upsert, ...(path === "/rest/v1/" ? { accept: "application/openapi+json" } : {}) }), report),
    visualization: (sheet, query) => connectorVisualization(id, sheet, query),
    execute: invoke
  };
}
