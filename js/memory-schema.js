import { MEMORY_COLUMNS, AGENT_COLUMNS, ROUTINE_COLUMNS, LEGACY_MEMORY_COLUMNS, LEGACY_AGENT_COLUMNS, LEGACY_ROUTINE_COLUMNS, normalizeType } from "./memory-protocol.js";

export const SCHEMA_COLUMNS = Object.freeze({ _eco: ["key", "value"], memories: MEMORY_COLUMNS, messages: MEMORY_COLUMNS, acks: MEMORY_COLUMNS, agents: AGENT_COLUMNS, routines: ROUTINE_COLUMNS });
export const TABLE_ALIASES = Object.freeze({ _eco: ["eco", "metadata"], memories: ["recuerdos", "records", "memoria", "memorias"], messages: ["mensajes"], acks: ["acuses", "acknowledgements", "acknowledgments"], agents: ["agentes"], routines: ["rutinas"] });
const legacy = { memories: LEGACY_MEMORY_COLUMNS, messages: LEGACY_MEMORY_COLUMNS, acks: LEGACY_MEMORY_COLUMNS, agents: LEGACY_AGENT_COLUMNS, routines: ["id", "nombre", "responsable", "agente_id", "horario", "zona", "disparador", "descripcion", "stack", "estado", "actualizado"], _eco: ["clave", "valor"] };
const aliases = { date: ["fecha", "timestamp"], eco_author: ["eco_autor", "autor_eco"], user_author: ["usuario_autor"], content: ["contenido", "texto", "text"], tags: ["etiquetas"], owner: ["responsable"], timezone: ["zona", "zona_horaria"], reply_to: ["responde_a"], replaces: ["reemplaza_a"], preferences: ["preferencias"] };
export const foldName = value => String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLocaleLowerCase();
export const columnLetter = index => { let result = ""; for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) result = String.fromCharCode(65 + (value - 1) % 26) + result; return result; };
export const quoteTab = name => "'" + String(name).replaceAll("'", "''") + "'";
const findName = (names, candidates) => {
  for (const candidate of candidates.filter(value => typeof value === "string")) { const matches = names.map((name, index) => ({ name, index })).filter(item => item.name === candidate); if (matches.length === 1) return matches[0].index; }
  for (const candidate of candidates.filter(value => typeof value === "string")) { const matches = names.map((name, index) => ({ name, index })).filter(item => foldName(item.name) === foldName(candidate)); if (matches.length === 1) return matches[0].index; }
  return -1;
};
export function parseMap(value) {
  if (!value) return { tables: {} };
  try { const map = typeof value === "string" ? JSON.parse(value) : value; return cleanMap(map); } catch { return { tables: {} }; }
}
export function cleanMap(map) {
  if (!map || typeof map !== "object" || Array.isArray(map) || !map.tables || typeof map.tables !== "object" || Array.isArray(map.tables) || JSON.stringify(map).length > 45000) throw new Error("Mapa de memoria inválido. Usa {tables:{tabla:{name,columns:{campo:encabezado}}}}.");
  const result = { tables: {} };
  for (const [logical, entry] of Object.entries(map.tables)) {
    if (!Object.hasOwn(SCHEMA_COLUMNS, logical) || !entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Tabla lógica desconocida en el mapa.");
    const item = { columns: {} };
    if (entry.name !== undefined) { if (typeof entry.name !== "string" || !entry.name || entry.name.length > 200) throw new Error("Nombre de tabla inválido."); item.name = entry.name; }
    if (entry.headers !== undefined) { if (!Array.isArray(entry.headers) || entry.headers.some(value => typeof value !== "string" || value.length > 200)) throw new Error("Encabezados inválidos en el mapa."); item.headers = [...entry.headers]; }
    if (entry.sheetId !== undefined && Number.isInteger(entry.sheetId)) item.sheetId = entry.sheetId;
    for (const [key, selector] of Object.entries(entry.columns || {})) {
      if (!SCHEMA_COLUMNS[logical].includes(key)) throw new Error("Campo lógico desconocido en el mapa.");
      if (selector === null || typeof selector === "string" && selector.length <= 200 || Number.isInteger(selector) && selector >= 0 && selector < 18278) item.columns[key] = selector;
      else if (selector && typeof selector === "object" && typeof selector.name === "string" && selector.name.length <= 200 && Number.isInteger(selector.index) && selector.index >= 0 && selector.index < 18278) item.columns[key] = { name: selector.name, index: selector.index };
      else throw new Error("Selector de columna inválido: usa encabezado, índice desde cero o null para añadirla.");
    }
    result.tables[logical] = item;
  }
  return result;
}
export function mergeMap(previous, changes) {
  const next = parseMap(previous), update = cleanMap(changes);
  for (const [logical, entry] of Object.entries(update.tables)) {
    const old = next.tables[logical] || {};
    next.tables[logical] = { ...old, ...entry, columns: { ...old.columns, ...entry.columns } };
    if (entry.name && entry.name !== old.name) delete next.tables[logical].sheetId;
  }
  return next;
}
export function resolveSchema(tables, stored = { tables: {} }) {
  const map = parseMap(stored), resolved = {}, used = new Set();
  for (const [logical, fields] of Object.entries(SCHEMA_COLUMNS)) {
    const saved = map.tables[logical] || {}, names = tables.map(table => table.name);
    let index = saved.sheetId === undefined ? -1 : tables.findIndex(table => table.sheetId === saved.sheetId);
    if (index < 0) index = findName(names, [saved.name, logical, ...TABLE_ALIASES[logical]]);
    if (index < 0 || used.has(index)) { resolved[logical] = { logical, name: null, headers: [], fields: {}, unmapped: [...fields], unknown: [], candidates: tables.filter((table, i) => !used.has(i) && fields.filter(field => findName(table.headers, [field, ...(aliases[field] || [])]) >= 0).length >= 2).map(table => table.name) }; continue; }
    used.add(index);
    const table = tables[index], headers = table.headers.map(value => String(value ?? "")), columns = {}, occupied = new Set();
    for (const [position, field] of fields.entries()) {
      const selector = saved.columns?.[field];
      let column = -1;
      if (Number.isInteger(selector)) column = selector < headers.length ? selector : -1;
      else if (selector && typeof selector === "object") { column = findName(headers, [selector.name]); if (column < 0 && headers[selector.index] === selector.name) column = selector.index; }
      else if (typeof selector === "string") column = findName(headers, [selector]);
      if (column < 0 && selector !== null) column = findName(headers, [field, legacy[logical]?.[position], ...(aliases[field] || [])]);
      if (column >= 0 && !occupied.has(column)) { columns[field] = column; occupied.add(column); }
    }
    resolved[logical] = { logical, name: table.name, sheetId: table.sheetId, headers, fields: columns, unmapped: fields.filter(field => columns[field] === undefined), unknown: headers.map((name, index) => ({ name, index })).filter(item => !occupied.has(item.index)) };
  }
  return { tables: resolved, unknown_tables: tables.filter((table, index) => !used.has(index)).map(table => ({ name: table.name, headers: table.headers })) };
}
export function snapshotMap(schema) {
  return { tables: Object.fromEntries(Object.entries(schema.tables).filter(([, table]) => table.name).map(([logical, table]) => [logical, { name: table.name, headers: [...table.headers], ...(Number.isInteger(table.sheetId) ? { sheetId: table.sheetId } : {}), columns: Object.fromEntries(Object.entries(table.fields).map(([key, index]) => [key, { name: table.headers[index], index }])) }])) };
}
export function decodeRow(table, row) {
  return Object.fromEntries(SCHEMA_COLUMNS[table.logical].map(key => { const value = row[table.fields[key]]; return [key, key === "type" ? normalizeType(value || "") : Array.isArray(value) ? value.join(",") : String(value ?? "")]; }));
}
export const encodeRow = (table, record) => table.headers.map((_, index) => { const field = Object.keys(table.fields).find(key => table.fields[key] === index); return field ? record[field] ?? "" : ""; });
export function requireTable(schema, logical, fields = SCHEMA_COLUMNS[logical]) {
  const table = schema.tables[logical];
  const missing = fields.filter(key => table?.fields[key] === undefined);
  if (!table?.name || missing.length) throw new Error("Adapta la memoria con memoria_esquema: " + logical + (missing.length ? " necesita " + missing.join(",") : " no tiene tabla asignada") + ". No renombres ni borres datos del usuario.");
  return table;
}
