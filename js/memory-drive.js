import { inspectSecurityRecord, isSecurityCommand, isWiping, securityState } from "./security.js";
import { MEMORY_COLUMNS, AGENT_COLUMNS, ROUTINE_COLUMNS, MEMORY_TABLES, routineRecord, TYPE_TABS, RECORD_TABS, MEMORY_PROTOCOL, PROTOCOL_VERSION, matchesRecord, MemoryBackend, replacementCheck } from "./memory-protocol.js";
import { SCHEMA_COLUMNS, foldName, columnLetter, quoteTab, parseMap, mergeMap, resolveSchema, snapshotMap, decodeRow, encodeRow, requireTable } from "./memory-schema.js";
export { MEMORY_COLUMNS, AGENT_COLUMNS, TYPE_TABS, RECORD_TABS, MEMORY_PROTOCOL } from "./memory-protocol.js";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const cells = values => values.map(value => ({ userEnteredValue: { stringValue: String(value ?? "") } }));
const rows = values => values.map(value => ({ values: cells(value) }));
let queue = Promise.resolve(), lastRequest = 0;
export function sheetId(value) {
  const text = String(value || "").trim();
  if (!text || /^[A-Za-z0-9_-]{20,}$/.test(text)) return text;
  let url;
  try { url = new URL(text); } catch { throw new Error("Enter a Google Sheets URL or its ID."); }
  const match = url.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/);
  if (url.protocol !== "https:" || url.hostname !== "docs.google.com" || !match) throw new Error("Invalid Google Sheets URL.");
  return match[1];
}
export class DriveMemory extends MemoryBackend {
  constructor(dependencies) {
    super(dependencies);
    Object.assign(this, dependencies);
    this.throttle = dependencies.throttle !== false;
    this.saving = Promise.resolve();
    this.preparing = null;
    this.mapping = parseMap(this.config.map);
    try { this.mapping = parseMap(localStorage.getItem("eco.memorySchema:" + this.config.sheet) || this.config.map); } catch {}
  }
  schedule(operation) {
    const pending = queue.then(async () => {
      if (isWiping()) throw new Error("Memory stopped");
      if (this.throttle) { const delay = Math.max(0, lastRequest + 2500 - Date.now()); if (delay) await new Promise(resolve => setTimeout(resolve, delay)); lastRequest = Date.now(); }
      if (isWiping()) throw new Error("Memory stopped");
      return operation();
    });
    queue = pending.catch(() => {});
    return pending;
  }
  call(method, path, query = {}, body = null) {
    return this.schedule(async () => {
      const result = await this.request(method, path, query, body);
      if (!result.ok) throw new Error(result.error === "not_connected" ? "Reconnect the memory." : String(result.data?.error?.message || result.error || "Could not query the memory."));
      if (result.redactMemory) this.redactMemory = result.redactMemory;
      return result.data;
    });
  }
  base() { return "/v4/spreadsheets/" + this.config.sheet; }
  path(range) { return this.base() + "/values/" + encodeURIComponent(range); }
  async values(range) { return (await this.call("GET", this.path(range))).values || []; }
  async batchValues(ranges) {
    if (!ranges.length) return [];
    const result = await this.call("GET", this.base() + "/values:batchGet", { ranges, valueRenderOption: "UNFORMATTED_VALUE" });
    return ranges.map((_, index) => result.valueRanges?.[index]?.values || []);
  }
  batch(requests) { return requests.length ? this.call("POST", this.base() + ":batchUpdate", {}, { requests }) : Promise.resolve(); }
  range(table, start = 2, end = "") { return quoteTab(table.name) + "!A" + start + ":" + columnLetter(Math.max(0, table.headers.length - 1)) + end; }
  async inspect(overrides = null) {
    const structure = await this.call("GET", this.base(), { fields: "sheets.properties" });
    const properties = (structure.sheets || []).map(sheet => sheet.properties);
    const headers = await this.batchValues(properties.map(table => quoteTab(table.title) + "!1:1"));
    const tables = properties.map((table, index) => ({ name: table.title, sheetId: table.sheetId, headers: headers[index][0] || [], grid: table.gridProperties || {} }));
    let schema = resolveSchema(tables, overrides ? mergeMap(this.mapping, overrides) : this.mapping);
    if (!schema.tables._eco.name) {
      const candidates = tables.filter(table => { const names = table.headers.map(foldName); return names.some(name => ["key", "clave"].includes(name)) && names.some(name => ["value", "valor"].includes(name)); });
      if (candidates.length === 1) { this.mapping = mergeMap(this.mapping, { tables: { _eco: { name: candidates[0].name } } }); schema = resolveSchema(tables, this.mapping); }
    }
    let protocol = [], remote = null;
    const metadata = schema.tables._eco;
    if (metadata.name && metadata.fields.key !== undefined && metadata.fields.value !== undefined) {
      protocol = await this.values(this.range(metadata));
      const entry = protocol.map(row => decodeRow(metadata, row)).find(row => row.key === "map");
      if (entry) remote = parseMap(entry.value);
    }
    this.mapping = overrides ? mergeMap(remote || this.mapping, overrides) : remote || this.mapping;
    schema = resolveSchema(tables, this.mapping);
    this.rawTables = tables;
    this.structure = { ...schema, protocol, version: String(protocol.map(row => decodeRow(schema.tables._eco, row)).find(row => row.key === "version")?.value || PROTOCOL_VERSION) };
    return this.structure;
  }
  async additive(schema) {
    const requests = [], ids = new Set(this.rawTables.map(table => table.sheetId));
    const reserved = new Set(Object.values(schema.tables).map(table => table.name).filter(Boolean));
    for (const [logical, table] of Object.entries(schema.tables)) {
      if (!table.name) {
        const candidates = table.candidates.filter(name => !reserved.has(name));
        if (candidates.length || this.rawTables.some(item => item.name === logical)) continue;
        let sheetId = 1; while (ids.has(sheetId)) sheetId++; ids.add(sheetId);
        requests.push({ addSheet: { properties: { title: logical, sheetId, gridProperties: { frozenRowCount: 1 } } } });
        requests.push({ updateCells: { start: { sheetId, rowIndex: 0, columnIndex: 0 }, rows: rows([SCHEMA_COLUMNS[logical]]), fields: "userEnteredValue" } });
        this.mapping = mergeMap(this.mapping, { tables: { [logical]: { name: logical, sheetId } } });
        continue;
      }
      const saved = this.mapping.tables[logical];
      const deleted = saved?.headers && table.unknown.every(column => saved.headers.includes(column.name));
      const missing = table.unmapped.filter(key => saved?.columns?.[key] === null || !table.unknown.length || deleted && Object.hasOwn(saved.columns || {}, key));
      if (!missing.length) continue;
      const width = table.headers.length;
      const grid = this.rawTables.find(item => item.sheetId === table.sheetId)?.grid || {};
      if (width + missing.length > (grid.columnCount || 26)) requests.push({ appendDimension: { sheetId: table.sheetId, dimension: "COLUMNS", length: width + missing.length - (grid.columnCount || 26) } });
      requests.push({ updateCells: { start: { sheetId: table.sheetId, rowIndex: 0, columnIndex: width }, rows: rows([missing]), fields: "userEnteredValue" } });
      const columns = Object.fromEntries(missing.map((key, index) => [key, { name: key, index: width + index }]));
      this.mapping = mergeMap(this.mapping, { tables: { [logical]: { columns } } });
    }
    try { await this.batch(requests); } catch { schema.warning = "Missing fields or tables could not be added. The map does not modify existing data."; return schema; }
    if (requests.length) return this.inspect(this.mapping);
    return schema;
  }
  async persistMap() {
    const map = snapshotMap(this.structure);
    this.mapping = map;
    this.config.map = map;
    try { localStorage.setItem("eco.memorySchema:" + this.config.sheet, JSON.stringify(map)); } catch {}
    const table = this.structure.tables._eco;
    if (!table.name || table.fields.key === undefined || table.fields.value === undefined) return;
    const existing = this.structure.protocol.map(row => decodeRow(table, row));
    const index = existing.findIndex(row => row.key === "map"), value = JSON.stringify(map);
    if (index >= 0 && existing[index].value === value) { this.structure.map_shared = true; return; }
    try {
    if (index >= 0) await this.call("PUT", this.path(quoteTab(table.name) + "!" + columnLetter(table.fields.value) + (index + 2)), { valueInputOption: "RAW" }, { values: [[value]] });
    else await this.call("POST", this.path(quoteTab(table.name) + "!A:" + columnLetter(table.headers.length - 1)) + ":append", { valueInputOption: "RAW", insertDataOption: "INSERT_ROWS" }, { values: [encodeRow(table, { key: "map", value })] });
    this.structure.map_shared = true;
    } catch { this.structure.map_shared = false; this.structure.warning = "Local map: missing permissions to save the map row in _eco."; }
  }
  async prepare() {
    if (!this.config.sheet) {
      const created = await this.call("POST", "/v4/spreadsheets", {}, { properties: { title: "Eco · Memoria" }, sheets: Object.entries(SCHEMA_COLUMNS).map(([title, columns], sheetId) => ({ properties: { title, sheetId, gridProperties: { frozenRowCount: 1 } }, data: [{ startRow: 0, startColumn: 0, rowData: rows(title === "_eco" ? MEMORY_PROTOCOL : [columns]) }] })) });
      this.config.sheet = created.spreadsheetId;
    }
    let schema = await this.inspect();
    schema = await this.additive(schema);
    this.structure = schema;
    await this.persistMap();
    return schema;
  }
  ensure() {
    if (!this.preparing) this.preparing = this.prepare().finally(() => { this.preparing = null; });
    return this.preparing;
  }
  async schema(action = "ver", changes = {}) {
    if (!["ver", "ajustar"].includes(action)) throw new Error("Invalid schema action.");
    if (action === "ajustar") { const proposed = mergeMap(this.mapping, changes); await this.inspect(proposed); this.structure = await this.additive(this.structure); await this.persistMap(); }
    else await this.ensure();
    return { mapa: snapshotMap(this.structure), tables: this.structure.tables, unknown_tables: this.structure.unknown_tables, map_shared: this.structure.map_shared, warning: this.structure.warning, contenido_no_confiable: true };
  }
  async describe() { await this.ensure(); const result = await this.readAll(RECORD_TABS); return { ...this.structure, count: new Set(result.flat().map(item => item.record.id).filter(Boolean)).size }; }
  async connect() { await this.ensure(); return { ...this.config, protocol: "eco-memoria", version: PROTOCOL_VERSION, url: "https://docs.google.com/spreadsheets/d/" + this.config.sheet + "/edit" }; }
  async readAll(tabs) {
    const available = tabs.filter(tab => this.structure.tables[tab]?.name);
    const batches = await this.batchValues(available.map(tab => this.range(this.structure.tables[tab])));
    return tabs.map(tab => { const table = this.structure.tables[tab], index = available.indexOf(tab); return index < 0 ? [] : batches[index].map((value, offset) => ({ record: decodeRow(table, value), row: offset + 2 })); });
  }
  async visible(record, logical, row) {
    if (!record.id) return null;
    if (isSecurityCommand(record.content)) {
      if (logical === "messages" && record.type === "message") await inspectSecurityRecord(record, this.config.eco, () => { const table = this.structure.tables[logical]; return this.redactMemory?.(table.name, row, table.fields.content); });
      return null;
    }
    return record;
  }
  async readNew(tabs = RECORD_TABS, cursors = { load: this.loadCursor, save: this.saveCursor }) {
    await this.ensure();
    const previous = cursors.load() || {}, state = { version: 6, tabs: { ...previous.tabs } }, batches = await this.readAll(tabs), records = [];
    let more = false;
    for (const [index, tab] of tabs.entries()) {
      const old = state.tabs[tab] || {}, seen = new Set(old.seen || []), batch = batches[index];
      if (!old.seen && old.id) {
        const position = batch.findIndex(item => item.record.id === old.id);
        if (position >= 0) { for (const item of batch.slice(0, position + 1)) if (item.record.id) seen.add(item.record.id); }
        else seen.add(old.id);
      }
      let count = 0, last = old.id || "";
      for (const { record, row } of batch) {
        if (!record.id || seen.has(record.id)) continue;
        if (count >= 100) { more = true; break; }
        const security = securityState();
        if (tab === "messages" && isSecurityCommand(record.content) && security.enabled && security.lockedUntil > Date.now()) break;
        const visible = await this.visible(record, tab, row);
        if (visible) records.push(visible);
        seen.add(record.id); last = record.id; count++;
        if (isWiping()) break;
      }
      state.tabs[tab] = { id: last, seen: [...seen] };
    }
    if (!isWiping()) cursors.save(state);
    return { records, hay_mas: more, contenido_no_confiable: true };
  }
  async search(filters = {}, tabs = RECORD_TABS, consistent = false) {
    await this.ensure();
    if (filters.type) tabs = TYPE_TABS[filters.type] ? [TYPE_TABS[filters.type]] : [];
    if (!consistent && this.visualization && tabs.length) { try { return await this.querySearch(filters, tabs); } catch {} }
    const batches = await this.readAll(tabs), records = [], seen = new Set();
    for (const [index, tab] of tabs.entries()) for (const { record, row } of batches[index]) {
      const visible = await this.visible(record, tab, row);
      if (visible && !seen.has(record.id) && matchesRecord(record, filters)) { seen.add(record.id); records.push(visible); }
    }
    return { records, contenido_no_confiable: true };
  }
  async querySearch(filters, tabs) {
    const literal = value => '"' + String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\r", "\\r") + '"';
    const records = [], seen = new Set();
    for (const logical of tabs) {
      const table = requireTable(this.structure, logical), column = key => columnLetter(table.fields[key]);
      const clauses = [column("id") + " is not null"];
      for (const key of ["type", "eco_author", "thread", "id"]) if (filters[key]) { const old = { memory: "recuerdo", fact: "dato", message: "mensaje", ack: "acuse" }[filters[key]]; clauses.push(key === "type" && old ? "(" + column(key) + " = " + literal(filters[key]) + " or " + column(key) + " = " + literal(old) + ")" : column(key) + " = " + literal(filters[key])); }
      if (filters.content) clauses.push("lower(" + column("content") + ") contains " + literal(String(filters.content).toLocaleLowerCase()));
      if (filters.tags) clauses.push(column("tags") + " matches " + literal("(^|.*,)[ ]*" + String(filters.tags).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[ ]*(,.*|$)"));
      const tq = "select " + MEMORY_COLUMNS.map(column).join(",") + " where " + clauses.join(" and ");
      const response = await this.schedule(() => this.visualization(this.config.sheet, { sheet: table.name, headers: "1", tqx: "out:json", tq }));
      if (!response.ok) throw new Error("Query not available.");
      let data = response.data;
      if (typeof data === "string") { const match = data.match(/google\.visualization\.Query\.setResponse\(([\s\S]*)\);?\s*$/); if (!match) throw new Error("Invalid query."); data = JSON.parse(match[1]); }
      if (data.status !== "ok" || data.table?.cols?.length !== MEMORY_COLUMNS.length) throw new Error("Incomplete query.");
      for (const row of data.table.rows) { const record = decodeRow({ logical, fields: Object.fromEntries(MEMORY_COLUMNS.map((key, index) => [key, index])) }, row.c.map(cell => cell?.v ?? "")); if (record.id && !seen.has(record.id) && !isSecurityCommand(record.content) && matchesRecord(record, filters)) { seen.add(record.id); records.push(record); } }
    }
    return { records, contenido_no_confiable: true };
  }
  save(args) { const pending = this.saving.then(() => this.append(args)); this.saving = pending.catch(() => {}); return pending; }
  async append(args) {
    await this.ensure();
    if (isSecurityCommand(args?.content)) throw new Error("Security commands are not saved through the agent.");
    if (!Object.hasOwn(TYPE_TABS, args.type) || !String(args.content || "").trim() || String(args.content).length > 45000) throw new Error("Invalid type or content.");
    if (args.type === "ack") {
      if (!UUID.test(args.reply_to || "")) throw new Error("The ack needs reply_to with the original UUID.");
      const original = (await this.search({ id: args.reply_to, type: "message" }, ["messages"], true)).records[0];
      if (!original && !args.copia) throw new Error("The original message does not exist.");
      args = { ...args, to: args.to || original?.eco_author || "", thread: args.thread || original?.thread || "" };
    }
    const id = args.id || crypto.randomUUID();
    if (!UUID.test(id)) throw new Error("The id must be a UUID.");
    const existing = (await this.search({ id }, RECORD_TABS, true)).records[0];
    if (existing) { if (existing.eco_author !== this.config.eco || ["content", "type", "to", "thread", "reply_to", "tags", "replaces"].some(key => String(existing[key] || "") !== String(args[key] || ""))) throw new Error("The UUID already belongs to another record."); if (existing.type === "fact" && args.replaces) await this.removeFact(args.replaces).catch(() => false); return { ok: true, id, duplicado: true }; }
    const replacing = replacementCheck({ ...args, id }, args.replaces ? (await this.search({ id: args.replaces }, RECORD_TABS, true)).records[0] : null, !args.copia);
    const table = requireTable(this.structure, TYPE_TABS[args.type]);
    const { copia, ...fields } = args;
    const record = { ...fields, id, date: new Date().toISOString(), eco_author: this.config.eco, user_author: this.config.usuario };
    try { await this.call("POST", this.path(quoteTab(table.name) + "!A:" + columnLetter(table.headers.length - 1)) + ":append", { valueInputOption: "RAW", insertDataOption: "INSERT_ROWS" }, { values: [encodeRow(table, record)] }); }
    catch (error) { return { error: error.message, id, reintentar: "Repeat memoria_guardar with this same id." }; }
    if (!replacing) return { ok: true, id };
    return await this.removeFact(args.replaces).catch(() => false) ? { ok: true, id, reemplazado: args.replaces } : { ok: true, id, aviso: "The previous fact is still in the sheet; it is superseded through replaces." };
  }
  async removeFact(id) {
    const table = requireTable(this.structure, "memories");
    const matches = (await this.readAll(["memories"]))[0].filter(item => item.record.id === id);
    if (matches.length !== 1 || matches[0].record.type !== "fact") return false;
    const row = matches[0].row, current = decodeRow(table, (await this.values(this.range(table, row, row)))[0] || []);
    if (current.id !== id || current.type !== "fact") return false;
    await this.batch([{ deleteDimension: { range: { sheetId: table.sheetId, dimension: "ROWS", startIndex: row - 1, endIndex: row } } }]);
    return true;
  }
  async directory(logical, action, changes, identity = {}) {
    await this.ensure();
    const table = requireTable(this.structure, logical), values = (await this.readAll([logical]))[0];
    if (action === "listar") return { [logical === "agents" ? "agentes" : "rutinas"]: values.map(item => item.record).filter(record => record.id && (logical !== "routines" || record.agent_id === this.config.eco)), contenido_no_confiable: true };
    if (action !== "actualizar") throw new Error("Invalid directory action.");
    const id = logical === "agents" ? this.config.eco : changes.id, matches = values.filter(item => item.record.id === id);
    if (matches.length > 1) throw new Error("The id is repeated; assign a unique one without overwriting rows.");
    const previous = matches[0]?.record || {};
    let record;
    if (logical === "agents") {
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id || "")) throw new Error("Invalid agent name.");
      for (const [key, value] of Object.entries(changes)) if (!["preferences", "stack"].includes(key) || typeof value !== "string" || value.length > 2000) throw new Error("You can only update your own preferences and stack.");
      record = { ...previous, ...changes, id, class: "eco", model: identity.model || "", alias: this.config.usuario || "", peripherals: identity.peripherals || "", status: "activo", version: identity.version || "", updated: new Date().toISOString() };
    } else record = routineRecord(this.config, changes, previous);
    if (matches.length) {
      const requests = Object.entries(table.fields).filter(([key]) => record[key] !== undefined).map(([key, columnIndex]) => ({ updateCells: { start: { sheetId: table.sheetId, rowIndex: matches[0].row - 1, columnIndex }, rows: rows([[record[key]]]), fields: "userEnteredValue" } }));
      await this.batch(requests);
    } else await this.call("POST", this.path(quoteTab(table.name) + "!A:" + columnLetter(table.headers.length - 1)) + ":append", { valueInputOption: "RAW", insertDataOption: "INSERT_ROWS" }, { values: [encodeRow(table, record)] });
    return { ok: true, [logical === "agents" ? "agente" : "rutina"]: record };
  }
  agents(action = "listar", changes = {}, identity = {}) { return this.directory("agents", action, changes, identity); }
  routines(action = "listar", changes = {}) { return this.directory("routines", action, changes); }
}
