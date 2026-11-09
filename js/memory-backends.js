import { connectorFetch, connectorVisualization, getConnector } from "./connectors.js";
import { callMcpTool } from "./mcp.js";
import { DriveMemory } from "./memory-drive.js";
import { DatabaseMemory, SupabaseMemory } from "./memory-database.js";
import { MEMORY_COLUMNS, AGENT_COLUMNS, ROUTINE_COLUMNS, MEMORY_TABLES } from "./memory-protocol.js";
import { isWiping } from "./security.js";

export const MEMORY_BACKENDS = Object.freeze({
  "google-drive": { name: "Memoria persistente Google Drive", skill: "assets/skills/memoria-google-drive.txt", create: dependencies => new DriveMemory(dependencies) },
  supabase: { name: "Memoria persistente en base de datos", skill: "assets/skills/memoria-database.txt", create: dependencies => new SupabaseMemory(dependencies) },
  database: { name: "Memoria persistente en base de datos", skill: "assets/skills/memoria-database.txt", create: dependencies => new DatabaseMemory(dependencies) }
});
const text = value => "'" + String(value ?? "").replaceAll("'", "''") + "'";
const identifier = value => '"' + value.replaceAll('"', '""') + '"';
const likeText = value => text("%" + String(value).replace(/[\\%_]/g, "\\$&") + "%");
const unpack = value => {
  if (typeof value === "string") value = value.trim() ? JSON.parse(value) : null;
  return value?.rows ?? value?.data ?? value;
};

export function databaseSQL(action, args) {
  const table = action === "schema" ? "_eco" : ["agents", "routines", "redact"].includes(action) ? action === "redact" ? "messages" : action : args.table;
  if (![...MEMORY_TABLES, "_eco"].includes(table)) throw new Error("Tabla no compatible.");
  if (action === "schema") return 'SELECT key,value FROM "_eco"';
  if (action === "save") {
    const record = args.record;
    return 'INSERT INTO "' + table + '" (' + MEMORY_COLUMNS.map(identifier).join(",") + ") VALUES (" + MEMORY_COLUMNS.map(key => key === "date" ? "CURRENT_TIMESTAMP" : text(record[key])).join(",") + ")";
  }
  if (action === "redact") return 'UPDATE "messages" SET content=' + text("[orden de seguridad retirada]") + " WHERE id=" + text(args.id);
  if (["agents", "routines"].includes(action) && args.action === "actualizar") {
    const columns = action === "agents" ? AGENT_COLUMNS : ROUTINE_COLUMNS;
    return 'MERGE INTO "' + table + '" AS target USING (VALUES (' + columns.map(key => text(args.record[key])).join(",") + ')) AS incoming (' + columns.map(identifier).join(",") + ') ON target.id=incoming.id WHEN MATCHED' + (action === "routines" ? ' AND target.agent_id=incoming.agent_id' : '') + ' THEN UPDATE SET ' + columns.filter(key => key !== "id").map(key => identifier(key) + "=incoming." + identifier(key)).join(",") + ' WHEN NOT MATCHED THEN INSERT (' + columns.map(identifier).join(",") + ') VALUES (' + columns.map(key => "incoming." + identifier(key)).join(",") + ")";
  }
  const columns = table === "agents" ? AGENT_COLUMNS : table === "routines" ? ROUTINE_COLUMNS : MEMORY_COLUMNS;
  const where = [];
  const filters = args.filters || {};
  if (["agents", "routines"].includes(action) && args.id) where.push("id=" + text(args.id));
  if (action === "routines" && args.agent_id) where.push("agent_id=" + text(args.agent_id));
  for (const [key, column] of Object.entries({ type: "type", eco_author: "eco_author", thread: "thread", id: "id" })) if (filters[key]) where.push(column + "=" + text(filters[key]));
  if (filters.content) where.push("LOWER(content) LIKE " + likeText(String(filters.content).toLocaleLowerCase()) + " ESCAPE '\\'");
  if (filters.tags) {
    const tag = String(filters.tags).replace(/[\\%_]/g, "\\$&");
    where.push("(tags=" + text(filters.tags) + " OR tags LIKE " + text(tag + ",%") + " ESCAPE '\\' OR tags LIKE " + text("%," + tag) + " ESCAPE '\\' OR tags LIKE " + text("%," + tag + ",%") + " ESCAPE '\\')");
  }
  if (args.cursor) where.push("(date>" + text(args.cursor.date) + " OR (date=" + text(args.cursor.date) + " AND id>" + text(args.cursor.id) + "))");
  return 'SELECT ' + columns.map(identifier).join(",") + ' FROM "' + table + '"' + (where.length ? " WHERE " + where.join(" AND ") : "") + (["agents", "routines"].includes(table) ? " ORDER BY id" : " ORDER BY date,id") + (["agents", "routines"].includes(table) ? "" : " FETCH FIRST 100 ROWS ONLY");
}

export function memoryDependencies(config) {
  const id = config.backend === "google-drive" ? "eco-memory-drive" : config.connector;
  const invoke = async (action, args) => {
    if (isWiping()) throw new Error("Memoria detenida");
    const connector = await getConnector(id);
    if (!connector) throw new Error("Conecta primero la base de datos.");
    const name = config.operations?.[action] || config.operation;
    if (!name) throw new Error("Falta la operación de memoria " + action);
    const payload = config.mode === "sql" ? { [config.sql_argument || "query"]: databaseSQL(action, args) } : { ...args, action, ...(["agents", "routines"].includes(action) ? { operation: args.action } : {}) };
    let result;
    if (connector.kind === "mcp") result = await callMcpTool(id, name, payload);
    else {
      const operation = connector.operations.find(item => item.name === name);
      if (!operation || operation.method !== "POST" || operation.path.includes("{")) throw new Error("La operación de base de datos debe ser POST con ruta fija.");
      result = await connectorFetch(id, "POST", operation.path, {}, payload, true);
    }
    if (!result.ok) throw new Error("Falló la operación de memoria " + action + ". Revisa el conector y sus permisos.");
    if (["save", "redact"].includes(action) || ["agents", "routines"].includes(action) && args.action === "actualizar") return { ok: true };
    return unpack(result.data);
  };
  return {
    request: (method, path, query, body, upsert) => connectorFetch(id, method, path, query, body, true, undefined, { upsert }),
    visualization: (sheet, query) => connectorVisualization(id, sheet, query),
    execute: invoke
  };
}
