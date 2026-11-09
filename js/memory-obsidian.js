import { MEMORY_COLUMNS, MEMORY_PROTOCOL, PROTOCOL_VERSION, RECORD_TABS, TYPE_TABS, MemoryBackend, matchesRecord, replacementCheck, routineRecord } from "./memory-protocol.js";
import { SCHEMA_COLUMNS, parseMap, mergeMap, resolveSchema, snapshotMap, decodeRow, requireTable } from "./memory-schema.js";
import { inspectSecurityRecord, isSecurityCommand, isWiping, securityState } from "./security.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PAGE = 100;
const BODY = "content";
const PLAIN_KEY = /^[A-Za-z_][\w-]*$/;

function parseScalar(raw) {
  const text = raw.trim();
  if (/^["[{]/.test(text)) { try { return JSON.parse(text); } catch {} }
  if (/^'.*'$/.test(text)) return text.slice(1, -1).replaceAll("''", "'");
  return text;
}

export function parseNote(text) {
  const source = String(text ?? "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const match = source.match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
  if (!match) return { front: {}, body: source.replace(/\n$/, "") };
  const front = {};
  let last = null;
  for (const line of match[1].split("\n")) {
    const item = line.match(/^\s+-\s*(.*)$/);
    if (item && last !== null) { if (!Array.isArray(front[last])) front[last] = []; front[last].push(parseScalar(item[1])); continue; }
    const pair = line.match(/^("(?:[^"\\]|\\.)*"|[^\s:#][^:]*?)\s*:(?:\s+(.*))?$/);
    if (!pair) continue;
    let key = pair[1];
    if (key.startsWith('"')) { try { key = JSON.parse(key); } catch { continue; } }
    last = key;
    front[key] = pair[2] === undefined || pair[2] === "" ? "" : parseScalar(pair[2]);
  }
  return { front, body: match[2].replace(/\n$/, "") };
}

export function serializeNote(front, body = "") {
  const lines = Object.entries(front).map(([key, value]) => (PLAIN_KEY.test(key) ? key : JSON.stringify(key)) + ": " + (Array.isArray(value) ? JSON.stringify(value.map(String)) : JSON.stringify(String(value ?? ""))));
  return "---\n" + lines.join("\n") + "\n---\n" + String(body ?? "") + "\n";
}

const listTags = value => String(value || "").split(",").map(tag => tag.trim()).filter(Boolean);

export class ObsidianMemory extends MemoryBackend {
  constructor(dependencies) {
    super(dependencies);
    this.files = dependencies.files;
    this.root = String(this.config.folder || "Eco").replace(/^\/+|\/+$/g, "");
    this.mapping = parseMap(this.config.map);
    try { this.mapping = parseMap(localStorage.getItem("eco.obsidianSchema:" + this.config.connector + ":" + this.root) || this.config.map); } catch {}
    this.notes = new Map();
    this.preparing = null;
    this.inspected = 0;
    this.writing = Promise.resolve();
  }
  path(...parts) { return [this.root, ...parts].filter(Boolean).join("/"); }
  async list(dir) {
    if (this.known && !this.known.has(dir)) return [];
    const entries = await this.files.list(dir);
    const prefix = dir + "/";
    return [...new Set((entries || []).map(String).map(name => name.startsWith(prefix) ? name.slice(prefix.length) : name).filter(name => name && !name.slice(0, -1).includes("/")))];
  }
  async note(path, cache = false) {
    if (cache && this.notes.has(path)) return this.notes.get(path);
    const text = await this.files.read(path);
    if (text === null || text === undefined) { this.notes.delete(path); return null; }
    const parsed = parseNote(text);
    if (cache) this.notes.set(path, parsed);
    return parsed;
  }
  row(table, note) { return table.headers.map(header => Object.hasOwn(note.front, header) ? note.front[header] : header === BODY ? note.body : undefined); }
  async inspect(overrides = null) {
    if (isWiping()) throw new Error("Memoria detenida");
    this.known = null;
    let parent = "", present = true;
    for (const part of this.root.split("/")) {
      const names = await this.list(parent);
      parent = parent ? parent + "/" + part : part;
      if (!names.includes(part + "/")) { present = false; break; }
    }
    const entries = present ? await this.list(this.root) : [];
    this.known = new Set([this.root, ...entries.filter(name => name.endsWith("/")).map(name => this.path(name.slice(0, -1)))]);
    const protocolNote = entries.includes("_eco.md") ? await this.note(this.path("_eco.md")) : null;
    const remote = protocolNote?.front?.map ? parseMap(protocolNote.front.map) : null;
    this.protocolNote = protocolNote;
    this.mapping = overrides ? mergeMap(remote || this.mapping, overrides) : remote || this.mapping;
    const folders = entries.filter(name => name.endsWith("/")).map(name => name.slice(0, -1));
    const tables = [{ name: "_eco", headers: ["key", "value"] }];
    for (const folder of folders) {
      const names = (await this.list(this.path(folder))).filter(name => name.endsWith(".md"));
      const notes = [];
      for (const name of names.slice(0, 20)) { const note = await this.note(this.path(folder, name), true); if (note) notes.push(Object.keys(note.front)); }
      tables.push({ name: folder, headers: [...new Set(notes.flat())], notes });
    }
    for (const [logical, entry] of Object.entries(this.mapping.tables)) if (logical !== "_eco" && entry.name && !tables.some(table => table.name === entry.name)) tables.push({ name: entry.name, headers: [] });
    let schema = resolveSchema(tables, this.mapping);
    for (const [logical, resolved] of Object.entries(schema.tables)) {
      const table = tables.find(item => item.name === resolved.name);
      if (logical === "_eco" || !table?.notes) continue;
      const saved = { ...this.mapping.tables[logical], name: table.name };
      const records = table.notes.filter(keys => Object.keys(resolveSchema([{ name: table.name, headers: keys }], { tables: { [logical]: saved } }).tables[logical].fields).length >= 3);
      table.headers = [...new Set(records.flat())];
    }
    schema = resolveSchema(tables, this.mapping);
    for (const [logical, table] of Object.entries(schema.tables)) if (logical !== "_eco" && !table.name) tables.push({ name: this.mapping.tables[logical]?.name || logical, headers: [] });
    schema = resolveSchema(tables, this.mapping);
    for (const [logical, resolved] of Object.entries(schema.tables)) {
      if (logical === "_eco" || !resolved.name) continue;
      const table = tables.find(item => item.name === resolved.name), saved = this.mapping.tables[logical] || {};
      if (RECORD_TABS.includes(logical) && !table.headers.includes(BODY) && saved.columns?.content === undefined) table.headers.push(BODY);
      const fresh = resolveSchema(tables, this.mapping).tables[logical];
      for (const key of fresh.unmapped) if ((saved.columns?.[key] === null || !fresh.unknown.length) && !table.headers.includes(key)) table.headers.push(key);
    }
    schema = resolveSchema(tables, this.mapping);
    this.structure = { ...schema, version: String(protocolNote?.front?.version || PROTOCOL_VERSION) };
    return this.structure;
  }
  async persistMap() {
    const map = snapshotMap(this.structure);
    this.mapping = map;
    this.config.map = map;
    try { localStorage.setItem("eco.obsidianSchema:" + this.config.connector + ":" + this.root, JSON.stringify(map)); } catch {}
    const value = JSON.stringify(map);
    const current = this.protocolNote ? { front: { ...this.protocolNote.front }, body: this.protocolNote.body } : { front: Object.fromEntries(MEMORY_PROTOCOL.slice(1)), body: "" };
    if (current.front.map === value) { this.structure.map_shared = true; return; }
    current.front.map = value;
    try { await this.files.write(this.path("_eco.md"), serializeNote(current.front, current.body)); this.known?.add(this.root); this.protocolNote = current; this.structure.map_shared = true; }
    catch { this.structure.map_shared = false; this.structure.warning = "Mapa local: no se pudo guardar map en _eco.md."; }
  }
  async prepare() { await this.inspect(); await this.persistMap(); this.inspected = Date.now(); return this.structure; }
  ensure() {
    if (this.structure && Date.now() - this.inspected < 30000) return Promise.resolve(this.structure);
    if (!this.preparing) this.preparing = this.prepare().finally(() => { this.preparing = null; });
    return this.preparing;
  }
  async connect() { await this.ensure(); return { protocol: "eco-memoria", version: PROTOCOL_VERSION, folder: this.root }; }
  async schema(action = "ver", changes = {}) {
    if (!["ver", "ajustar"].includes(action)) throw new Error("Acción de esquema inválida.");
    if (action === "ajustar") { await this.inspect(mergeMap(this.mapping, changes)); await this.persistMap(); this.inspected = Date.now(); }
    else await this.ensure();
    return { mapa: snapshotMap(this.structure), tables: this.structure.tables, unknown_tables: this.structure.unknown_tables, map_shared: this.structure.map_shared, warning: this.structure.warning, contenido_no_confiable: true };
  }
  async entries(logical, cache = true) {
    const table = this.structure.tables[logical];
    if (!table?.name) return [];
    const names = (await this.list(this.path(table.name))).filter(name => name.endsWith(".md"));
    const result = [];
    for (const name of names) {
      if (isWiping()) break;
      const path = this.path(table.name, name), note = await this.note(path, cache && logical !== "agents" && logical !== "routines");
      if (note) result.push({ path, note, record: decodeRow(table, this.row(table, note)) });
    }
    return result;
  }
  async visible(item, logical) {
    const record = item.record;
    if (!record.id) return null;
    if (isSecurityCommand(record.content)) {
      if (logical === "messages" && record.type === "message") await inspectSecurityRecord(record, this.config.eco, () => this.redact(item));
      return null;
    }
    return record;
  }
  async redact(item) {
    const table = this.structure.tables.messages, header = table.headers[table.fields.content];
    const front = { ...item.note.front };
    let body = item.note.body;
    if (header === BODY && !Object.hasOwn(front, BODY)) body = "[orden de seguridad retirada]"; else front[header] = "[orden de seguridad retirada]";
    await this.files.write(item.path, serializeNote(front, body));
    this.notes.delete(item.path);
  }
  async search(filters = {}, tabs = RECORD_TABS) {
    await this.ensure();
    if (filters.type) tabs = TYPE_TABS[filters.type] ? [TYPE_TABS[filters.type]] : [];
    const records = [], seen = new Set();
    for (const tab of tabs) for (const item of await this.entries(tab)) {
      const record = await this.visible(item, tab);
      if (record && !seen.has(record.id) && matchesRecord(record, filters)) { seen.add(record.id); records.push(record); }
    }
    records.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    return { records, contenido_no_confiable: true };
  }
  async readNew(tabs = RECORD_TABS, cursors = { load: this.loadCursor, save: this.saveCursor }) {
    await this.ensure();
    const previous = cursors.load() || {}, state = { version: 1, tabs: { ...(previous.version === 1 ? previous.tabs : {}) } }, records = [];
    let more = false;
    for (const tab of tabs) {
      const table = this.structure.tables[tab], seen = new Set(state.tabs[tab]?.seen || []);
      if (!table?.name) continue;
      const pending = (await this.list(this.path(table.name))).filter(name => name.endsWith(".md") && !seen.has(name));
      if (pending.length > PAGE) more = true;
      const batch = [];
      for (const name of pending.slice(0, PAGE)) {
        const path = this.path(table.name, name), note = await this.note(path, true);
        if (note) batch.push({ name, path, note, record: decodeRow(table, this.row(table, note)) });
        else seen.add(name);
      }
      batch.sort((a, b) => a.record.date.localeCompare(b.record.date) || a.record.id.localeCompare(b.record.id));
      for (const item of batch) {
        const security = securityState();
        if (tab === "messages" && isSecurityCommand(item.record.content) && security.enabled && security.lockedUntil > Date.now()) { more = true; break; }
        const record = await this.visible(item, tab);
        if (record) records.push(record);
        seen.add(item.name);
        if (isWiping()) break;
      }
      state.tabs[tab] = { seen: [...seen] };
      if (isWiping()) break;
    }
    if (!isWiping()) cursors.save(state);
    return { records, hay_mas: more, contenido_no_confiable: true };
  }
  encode(table, record, previous = { front: {}, body: "" }) {
    const front = { ...previous.front };
    let body = previous.body;
    for (const [key, index] of Object.entries(table.fields)) {
      if (record[key] === undefined) continue;
      const header = table.headers[index];
      if (header === BODY && !Object.hasOwn(previous.front, BODY)) body = String(record[key]);
      else front[header] = key === "tags" ? listTags(record[key]) : String(record[key]);
    }
    return serializeNote(front, body);
  }
  save(args) { const pending = this.writing.then(() => this.append(args)); this.writing = pending.catch(() => {}); return pending; }
  async append(args) {
    await this.ensure();
    if (isSecurityCommand(args?.content)) throw new Error("Las órdenes de seguridad no se guardan mediante el agente.");
    if (!Object.hasOwn(TYPE_TABS, args.type) || !String(args.content || "").trim() || String(args.content).length > 45000) throw new Error("Tipo o contenido inválido (máximo 45000 caracteres).");
    if (args.type === "ack") {
      if (!UUID.test(args.reply_to || "")) throw new Error("El acuse necesita reply_to con el UUID original.");
      const original = (await this.search({ id: args.reply_to, type: "message" }, ["messages"])).records[0];
      if (!original) throw new Error("El mensaje original no existe.");
      args = { ...args, to: args.to || original.eco_author, thread: args.thread || original.thread };
    }
    const id = args.id || crypto.randomUUID();
    if (!UUID.test(id)) throw new Error("El id debe ser un UUID.");
    const existing = (await this.search({ id })).records[0];
    if (existing) {
      if (existing.eco_author !== this.config.eco || ["content", "type", "to", "thread", "reply_to", "replaces"].some(key => String(existing[key] || "") !== String(args[key] || "")) || listTags(existing.tags).join(",") !== listTags(args.tags).join(",")) throw new Error("El UUID ya pertenece a otro registro.");
      if (existing.type === "fact" && args.replaces) await this.removeFact(args.replaces).catch(() => false);
      return { ok: true, id, duplicado: true };
    }
    const replacing = replacementCheck({ ...args, id }, args.replaces ? (await this.search({ id: args.replaces })).records[0] : null);
    const table = requireTable(this.structure, TYPE_TABS[args.type]);
    const path = this.path(table.name, id + ".md");
    const record = Object.fromEntries(MEMORY_COLUMNS.map(key => [key, String(args[key] || "")]));
    Object.assign(record, { id, date: new Date().toISOString(), eco_author: this.config.eco, user_author: this.config.usuario || "", tags: listTags(args.tags).join(",") });
    try {
      if ((await this.list(this.path(table.name))).includes(id + ".md")) throw new Error("Ya existe una nota con ese id; no se sobrescribe.");
      await this.files.write(path, this.encode(table, record));
      this.known?.add(this.path(table.name));
    } catch (error) { return { error: error.message, id, reintentar: "Repite memoria_guardar con este mismo id; no generes otro." }; }
    if (!replacing) return { ok: true, id };
    return await this.removeFact(args.replaces).catch(() => false) ? { ok: true, id, reemplazado: args.replaces } : { ok: true, id, aviso: "El fact anterior sigue en la bóveda; queda sustituido por replaces." };
  }
  async removeFact(id) {
    const matches = (await this.entries("memories", false)).filter(item => item.record.id === id);
    if (matches.length !== 1 || matches[0].record.type !== "fact") return false;
    const current = await this.note(matches[0].path);
    const table = this.structure.tables.memories, record = current && decodeRow(table, this.row(table, current));
    if (!record || record.id !== id || record.type !== "fact") return false;
    await this.files.remove(matches[0].path);
    this.notes.delete(matches[0].path);
    return true;
  }
  async directory(logical, action, changes, identity = {}) {
    await this.ensure();
    const table = requireTable(this.structure, logical), items = await this.entries(logical, false);
    if (action === "listar") return { [logical === "agents" ? "agentes" : "rutinas"]: items.map(item => item.record).filter(record => record.id && (logical !== "routines" || record.agent_id === this.config.eco)), contenido_no_confiable: true };
    if (action !== "actualizar") throw new Error("Acción de directorio inválida.");
    const id = logical === "agents" ? this.config.eco : changes.id, matches = items.filter(item => item.record.id === id);
    if (matches.length > 1) throw new Error("El id está repetido; asigna uno único sin sobrescribir notas.");
    const previous = matches[0]?.record || {};
    let record;
    if (logical === "agents") {
      if (!NAME.test(id || "")) throw new Error("Nombre de agente inválido.");
      for (const [key, value] of Object.entries(changes)) if (!["preferences", "stack"].includes(key) || typeof value !== "string" || value.length > 2000) throw new Error("Solo puedes actualizar preferencias y stack propios.");
      record = { ...previous, ...changes, id, class: "eco", model: identity.model || "", alias: this.config.usuario || "", peripherals: identity.peripherals || "", status: "activo", version: identity.version || "", updated: new Date().toISOString() };
    } else record = routineRecord(this.config, changes, previous);
    const path = matches[0]?.path || this.path(table.name, encodeURIComponent(id) + ".md");
    this.known?.add(this.path(table.name));
    await this.files.write(path, this.encode({ ...table, fields: Object.fromEntries(Object.entries(table.fields).filter(([key]) => key !== "content")) }, record, matches[0]?.note));
    return { ok: true, [logical === "agents" ? "agente" : "rutina"]: record };
  }
  agents(action = "listar", changes = {}, identity = {}) {
    if (action === "listar") return this.directory("agents", action, changes, identity);
    const pending = this.writing.then(() => this.directory("agents", action, changes, identity)); this.writing = pending.catch(() => {}); return pending;
  }
  routines(action = "listar", changes = {}) {
    if (action === "listar") return this.directory("routines", action, changes);
    const pending = this.writing.then(() => this.directory("routines", action, changes)); this.writing = pending.catch(() => {}); return pending;
  }
}
