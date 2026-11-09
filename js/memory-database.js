import { MemoryBackend, MEMORY_COLUMNS, AGENT_COLUMNS, ROUTINE_COLUMNS, MEMORY_TABLES, routineRecord, MEMORY_PROTOCOL, TYPE_TABS, RECORD_TABS, PROTOCOL_VERSION, normalizeRecord, matchesRecord } from "./memory-protocol.js";
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
    this.execute = dependencies.execute;
    this.preparing = null;
    this.writing = Promise.resolve();
  }
  ensure() {
    if (!this.preparing) this.preparing = this.validate().catch(error => { this.preparing = null; throw error; });
    return this.preparing;
  }
  async validate() {
    const result = await this.execute("schema", { protocol: MEMORY_PROTOCOL, columns: MEMORY_COLUMNS, agents: AGENT_COLUMNS, routines: ROUTINE_COLUMNS, tables: [...MEMORY_TABLES, "_eco"] });
    const protocol = Object.fromEntries(Array.isArray(result) ? result.map(row => [row.key, row.value]) : result.protocol || []);
    if (protocol.protocol !== "eco-memoria" || protocol.version !== PROTOCOL_VERSION || protocol.tables !== MEMORY_TABLES.join(",") || protocol.columns !== MEMORY_COLUMNS.join(",") || protocol.agents !== AGENT_COLUMNS.join(",") || protocol.routines !== ROUTINE_COLUMNS.join(",")) throw new Error("La base no usa eco-memoria v5. Crea las tablas y el protocolo con la habilidad de bases de datos.");
    return { protocol: "eco-memoria", version: PROTOCOL_VERSION };
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
        if (!Array.isArray(received) || received.length > PAGE) throw new Error("La consulta debe devolver un lote de hasta 100 registros.");
        const values = received.map(normalize);
        for (const row of values) {
          const record = await this.visible(row, table);
          if (record && !seen.has(record.id) && matchesRecord(record, filters)) { seen.add(record.id); records.push(record); }
        }
        if (values.length < PAGE) break;
        const next = { date: values.at(-1).date, id: values.at(-1).id };
        if (!next.date || !UUID.test(next.id) || JSON.stringify(next) === JSON.stringify(cursor)) throw new Error("Cursor de base de datos inválido.");
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
      if (!Array.isArray(received) || received.length > PAGE) throw new Error("Lote de novedades inválido.");
      const values = received.map(normalize);
      let deferred = false;
      for (const row of values) {
        const security = securityState();
        if (table === "messages" && isSecurityCommand(row.content) && security.enabled && security.lockedUntil > Date.now()) { deferred = true; break; }
        if (!row.date || !UUID.test(row.id)) throw new Error("Cursor de base de datos inválido.");
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
    if (isSecurityCommand(args?.content)) throw new Error("Las órdenes de seguridad no se guardan mediante el agente.");
    if (!Object.hasOwn(TYPE_TABS, args.type) || !String(args.content || "").trim() || String(args.content).length > 45000) throw new Error("Tipo o contenido inválido (máximo 45000 caracteres).");
    if (args.type === "ack" && !UUID.test(args.reply_to || "")) throw new Error("El acuse debe enlazar el UUID del mensaje original con reply_to.");
    if (args.type === "ack") {
      const original = (await this.search({ id: args.reply_to, type: "message" }, ["messages"])).records[0];
      if (!original) throw new Error("La confirmación debe apuntar a un mensaje existente en messages.");
      args = { ...args, to: args.to || original.eco_author, thread: args.thread || original.thread };
    }
    const id = args.id || crypto.randomUUID();
    if (!UUID.test(id)) throw new Error("El id debe ser un UUID.");
    const existing = (await this.search({ id })).records[0];
    if (existing) {
      if (existing.eco_author !== this.config.eco || ["content", "type", "to", "thread", "reply_to", "tags", "replaces"].some(key => (key === "tags" ? tags(existing[key]) !== tags(args[key]) : String(existing[key] || "") !== String(args[key] || "")))) throw new Error("El UUID ya pertenece a otro registro.");
      return { ok: true, id, duplicado: true };
    }
    const record = Object.fromEntries(MEMORY_COLUMNS.filter(key => key !== "date").map(key => [key, String(args[key] || "")]));
    record.tags = tags(record.tags);
    Object.assign(record, { id, eco_author: this.config.eco, user_author: this.config.usuario });
    try { await this.execute("save", { table: TYPE_TABS[args.type], record }); }
    catch (error) { return { error: error.message, id, reintentar: "Repite memoria_guardar con este mismo id; no generes otro." }; }
    return { ok: true, id };
  }
  async agents(action = "listar", changes = {}, identity = {}) {
    await this.ensure();
    if (action === "listar") return { agentes: await this.execute("agents", { action }), contenido_no_confiable: true };
    if (action !== "actualizar" || !NAME.test(this.config.eco || "")) throw new Error("Acción o nombre de agente inválido.");
    for (const [key, value] of Object.entries(changes)) if (!["preferences", "stack"].includes(key) || typeof value !== "string" || value.length > 2000) throw new Error("Solo puedes actualizar preferencias y stack propios (máximo 2000 caracteres por campo).");
    const pending = this.writing.then(async () => {
      const previous = (await this.execute("agents", { action: "listar", id: this.config.eco }))[0] || {};
      const record = Object.fromEntries(AGENT_COLUMNS.map(key => [key, String(previous[key] || "")]));
      Object.assign(record, changes, { id: this.config.eco, class: "eco", model: identity.model || "", alias: this.config.usuario || "", peripherals: identity.peripherals || "", status: "activo", version: identity.version || "", updated: new Date().toISOString() });
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
      if (!Array.isArray(values)) throw new Error("Directorio de rutinas inválido.");
      return { rutinas: values.filter(row => row.agent_id === this.config.eco), contenido_no_confiable: true };
    }
    if (action !== "actualizar") throw new Error("Acción de rutina inválida.");
    const pending = this.writing.then(async () => {
      routineRecord(this.config, { name: "Rutina", ...changes });
      const previous = await this.execute("routines", { action: "obtener", id: changes.id });
      if (!Array.isArray(previous) || previous.length > 1) throw new Error("Id de rutina inválido o repetido.");
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
    this.execute = (action, args) => this.query(action, args);
  }
  async call(method, table, query = {}, body = null, upsert = false) {
    if (isWiping()) throw new Error("Memoria detenida");
    if (![...MEMORY_TABLES, "_eco"].includes(table)) throw new Error("Tabla no compatible.");
    const result = await this.request(method, "/rest/v1/" + table, query, body, upsert);
    if (!result.ok) throw new Error(result.error === "not_connected" ? "Reconecta las credenciales de la base de datos." : "No se pudo consultar la base de datos. Revisa tablas, permisos y políticas de acceso.");
    if (result.redactMemory) this.redactMemory = result.redactMemory;
    return result.data;
  }
  async validate() {
    const result = await super.validate();
    for (const table of MEMORY_TABLES) await this.call("GET", table, { select: (table === "agents" ? AGENT_COLUMNS : table === "routines" ? ROUTINE_COLUMNS : MEMORY_COLUMNS).join(","), limit: "0" });
    return result;
  }
  async query(action, args) {
    if (action === "schema") return this.call("GET", "_eco", { select: "key,value" });
    if (action === "save") return this.call("POST", args.table, {}, { ...args.record, tags: args.record.tags.split(",").map(tag => tag.trim()).filter(Boolean) });
    if (action === "redact") return this.call("PATCH", "messages", { id: "eq." + args.id }, { content: "[orden de seguridad retirada]" });
    if (action === "routines") {
      if (args.action === "actualizar") return this.call("POST", "routines", { on_conflict: "id" }, args.record, true);
      const records = [];
      let after = "";
      while (true) {
        const query = { select: ROUTINE_COLUMNS.join(","), order: "id.asc", limit: String(PAGE) };
        if (args.agent_id) query.agent_id = "eq." + args.agent_id;
        if (args.id) query.id = "eq." + args.id;
        else if (after) query.id = "gt." + after;
        const batch = await this.call("GET", "routines", query);
        if (!Array.isArray(batch)) throw new Error("Directorio de rutinas inválido.");
        records.push(...batch);
        if (args.id || batch.length < PAGE) return records;
        if (after === batch.at(-1).id) throw new Error("Cursor de rutinas inválido.");
        after = batch.at(-1).id;
      }
    }
    if (action === "agents") {
      if (args.action === "actualizar") return this.call("POST", "agents", { on_conflict: "id" }, args.record, true);
      const records = [];
      let after = "";
      while (true) {
        const batch = await this.call("GET", "agents", { select: AGENT_COLUMNS.join(","), order: "id.asc", limit: String(PAGE), ...(args.id ? { id: "eq." + args.id } : after ? { id: "gt." + after } : {}) });
        if (!Array.isArray(batch)) throw new Error("Directorio de agentes inválido.");
        records.push(...batch);
        if (args.id || batch.length < PAGE) return records;
        if (after === batch.at(-1).id) throw new Error("Cursor de agentes inválido.");
        after = batch.at(-1).id;
      }
    }
    const filters = args.filters || {};
    const query = { select: MEMORY_COLUMNS.join(","), order: "date.asc,id.asc", limit: String(args.limit) };
    for (const [key, column] of Object.entries({ type: "type", eco_author: "eco_author", thread: "thread", id: "id" })) if (filters[key]) query[column] = "eq." + filters[key];
    if (filters.content) query.content = String(filters.content).includes("*")
      ? "imatch." + String(filters.content).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      : "ilike.*" + String(filters.content).replace(/[\\%_]/g, "\\$&") + "*";
    if (filters.tags) query.tags = "cs.{" + literal(filters.tags) + "}";
    if (args.cursor) {
      if (!UUID.test(args.cursor.id) || !/^\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d)$/.test(args.cursor.date)) throw new Error("Cursor de base de datos inválido.");
      query.or = "(date.gt." + literal(args.cursor.date) + ",and(date.eq." + literal(args.cursor.date) + ",id.gt." + args.cursor.id + "))";
    }
    return this.call("GET", args.table, query);
  }
}
