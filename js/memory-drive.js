import { inspectSecurityRecord, isSecurityCommand, isWiping, securityState } from "./security.js";
import { MEMORY_COLUMNS, AGENT_COLUMNS, ROUTINE_COLUMNS, LEGACY_MEMORY_COLUMNS, LEGACY_AGENT_COLUMNS, LEGACY_ROUTINE_COLUMNS, MEMORY_TABLES, routineRecord, TYPE_TABS, RECORD_TABS, MEMORY_PROTOCOL, PROTOCOL_VERSION, LEGACY_TABS, recordOf, matchesRecord, MemoryBackend } from "./memory-protocol.js";
export { MEMORY_COLUMNS, AGENT_COLUMNS, TYPE_TABS, RECORD_TABS, MEMORY_PROTOCOL } from "./memory-protocol.js";
const BATCH_ROWS = 100;
const FIRST_ROW = 2;
const REQUEST_INTERVAL_MS = 2500;
const MAX_CONTENT = 45000;
const AGENT_FIELD_LIMIT = 2000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHEET_ID_PATTERN = /^[A-Za-z0-9_-]{20,}$/;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PROTOCOL_NAME = "eco-memoria";
const ALL_TABS = Object.freeze(["_eco", ...MEMORY_TABLES]);
const columnsFor = tab => tab === "agents" ? AGENT_COLUMNS : tab === "routines" ? ROUTINE_COLUMNS : MEMORY_COLUMNS;
let queue = Promise.resolve();
let lastRequest = 0;

const cells = values => values.map(value => ({ userEnteredValue: { stringValue: String(value ?? "") } }));
const rows = values => values.map(value => ({ values: cells(value) }));
const rangeFor = (tab, start = FIRST_ROW, end = "") => "'" + tab + "'!A" + start + ":K" + end;

export function sheetId(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (SHEET_ID_PATTERN.test(text)) return text;
  let url;
  try { url = new URL(text); } catch { throw new Error("Introduce una URL de Google Sheets o su ID."); }
  const match = url.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  if (url.protocol !== "https:" || url.hostname !== "docs.google.com" || !match || !SHEET_ID_PATTERN.test(match[1])) throw new Error("URL de Google Sheets inválida.");
  return match[1];
}

export function validateProtocol(protocol, headers) {
  const values = Object.fromEntries(protocol);
  const version = String(values.version);
  const english = ["4", PROTOCOL_VERSION].includes(version);
  const current = version === PROTOCOL_VERSION;
  const recordColumns = english ? MEMORY_COLUMNS : LEGACY_MEMORY_COLUMNS;
  const agentColumns = english ? AGENT_COLUMNS : LEGACY_AGENT_COLUMNS;
  const routineColumns = english ? ROUTINE_COLUMNS : LEGACY_ROUTINE_COLUMNS;
  const expectedTabs = version === "1" ? ["records"] : version === "2" ? ["recuerdos", "mensajes", "acuses"] : current ? RECORD_TABS : ["memories", "messages"];
  const agentTab = version === "2" ? "agentes" : "agents";
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const tables = values.tables ?? values.tablas;
  const knownTables = version === "2" ? [expectedTabs.join(",")] : current ? [MEMORY_TABLES.join(",")] : ["memories,messages,agents,routines", "memories,messages,acks"];
  const valid = ["1", "2", "3", "4", PROTOCOL_VERSION].includes(version) && (values.protocol ?? values.protocolo) === PROTOCOL_NAME && (values.columns ?? values.columnas) === recordColumns.join(",") && expectedTabs.every(tab => same(headers[tab], recordColumns)) &&
    (version === "1" ? (values.tabla ?? values.table) === "records" : knownTables.includes(tables) && values[agentTab] === agentColumns.join(",") && same(headers[agentTab], agentColumns)) &&
    ["acks", "acuses"].every(tab => !headers[tab] || same(headers[tab], recordColumns)) &&
    (!headers.routines || same(headers.routines, routineColumns)) && (!current || values.routines === ROUTINE_COLUMNS.join(",") && same(headers.routines, ROUTINE_COLUMNS));
  if (!valid) throw new Error("La hoja no usa un protocolo eco-memoria compatible o sus columnas no coinciden.");
  return { protocol: PROTOCOL_NAME, version, tables: expectedTabs, needsUpgrade: !current || Boolean(headers.acuses) || Boolean(headers.records) };
}

export class DriveMemory extends MemoryBackend {
  constructor({ request, visualization, loadCursor, saveCursor, config, throttle = true }) {
    super({ config, loadCursor, saveCursor });
    this.visualization = visualization;
    this.request = request;
    this.loadCursor = loadCursor;
    this.saveCursor = saveCursor;
    this.config = config;
    this.throttle = throttle;
    this.saving = Promise.resolve();
    this.preparing = null;
    this.structure = null;
    this.agentWriting = Promise.resolve();
    this.routineWriting = Promise.resolve();
  }
  async schedule(operation) {
    const execute = async () => {
      if (isWiping()) throw new Error("Memoria detenida");
      if (this.throttle) {
        const delay = Math.max(0, lastRequest + REQUEST_INTERVAL_MS - Date.now());
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        if (isWiping()) throw new Error("Memoria detenida");
        lastRequest = Date.now();
      }
      return operation();
    };
    const pending = queue.then(execute);
    queue = pending.catch(() => {});
    return pending;
  }
  call(method, path, query = {}, body = null) {
    return this.schedule(async () => {
      const result = await this.request(method, path, query, body);
      if (!result.ok) throw new Error(result.error === "not_connected" ? "Inicia sesión de nuevo en Memoria persistente Google Drive." : String(result.data?.error?.message || result.error || "No se pudo leer o guardar la memoria."));
      if (result.redactMemory) this.redactMemory = result.redactMemory;
      return result.data;
    });
  }
  base() { return "/v4/spreadsheets/" + this.config.sheet; }
  path(range) { return this.base() + "/values/" + encodeURIComponent(range); }
  async values(range) { return (await this.call("GET", this.path(range))).values || []; }
  async batchValues(ranges) {
    const result = await this.call("GET", this.base() + "/values:batchGet", { ranges, valueRenderOption: "UNFORMATTED_VALUE" });
    return ranges.map((range, index) => result.valueRanges?.[index]?.values || []);
  }
  batch(requests) { return this.call("POST", this.base() + ":batchUpdate", {}, { requests }); }
  async inspect() {
    const structure = await this.call("GET", this.base(), { fields: "sheets.properties" });
    const tabs = Object.fromEntries((structure.sheets || []).map(sheet => [sheet.properties.title, sheet.properties.sheetId]));
    const names = [...new Set(["records", ...MEMORY_TABLES, "acuses", "acks", ...Object.keys(LEGACY_TABS)])].filter(tab => Object.hasOwn(tabs, tab));
    const result = await this.batchValues(["'_eco'!A1:B30", ...names.map(tab => "'" + tab + "'!A1:K1")]);
    const headers = Object.fromEntries(names.map((tab, index) => [tab, result[index + 1][0] || []]));
    return { ...validateProtocol(result[0], headers), tabs, grids: Object.fromEntries((structure.sheets || []).map(sheet => [sheet.properties.title, sheet.properties.gridProperties || {}])) };
  }
  async describe() {
    const schema = await this.inspect();
    const result = await this.batchValues(schema.tables.map(tab => "'" + tab + "'!A2:A"));
    return { ...schema, count: new Set(result.flat().map(row => row[0]).filter(Boolean)).size };
  }
  ensure() {
    if (!this.preparing) this.preparing = this.prepare().catch(error => { this.preparing = null; throw error; });
    return this.preparing;
  }
  async prepare() {
    if (!this.config.sheet) {
      const created = await this.call("POST", "/v4/spreadsheets", {}, {
        properties: { title: "Eco · Memoria" },
        sheets: ALL_TABS.map((title, sheetId) => ({ properties: { title, sheetId, gridProperties: { frozenRowCount: 1 } }, data: [{ startRow: 0, startColumn: 0, rowData: rows(title === "_eco" ? MEMORY_PROTOCOL : [columnsFor(title)]) }] }))
      });
      this.config.sheet = created.spreadsheetId;
    }
    let schema = await this.inspect();
    if (schema.needsUpgrade) {
      await this.upgrade(schema);
      schema = await this.inspect();
    }
    if (schema.needsUpgrade) throw new Error("La migración del protocolo no se completó.");
    this.structure = schema;
    this.config.initialize = false;
    return schema;
  }
  async upgrade(schema) {
    const requests = [];
    if (schema.version !== PROTOCOL_VERSION) requests.push({ addNamedRange: { namedRange: { namedRangeId: "eco_memory_protocol_v5", name: "eco_memory_protocol_v5", range: { sheetId: schema.tabs._eco, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 2 } } } });
    const targetIds = { ...schema.tabs };
    if (schema.version === "2") {
      for (const [previous, title] of Object.entries(LEGACY_TABS)) {
        if (Object.hasOwn(schema.tabs, title)) throw new Error("Hay pestañas antiguas y actuales simultáneas. Revisa el esquema antes de migrar.");
        targetIds[title] = schema.tabs[previous];
        requests.push({ updateSheetProperties: { properties: { sheetId: schema.tabs[previous], title }, fields: "title" } });
      }
      if (Object.hasOwn(schema.tabs, "acks")) throw new Error("Hay dos pestañas de confirmaciones. Revisa el esquema antes de migrar.");
      targetIds.acks = schema.tabs.acuses;
      requests.push({ updateSheetProperties: { properties: { sheetId: schema.tabs.acuses, title: "acks" }, fields: "title" } });
    }
    const sources = [...new Set(["memories", "messages", "acks", ...Object.keys(LEGACY_TABS), "acuses", "records"])].filter(tab => Object.hasOwn(schema.tabs, tab) && !["agents", "agentes"].includes(tab));
    const values = await this.batchValues(sources.map(tab => rangeFor(tab)));
    const records = Object.fromEntries(RECORD_TABS.map(tab => [tab, []]));
    const known = new Map();
    for (const batch of values) for (const value of batch) {
      if (!value.some(cell => String(cell ?? "").length)) continue;
      const record = recordOf(value);
      const tab = TYPE_TABS[record.type];
      if (!record.id || !tab) throw new Error("Hay registros con id o tipo incompatible. Conserva los datos y revisa el esquema.");
      if (known.has(record.id)) {
        if (JSON.stringify(known.get(record.id)) !== JSON.stringify(record)) throw new Error("Un UUID tiene contenido diferente entre pestañas.");
        continue;
      }
      known.set(record.id, record);
      records[tab].push(MEMORY_COLUMNS.map(key => record[key]));
    }
    const ids = new Set(Object.values(schema.tabs));
    for (const tab of MEMORY_TABLES) {
      if (!Object.hasOwn(targetIds, tab)) {
        let sheetId = 1;
        while (ids.has(sheetId)) sheetId++;
        ids.add(sheetId);
        targetIds[tab] = sheetId;
        requests.push({ addSheet: { properties: { title: tab, sheetId, gridProperties: { frozenRowCount: 1, rowCount: Math.max(1000, (records[tab]?.length || 0) + 1) } } } });
      }
      const sheetId = targetIds[tab];
      if (tab === "routines" && Object.hasOwn(schema.tabs, tab) && ["1", "2", "3"].includes(schema.version)) requests.push({ insertDimension: { range: { sheetId, dimension: "COLUMNS", startIndex: 8, endIndex: 9 }, inheritFromBefore: true } });
      if (RECORD_TABS.includes(tab)) {
        const previous = sources.find(source => schema.tabs[source] === sheetId);
        const oldLength = previous ? values[sources.indexOf(previous)].length : 0;
        if (schema.version === "4" && !schema.tabs.records && !schema.tabs.acuses) {
          const original = previous ? values[sources.indexOf(previous)] : [];
          const retained = new Set();
          const removed = [];
          for (const [index, value] of original.entries()) {
            const record = recordOf(value);
            if (record.id && TYPE_TABS[record.type] === tab && !retained.has(record.id)) retained.add(record.id);
            else if (value.some(cell => String(cell ?? "").length)) removed.push(index + FIRST_ROW - 1);
          }
          requests.push({ updateCells: { start: { sheetId, rowIndex: 0, columnIndex: 0 }, rows: rows([MEMORY_COLUMNS]), fields: "userEnteredValue" } });
          for (const rowIndex of removed.reverse()) requests.push({ deleteDimension: { range: { sheetId, dimension: "ROWS", startIndex: rowIndex, endIndex: rowIndex + 1 } } });
          const added = records[tab].filter(value => !retained.has(value[0]));
          if (added.length) requests.push({ appendCells: { sheetId, rows: rows(added), fields: "userEnteredValue" } });
          continue;
        }
        if (previous && records[tab].length + 1 > (schema.grids?.[previous]?.rowCount || 1000)) requests.push({ updateSheetProperties: { properties: { sheetId, gridProperties: { rowCount: records[tab].length + 1 } }, fields: "gridProperties.rowCount" } });
        requests.push({ updateCells: { range: { sheetId, startRowIndex: 0, endRowIndex: Math.max(oldLength, records[tab].length) + 1, startColumnIndex: 0, endColumnIndex: MEMORY_COLUMNS.length }, rows: rows([MEMORY_COLUMNS, ...records[tab]]), fields: "userEnteredValue" } });
      } else requests.push({ updateCells: { start: { sheetId, rowIndex: 0, columnIndex: 0 }, rows: rows([columnsFor(tab)]), fields: "userEnteredValue" } });
    }
    if (Object.hasOwn(schema.tabs, "records")) requests.push({ deleteSheet: { sheetId: schema.tabs.records } });
    if (schema.version !== "2" && Object.hasOwn(schema.tabs, "acuses")) requests.push({ deleteSheet: { sheetId: schema.tabs.acuses } });
    requests.push({ updateCells: { range: { sheetId: schema.tabs._eco, startRowIndex: 0, endRowIndex: 30, startColumnIndex: 0, endColumnIndex: 2 }, rows: rows(MEMORY_PROTOCOL), fields: "userEnteredValue" } });
    try { await this.batch(requests); }
    catch (error) { if ((await this.inspect()).needsUpgrade) throw error; }
  }
  async connect() {
    await this.ensure();
    return { ...this.config, protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION, url: "https://docs.google.com/spreadsheets/d/" + this.config.sheet + "/edit" };
  }
  async collect(tabs, start, end) {
    await this.ensure();
    return this.batchValues(tabs.map(tab => rangeFor(tab, typeof start === "object" ? start[tab] : start, typeof end === "object" ? end[tab] : end)));
  }
  async visible(value, tab, row) {
    const record = recordOf(value);
    if (isSecurityCommand(record.content)) {
      if (tab === "messages" && record.type === "message") await inspectSecurityRecord(record, this.config.eco, () => this.redactMemory?.(tab, row));
      return null;
    }
    return record.id ? record : null;
  }
  async readNew(tabs = RECORD_TABS, cursors = { load: this.loadCursor, save: this.saveCursor }) {
    const cursor = cursors.load() || {};
    const state = [2, 3, 4, 5].includes(cursor.version) ? { version: 5, tabs: { ...cursor.tabs } } : { version: 5, tabs: {} };
    if (cursor.version !== 5) { delete state.tabs.messages; delete state.tabs.mensajes; delete state.tabs.acks; }
    if (cursor.version === 2) for (const [previous, tab] of Object.entries(LEGACY_TABS)) {
      if (state.tabs[previous] && !state.tabs[tab]) state.tabs[tab] = state.tabs[previous];
      delete state.tabs[previous];
    }
    delete state.tabs.acuses;
    const starts = Object.fromEntries(tabs.map(tab => [tab, Math.max(FIRST_ROW, Number(state.tabs[tab]?.row) || FIRST_ROW)]));
    const ends = Object.fromEntries(tabs.map(tab => [tab, starts[tab] + BATCH_ROWS - 1]));
    const batches = await this.collect(tabs, starts, ends);
    const records = [];
    let more = false;
    for (const [tabIndex, tab] of tabs.entries()) {
      const values = batches[tabIndex];
      const previous = state.tabs[tab];
      if (previous?.id && values[0]?.[0] !== previous.id) throw new Error("La hoja cambió de orden o se borraron filas. Reconecta para volver a leerla sin perder registros.");
      let processed = previous?.id ? 1 : 0;
      let deferred = false;
      for (let index = processed; index < values.length; index++) {
        const value = values[index];
        const security = securityState();
        if (tab === "messages" && isSecurityCommand(value[8]) && security.enabled && security.lockedUntil > Date.now()) { deferred = true; break; }
        const record = await this.visible(value, tab, starts[tab] + index);
        if (record) records.push(record);
        processed = index + 1;
        if (isWiping()) break;
      }
      if (processed) state.tabs[tab] = { row: starts[tab] + processed - 1, id: values[processed - 1][0] || "" };
      more ||= !deferred && values.length === BATCH_ROWS;
      if (isWiping()) break;
    }
    if (!isWiping()) cursors.save(state);
    return { records, hay_mas: more, contenido_no_confiable: true };
  }
  async search(filters = {}, tabs = RECORD_TABS, consistent = false) {
    if (filters.type) tabs = TYPE_TABS[filters.type] ? [TYPE_TABS[filters.type]] : [];
    await this.ensure();
    if (!consistent && this.visualization && tabs.length) {
      try { return await this.querySearch(filters, tabs); } catch {}
    }
    const records = [];
    const seen = new Set();
    let row = FIRST_ROW;
    while (tabs.length) {
      const batches = await this.collect(tabs, row, row + BATCH_ROWS - 1);
      for (const [tabIndex, tab] of tabs.entries()) for (const [index, value] of batches[tabIndex].entries()) {
        const record = await this.visible(value, tab, row + index);
        if (isWiping()) break;
        if (!record || seen.has(record.id)) continue;
        seen.add(record.id);
        const matches = matchesRecord(record, filters);
        if (matches) records.push(record);
      }
      if (isWiping() || batches.every(values => values.length < BATCH_ROWS)) break;
      row += BATCH_ROWS;
    }
    return { records, contenido_no_confiable: true };
  }
  async querySearch(filters, tabs) {
    const literal = value => '"' + String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\r", "\\r") + '"';
    const clauses = ["A is not null"];
    for (const [key, column] of Object.entries({ type: "E", eco_author: "C", thread: "G", id: "A" })) if (filters[key]) clauses.push(column + " = " + literal(filters[key]));
    if (filters.content) clauses.push("lower(I) contains " + literal(String(filters.content).toLocaleLowerCase()));
    if (filters.tags) {
      const escaped = String(filters.tags).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      clauses.push("J matches " + literal("(^|.*,)[ ]*" + escaped + "[ ]*(,.*|$)"));
    }
    const tq = "select A,B,C,D,E,F,G,H,I,J,K where " + clauses.join(" and ");
    const records = [];
    const seen = new Set();
    for (const tab of tabs) {
      const result = await this.schedule(() => this.visualization(this.config.sheet, { sheet: tab, headers: "1", tqx: "out:json", tq }));
      if (!result.ok) throw new Error("Consulta no disponible.");
      let data = result.data;
      if (typeof data === "string") {
        const match = data.match(/google\.visualization\.Query\.setResponse\(([\s\S]*)\);?\s*$/);
        if (!match) throw new Error("Respuesta de consulta inválida.");
        data = JSON.parse(match[1]);
      }
      if (data.status !== "ok" || !Array.isArray(data.table?.rows) || data.table.cols?.length !== MEMORY_COLUMNS.length) throw new Error("Consulta incompleta.");
      for (const row of data.table.rows) {
        const record = recordOf(row.c.map(cell => cell?.v ?? ""));
        if (!record.id || seen.has(record.id) || isSecurityCommand(record.content) || !matchesRecord(record, filters)) continue;
        seen.add(record.id);
        records.push(record);
      }
    }
    return { records, contenido_no_confiable: true };
  }
  save(args) {
    const pending = this.saving.then(() => this.append(args));
    this.saving = pending.catch(() => {});
    return pending;
  }
  async append(args) {
    if (isSecurityCommand(args?.content)) throw new Error("Las órdenes de seguridad no se guardan mediante el agente.");
    if (!Object.hasOwn(TYPE_TABS, args.type) || !String(args.content || "").trim() || String(args.content).length > MAX_CONTENT) throw new Error("Tipo o contenido inválido (máximo 45000 caracteres).");
    if (args.type === "ack" && !UUID_PATTERN.test(args.reply_to || "")) throw new Error("El acuse debe enlazar el UUID del mensaje original con reply_to.");
    if (args.type === "ack") {
      const original = (await this.search({ id: args.reply_to, type: "message" }, ["messages"])).records[0];
      if (!original) throw new Error("La confirmación debe apuntar a un mensaje existente en messages.");
      args = { ...args, to: args.to || original.eco_author, thread: args.thread || original.thread };
    }
    const id = args.id || crypto.randomUUID();
    if (!UUID_PATTERN.test(id)) throw new Error("El id debe ser un UUID.");
    const existing = (await this.search({ id }, RECORD_TABS, true)).records;
    if (existing.length) {
      if (["content", "type", "to", "thread", "reply_to", "tags", "replaces"].some(key => String(existing[0][key] || "") !== String(args[key] || "")) || existing[0].eco_author !== this.config.eco) throw new Error("El UUID ya pertenece a otro registro.");
      return { ok: true, id, duplicado: true };
    }
    const record = { ...args, id, date: new Date().toISOString(), eco_author: this.config.eco, user_author: this.config.usuario };
    try {
      await this.call("POST", this.path("'" + TYPE_TABS[args.type] + "'!A:K") + ":append", { valueInputOption: "RAW", insertDataOption: "INSERT_ROWS" }, { values: [MEMORY_COLUMNS.map(key => String(record[key] || ""))] });
    } catch (error) { return { error: error.message, id, reintentar: "Repite memoria_guardar con este mismo id; no generes otro." }; }
    return { ok: true, id };
  }
  async agents(action = "listar", changes = {}, identity = {}) {
    await this.ensure();
    if (action === "listar") {
      const values = await this.values("'agents'!A2:J");
      return { agentes: values.filter(value => value[0]).map(value => Object.fromEntries(AGENT_COLUMNS.map((key, index) => [key, String(value[index] ?? "")]))), contenido_no_confiable: true };
    }
    if (action !== "actualizar" || !NAME_PATTERN.test(this.config.eco || "")) throw new Error("Acción o nombre de agente inválido.");
    for (const [key, value] of Object.entries(changes)) if (!["preferences", "stack"].includes(key) || typeof value !== "string" || value.length > AGENT_FIELD_LIMIT) throw new Error("Solo puedes actualizar preferencias y stack propios (máximo 2000 caracteres por campo).");
    const pending = this.agentWriting.then(async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const values = await this.values("'agents'!A2:J");
        const index = values.findIndex(value => value[0] === this.config.eco);
        if (values.filter(value => value[0] === this.config.eco).length > 1) throw new Error("El nombre de este agente está repetido en la hoja.");
        const previous = index < 0 ? {} : Object.fromEntries(AGENT_COLUMNS.map((key, column) => [key, String(values[index][column] ?? "")]));
        const record = { ...previous, ...changes, id: this.config.eco, class: "eco", model: identity.model || "", alias: this.config.usuario || "", peripherals: identity.peripherals || "", status: "activo", version: identity.version || "", updated: new Date().toISOString() };
        const data = [AGENT_COLUMNS.map(key => String(record[key] ?? ""))];
        if (index >= 0) await this.call("PUT", this.path("'agents'!A" + (index + FIRST_ROW) + ":J" + (index + FIRST_ROW)), { valueInputOption: "RAW" }, { values: data });
        else {
          const name = "eco_agente_" + this.config.eco.replaceAll("-", "_");
          try {
            await this.batch([
              { addNamedRange: { namedRange: { namedRangeId: name, name, range: { sheetId: this.structure.tabs.agents, startColumnIndex: 0, endColumnIndex: AGENT_COLUMNS.length } } } },
              { appendCells: { sheetId: this.structure.tabs.agents, rows: rows(data), fields: "userEnteredValue" } }
            ]);
          } catch (error) { if (attempt) throw error; continue; }
        }
        return { ok: true, agente: record };
      }
    });
    this.agentWriting = pending.catch(() => {});
    return pending;
  }
  async routines(action = "listar", changes = {}) {
    await this.ensure();
    if (action === "listar") {
      const values = await this.values("'routines'!A2:K");
      return { rutinas: values.filter(value => value[0] && value[3] === this.config.eco).map(value => Object.fromEntries(ROUTINE_COLUMNS.map((key, index) => [key, String(value[index] ?? "")]))), contenido_no_confiable: true };
    }
    if (action !== "actualizar") throw new Error("Acción de rutina inválida.");
    const pending = this.routineWriting.then(async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const values = await this.values("'routines'!A2:K");
        const matches = values.map((value, index) => ({ value, index })).filter(item => item.value[0] === changes.id);
        if (matches.length > 1) throw new Error("El id de rutina está repetido.");
        const index = matches[0]?.index ?? -1;
        const previous = index < 0 ? {} : Object.fromEntries(ROUTINE_COLUMNS.map((key, column) => [key, String(values[index][column] ?? "")]));
        const record = routineRecord(this.config, changes, previous);
        const data = [ROUTINE_COLUMNS.map(key => record[key])];
        if (index >= 0) await this.call("PUT", this.path("'routines'!A" + (index + FIRST_ROW) + ":K" + (index + FIRST_ROW)), { valueInputOption: "RAW" }, { values: data });
        else {
          const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(record.id));
          const name = "eco_routine_" + [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
          try {
            await this.batch([
              { addNamedRange: { namedRange: { namedRangeId: name, name, range: { sheetId: this.structure.tabs.routines, startColumnIndex: 0, endColumnIndex: ROUTINE_COLUMNS.length } } } },
              { appendCells: { sheetId: this.structure.tabs.routines, rows: rows(data), fields: "userEnteredValue" } }
            ]);
          } catch (error) { if (attempt) throw error; continue; }
        }
        return { ok: true, rutina: record };
      }
    });
    this.routineWriting = pending.catch(() => {});
    return pending;
  }

}
