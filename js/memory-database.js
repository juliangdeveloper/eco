import { MemoryBackend, MEMORY_COLUMNS, AGENT_COLUMNS, ROUTINE_COLUMNS, MEMORY_TABLES, routineRecord, MEMORY_PROTOCOL, TYPE_TABS, RECORD_TABS, PROTOCOL_VERSION, normalizeRecord, matchesRecord, replacementCheck } from "./memory-protocol.js";
import { foldName, SCHEMA_COLUMNS, parseMap, mergeMap, resolveSchema, snapshotMap, decodeRow, requireTable } from "./memory-schema.js";
import { inspectSecurityRecord, isSecurityCommand, isWiping, securityState } from "./security.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PAGE = 100;
const tags = value => String(value || "").split(",").map(tag => tag.trim()).filter(Boolean).join(",");
const normalize = normalizeRecord;
const literal = value => '"' + String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';

export class DatabaseMemory extends MemoryBackend {
  constructor(dependencies) {
    super(dependencies);
    this.transport = dependencies.execute;
    this.execute = (action, args) => this.mappedExecute(action, args);
    this.mapping = parseMap(this.config.map);
    try { this.mapping = parseMap(localStorage.getItem("eco.databaseSchema:" + this.config.connector) || this.config.map); } catch {}
    this.preparing = null;
    this.writing = Promise.resolve();
  }
  ensure() {
    if (!this.preparing) this.preparing = this.validate().finally(() => { this.preparing = null; });
    return this.preparing;
  }
  async validate(overrides = null) {
    const result = await this.transport("schema", { stage: "inspect", protocol: MEMORY_PROTOCOL, columns: MEMORY_COLUMNS, agents: AGENT_COLUMNS, routines: ROUTINE_COLUMNS, tables: Object.keys(SCHEMA_COLUMNS) });
    let tables = result?.tables;
    let protocol = Array.isArray(result) ? result.filter(row => row.key !== undefined || row.clave !== undefined).map(row => [row.key ?? row.clave, row.value ?? row.valor]) : result?.protocol || [];
    if (!tables && Array.isArray(result) && (!result.length || result.some(row => row.table_name))) {
      const names = [...new Set(result.map(row => row.table_name))];
      tables = names.map(name => ({ name, headers: result.filter(row => row.table_name === name).sort((a, b) => Number(a.ordinal_position) - Number(b.ordinal_position)).map(row => row.column_name) }));
    }
    const discovered = Array.isArray(tables);
    if (!discovered) tables = Object.entries(SCHEMA_COLUMNS).map(([name, headers]) => ({ name: this.mapping.tables[name]?.name || name, headers: this.mapping.tables[name]?.headers || headers }));
    tables = tables.map(table => ({ name: table.name, headers: [...(table.headers || table.columns || [])] }));
    let schema = resolveSchema(tables, overrides ? mergeMap(this.mapping, overrides) : this.mapping);
    if (!schema.tables._eco.name) {
      const candidates = tables.filter(table => { const names = table.headers.map(foldName); return names.some(name => ["key", "clave"].includes(name)) && names.some(name => ["value", "valor"].includes(name)); });
      if (candidates.length === 1) { this.mapping = mergeMap(this.mapping, { tables: { _eco: { name: candidates[0].name } } }); schema = resolveSchema(tables, overrides ? mergeMap(this.mapping, overrides) : this.mapping); }
    }
    const metadata = schema.tables._eco;
    if (discovered && metadata.name && metadata.fields.key !== undefined && metadata.fields.value !== undefined) {
      const rows = await this.transport("schema", { stage: "protocol", table: metadata.name, columns: Object.fromEntries(Object.entries(metadata.fields).map(([key, index]) => [key, metadata.headers[index]])) });
      protocol = (rows || []).map(row => [row.key ?? row[metadata.headers[metadata.fields.key]], row.value ?? row[metadata.headers[metadata.fields.value]]]);
    }
    const entry = protocol.find(row => row[0] === "map");
    const remote = entry ? parseMap(entry[1]) : this.mapping;
    this.mapping = overrides ? mergeMap(remote, overrides) : remote;
    schema = resolveSchema(tables, this.mapping);
    const reserved = new Set(Object.values(schema.tables).map(table => table.name).filter(Boolean)), additions = [];
    if (discovered) for (const [logical, table] of Object.entries(schema.tables)) {
      if (!table.name && !tables.some(item => item.name === logical) && !table.candidates.some(name => !reserved.has(name))) additions.push({ logical, name: logical, columns: [...SCHEMA_COLUMNS[logical]], create: true });
      else if (table.name) { const saved = this.mapping.tables[logical], deleted = saved?.headers && table.unknown.every(column => saved.headers.includes(column.name)); const columns = table.unmapped.filter(key => saved?.columns?.[key] === null || !table.unknown.length || deleted && Object.hasOwn(saved.columns || {}, key)); if (columns.length) additions.push({ logical, name: table.name, columns, create: false }); }
    }
    let additionError = false;
    if (additions.length && !this.readOnlyDDL) {
      try {
      await this.transport("schema", { stage: "add", additions });
      for (const item of additions) {
        const table = tables.find(table => table.name === item.name);
        if (table) table.headers.push(...item.columns); else tables.push({ name: item.name, headers: [...item.columns] });
        const columns = Object.fromEntries(item.columns.map(key => [key, key]));
        this.mapping = mergeMap(this.mapping, { tables: { [item.logical]: { name: item.name, columns } } });
      }
      schema = resolveSchema(tables, this.mapping);
      } catch { additionError = true; }
    }
    this.structure = { ...schema, additions_needed: this.readOnlyDDL || additionError ? additions : [], catalog_available: discovered, ...(additionError ? { warning: "Missing fields or tables could not be added; existing data is kept." } : {}) };
    const map = snapshotMap(schema), serialized = JSON.stringify(map);
    this.mapping = map; this.config.map = map;
    try { localStorage.setItem("eco.databaseSchema:" + this.config.connector, serialized); } catch {}
    const target = schema.tables._eco;
    this.structure.map_shared = Boolean(entry && entry[1] === serialized);
    if (target.name && target.fields.key !== undefined && target.fields.value !== undefined && (!entry || entry[1] !== serialized)) { try { await this.transport("schema", { stage: "map", table: target.name, columns: Object.fromEntries(Object.entries(target.fields).map(([key, index]) => [key, target.headers[index]])), value: serialized, exists: Boolean(entry) }); this.structure.map_shared = true; } catch { this.structure.warning = "Local map: missing permissions to save the map row in _eco."; } }
    return { protocol: "eco-memoria", version: PROTOCOL_VERSION, ...this.structure };
  }
  async schema(action = "ver", changes = {}) {
    if (!["ver", "ajustar"].includes(action)) throw new Error("Invalid schema action.");
    if (action === "ajustar") await this.validate(changes); else await this.ensure();
    return { mapa: snapshotMap(this.structure), ...this.structure, contenido_no_confiable: true };
  }
  async mappedExecute(action, args) {
    const logical = ["agents", "routines"].includes(action) ? action : action === "redact" ? "messages" : args.table;
    const table = requireTable(this.structure, logical);
    const fields = Object.fromEntries(Object.entries(table.fields).map(([key, index]) => [key, table.headers[index]]));
    const translated = { ...args, table: table.name, logical, columns: fields };
    if (args.record) translated.record = Object.fromEntries(Object.entries(args.record).filter(([key]) => fields[key] !== undefined).map(([key, value]) => [fields[key], value]));
    const result = await this.transport(action, translated);
    if (!Array.isArray(result)) return result;
    return result.map(row => decodeRow(table, table.headers.map(name => row[name])));
  }
  async connect() { return { ...this.config, ...await this.ensure() }; }
  async visible(row, tab) {
    const record = normalize(row);
    if (isSecurityCommand(record.content)) {
      if (tab === "messages" && record.type === "message") await inspectSecurityRecord(record, this.config.eco, () => this.redactMemory ? this.redactMemory(record.id) : this.execute("redact", { table: tab, id: record.id }));
      return null;
    }
    return record.id ? record : null;
  }
  async search(filters = {}, tabs = RECORD_TABS) {
    await this.ensure();
    if (filters.type) tabs = TYPE_TABS[filters.type] ? [TYPE_TABS[filters.type]] : [];
    const records = [];
    const seen = new Set();
    for (const table of tabs) {
      let cursor = null;
      while (!isWiping()) {
        const received = await this.execute("search", { table, filters, cursor, limit: PAGE });
        if (!Array.isArray(received) || received.length > PAGE) throw new Error("The query must return a batch of up to 100 records.");
        const values = received.map(normalize);
        for (const row of values) {
          const record = await this.visible(row, table);
          if (record && !seen.has(record.id) && matchesRecord(record, filters)) { seen.add(record.id); records.push(record); }
        }
        if (values.length < PAGE) break;
        const next = { date: values.at(-1).date, id: values.at(-1).id };
        if (!next.date || !UUID.test(next.id) || JSON.stringify(next) === JSON.stringify(cursor)) throw new Error("Invalid database cursor.");
        cursor = next;
      }
    }
    return { records, contenido_no_confiable: true };
  }
  async readNew(tabs = RECORD_TABS, cursors = { load: this.loadCursor, save: this.saveCursor }) {
    await this.ensure();
    const previous = cursors.load();
    const state = [3, 4, 5].includes(previous?.version) ? { version: 5, tabs: { ...previous.tabs } } : { version: 5, tabs: {} };
    if (previous?.version !== 5) delete state.tabs.acks;
    for (const cursor of Object.values(state.tabs)) if (cursor.fecha && !cursor.date) { cursor.date = cursor.fecha; delete cursor.fecha; }
    const records = [];
    let more = false;
    for (const table of tabs) {
      const received = await this.execute("new", { table, cursor: state.tabs[table] || null, limit: PAGE });
      if (!Array.isArray(received) || received.length > PAGE) throw new Error("Invalid batch of new records.");
      const values = received.map(normalize);
      let deferred = false;
      for (const row of values) {
        const security = securityState();
        if (table === "messages" && isSecurityCommand(row.content) && security.enabled && security.lockedUntil > Date.now()) { deferred = true; break; }
        if (!row.date || !UUID.test(row.id)) throw new Error("Invalid database cursor.");
        const record = await this.visible(row, table);
        if (record) records.push(record);
        state.tabs[table] = { date: row.date, id: row.id };
        if (isWiping()) break;
      }
      more ||= !deferred && values.length === PAGE;
      if (isWiping()) break;
    }
    if (!isWiping()) cursors.save(state);
    return { records, hay_mas: more, contenido_no_confiable: true };
  }
  save(args) {
    const pending = this.writing.then(() => this.append(args));
    this.writing = pending.catch(() => {});
    return pending;
  }
  async append(args) {
    if (isSecurityCommand(args?.content)) throw new Error("Security commands are not saved through the agent.");
    if (!Object.hasOwn(TYPE_TABS, args.type) || !String(args.content || "").trim() || String(args.content).length > 45000) throw new Error("Invalid type or content (up to 45000 characters).");
    if (args.type === "ack" && !UUID.test(args.reply_to || "")) throw new Error("The ack must link the original message's UUID with reply_to.");
    if (args.type === "ack") {
      const original = (await this.search({ id: args.reply_to, type: "message" }, ["messages"])).records[0];
      if (!original && !args.copia) throw new Error("The ack must point to an existing message in messages.");
      args = { ...args, to: args.to || original?.eco_author || "", thread: args.thread || original?.thread || "" };
    }
    const id = args.id || crypto.randomUUID();
    if (!UUID.test(id)) throw new Error("The id must be a UUID.");
    const existing = (await this.search({ id })).records[0];
    if (existing) {
      if (existing.eco_author !== this.config.eco || ["content", "type", "to", "thread", "reply_to", "tags", "replaces"].some(key => (key === "tags" ? tags(existing[key]) !== tags(args[key]) : String(existing[key] || "") !== String(args[key] || "")))) throw new Error("The UUID already belongs to another record.");
      if (existing.type === "fact" && UUID.test(args.replaces || "")) await this.execute("remove", { table: "memories", id: args.replaces }).catch(() => {});
      return { ok: true, id, duplicado: true };
    }
    const replacing = replacementCheck({ ...args, id }, args.replaces && UUID.test(args.replaces) ? (await this.search({ id: args.replaces })).records[0] : null, !args.copia);
    const record = Object.fromEntries(MEMORY_COLUMNS.filter(key => key !== "date").map(key => [key, String(args[key] || "")]));
    record.tags = tags(record.tags);
    Object.assign(record, { id, eco_author: this.config.eco, user_author: this.config.usuario });
    try { await this.execute("save", { table: TYPE_TABS[args.type], record }); }
    catch (error) { return { error: error.message, id, reintentar: "Repeat memoria_guardar with this same id; don't generate another." }; }
    if (!replacing) return { ok: true, id };
    try { await this.execute("remove", { table: "memories", id: args.replaces }); return { ok: true, id, reemplazado: args.replaces }; }
    catch { return { ok: true, id, aviso: "The previous fact is still in the database; it is superseded through replaces." }; }
  }
  async agents(action = "listar", changes = {}, identity = {}) {
    await this.ensure();
    if (action === "listar") return { agentes: await this.execute("agents", { action }), contenido_no_confiable: true };
    if (action !== "actualizar" || !NAME.test(this.config.eco || "")) throw new Error("Invalid action or agent name.");
    for (const [key, value] of Object.entries(changes)) if (!["preferences", "stack"].includes(key) || typeof value !== "string" || value.length > 2000) throw new Error("You can only update your own preferences and stack (up to 2000 characters per field).");
    const pending = this.writing.then(async () => {
      const previous = (await this.execute("agents", { action: "listar", id: this.config.eco }))[0] || {};
      const record = Object.fromEntries(AGENT_COLUMNS.map(key => [key, String(previous[key] || "")]));
      Object.assign(record, changes, { id: this.config.eco, class: "eco", model: identity.model || "", alias: this.config.usuario || "", peripherals: identity.peripherals || "", status: "activo", version: identity.version || "", updated: new Date().toISOString(), ip: identity.ip || String(previous.ip || "") });
      await this.execute("agents", { action: "actualizar", record });
      return { ok: true, agente: record };
    });
    this.writing = pending.catch(() => {});
    return pending;
  }
  async routines(action = "listar", changes = {}) {
    await this.ensure();
    if (action === "listar") {
      const values = await this.execute("routines", { action, agent_id: this.config.eco });
      if (!Array.isArray(values)) throw new Error("Invalid routine directory.");
      return { rutinas: values.filter(row => row.agent_id === this.config.eco), contenido_no_confiable: true };
    }
    if (action !== "actualizar") throw new Error("Invalid routine action.");
    const pending = this.writing.then(async () => {
      routineRecord(this.config, { name: "Routine", ...changes });
      const previous = await this.execute("routines", { action: "obtener", id: changes.id });
      if (!Array.isArray(previous) || previous.length > 1) throw new Error("Invalid or repeated routine id.");
      const record = routineRecord(this.config, changes, previous[0] || {});
      await this.execute("routines", { action: "actualizar", record, agent_id: this.config.eco });
      return { ok: true, rutina: record };
    });
    this.writing = pending.catch(() => {});
    return pending;
  }

}

export class SupabaseMemory extends DatabaseMemory {
  constructor(dependencies) {
    super(dependencies);
    this.request = dependencies.request;
    this.readOnlyDDL = true;
    this.transport = (action, args) => this.query(action, args);
  }
  async call(method, table, query = {}, body = null, upsert = false) {
    if (isWiping()) throw new Error("Memory stopped");
    const result = await this.request(method, "/rest/v1/" + encodeURIComponent(table), query, body, upsert);
    if (!result.ok) throw new Error(result.error === "not_connected" ? "Reconnect the database credentials." : "Could not query the database. Check the memory map and its table permissions.");
    if (result.redactMemory && table === this.structure?.tables.messages?.name) { const mapped = this.structure.tables.messages; this.redactMemory = id => result.redactMemory(id, { id: mapped.headers[mapped.fields.id], content: mapped.headers[mapped.fields.content] }); }
    return result.data;
  }
  async query(action, args) {
    const quote = name => '"' + String(name).replaceAll('"', '\\"') + '"';
    if (action === "schema") {
      if (args.stage === "inspect") {
        const data = await this.call("GET", "");
        if (!data?.definitions && !data?.components?.schemas) throw new Error("The connector must allow discovering the database tables to adapt memoria_esquema.");
        return { tables: Object.entries(data.definitions || data.components.schemas).filter(([, table]) => table.properties).map(([name, table]) => ({ name, headers: Object.keys(table.properties) })) };
      }
      if (args.stage === "protocol") return this.call("GET", args.table, { select: Object.values(args.columns).map(quote).join(",") });
      if (args.stage === "map") return args.exists ? this.call("PATCH", args.table, { [args.columns.key]: "eq.map" }, { [args.columns.value]: args.value }) : this.call("POST", args.table, {}, { [args.columns.key]: "map", [args.columns.value]: args.value });
      throw new Error("PostgREST does not run DDL. Use a SQL connection to add missing columns or tables; don't rename or delete data.");
    }
    const columns = args.columns, field = key => columns[key], quoted = quote;
    if (action === "save") { const record = { ...args.record }; if (typeof record[field("tags")] === "string") record[field("tags")] = record[field("tags")].split(",").map(tag => tag.trim()).filter(Boolean); return this.call("POST", args.table, {}, record); }
    if (action === "remove") return this.call("DELETE", args.table, { [field("id")]: "eq." + args.id, [field("type")]: "in.(fact,dato)" });
    if (action === "redact") return this.call("PATCH", args.table, { [field("id")]: "eq." + args.id }, { [field("content")]: "[orden de seguridad retirada]" });
    if (["agents", "routines"].includes(action)) {
      if (args.action === "actualizar") return this.call("POST", args.table, { on_conflict: quoted(field("id")) }, args.record, true);
      const records = []; let after = "";
      while (true) {
        const query = { select: Object.values(columns).map(quoted).join(","), order: quoted(field("id")) + ".asc", limit: "100" };
        if (args.agent_id) query[field("agent_id")] = "eq." + args.agent_id;
        if (args.id) query[field("id")] = "eq." + args.id; else if (after) query[field("id")] = "gt." + after;
        const batch = await this.call("GET", args.table, query);
        if (!Array.isArray(batch)) throw new Error("Invalid directory.");
        records.push(...batch);
        if (args.id || batch.length < PAGE) return records;
        if (after === batch.at(-1)[field("id")]) throw new Error("Invalid directory cursor.");
        after = batch.at(-1)[field("id")];
      }
    }
    const filters = args.filters || {}, query = { select: Object.values(columns).map(quoted).join(","), order: quoted(field("date")) + ".asc," + quoted(field("id")) + ".asc", limit: String(args.limit) };
    for (const key of ["type", "eco_author", "thread", "id"]) if (filters[key]) { const old = { memory: "recuerdo", fact: "dato", message: "mensaje", ack: "acuse" }[filters[key]]; query[field(key)] = key === "type" && old ? "in.(" + filters[key] + "," + old + ")" : "eq." + filters[key]; }
    if (filters.content) query[field("content")] = "ilike.*" + String(filters.content).replace(/[\\%_]/g, "\\$&") + "*";
    if (filters.tags) query[field("tags")] = "cs.{" + literal(filters.tags) + "}";
    if (args.cursor) {
      if (!UUID.test(args.cursor.id) || !/^\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d)$/.test(args.cursor.date)) throw new Error("Invalid database cursor.");
      query.or = "(" + quoted(field("date")) + ".gt." + literal(args.cursor.date) + ",and(" + quoted(field("date")) + ".eq." + literal(args.cursor.date) + "," + quoted(field("id")) + ".gt." + args.cursor.id + "))";
    }
    return this.call("GET", args.table, query);
  }
}
