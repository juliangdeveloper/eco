import { TYPE_TABS, isDreamingRecord, isDuplicateMessage, normalizeMemoryMessage } from "./memory-protocol.js";
import { isSecurityCommand, isWiping } from "./security.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const QUEUE_LIMIT = 2000;
const FALLBACK_MARGIN_MS = 10 * 60 * 1000;
const entryKey = entry => entry.op + ":" + (entry.op === "save" ? entry.args.id : entry.changes.id);
const COPY_NOTICE = "Read from a copy because the main memory is not responding.";

export class MemorySet {
  constructor({ members, status, queue, store }) {
    this.members = members;
    this.status = status;
    this.queue = queue;
    this.store = store;
    this.flushing = null;
  }
  get primary() { return this.members[0]; }
  get mirrors() { return this.members.slice(1); }
  failedConnection(member, start) {
    if (!member.connected) return true;
    const state = this.status(member.key);
    return state.fail !== undefined && state.fail >= start && state.fail >= (state.ok ?? -Infinity);
  }
  async attempt(member, run) {
    if (!member.connected) return { failed: true, error: new Error("No connection to " + member.label + ".") };
    const start = performance.now();
    try {
      const value = await run(member.adapter);
      if (value?.error) return { failed: true, error: new Error(value.error) };
      return { value };
    } catch (error) {
      if (this.failedConnection(member, start)) return { failed: true, error };
      return { rejected: true, error };
    }
  }
  async read(run, note = true) {
    let first = null;
    for (const member of this.members) {
      const outcome = await this.attempt(member, run);
      if (outcome.value !== undefined) {
        if (member === this.primary || !note || !outcome.value || typeof outcome.value !== "object") return outcome.value;
        return { ...outcome.value, aviso: COPY_NOTICE };
      }
      if (outcome.rejected) throw outcome.error;
      first ||= outcome.error;
      if (isWiping()) break;
    }
    throw first || new Error("Memory is still local. Connect a destination or renew its credentials.");
  }
  ensure() { return this.read(adapter => adapter.ensure(), false); }
  connect() { return this.read(adapter => adapter.connect(), false); }
  search(filters = {}, tabs) { return this.read(adapter => tabs ? adapter.search(filters, tabs) : adapter.search(filters)); }
  schema(action, changes, key) {
    const member = key ? this.members.find(item => item.key === key) : this.primary;
    if (!member) throw new Error("That memory is not connected.");
    return member.adapter.schema(action, changes);
  }
  async readNew(tabs, cursors, scope = "") {
    let first = null;
    for (const member of this.members) {
      const own = member === this.primary ? cursors : scope ? { load: () => this.store.load(scope + ":" + member.identity), save: value => this.store.save(scope + ":" + member.identity, value) } : undefined;
      const outcome = await this.attempt(member, adapter => tabs ? adapter.readNew(tabs, own) : adapter.readNew());
      if (outcome.value) {
        if (member === this.primary) { this.store.save("memoryPrimaryRead", Date.now()); return outcome.value; }
        const since = Number(this.store.load("memoryPrimaryRead")) || 0;
        const records = outcome.value.records.filter(record => !since || Date.parse(record.date) >= since - FALLBACK_MARGIN_MS);
        return { ...outcome.value, records, aviso: COPY_NOTICE };
      }
      if (outcome.rejected) throw outcome.error;
      first ||= outcome.error;
      if (isWiping()) break;
    }
    throw first || new Error("Memory is still local.");
  }
  check(args) {
    if (isSecurityCommand(args?.content)) throw new Error("Security commands are not saved through the agent.");
    if (!Object.hasOwn(TYPE_TABS, args.type) || !String(args.content || "").trim() || String(args.content).length > 45000) throw new Error("Invalid type or content (up to 45000 characters).");
    if (!UUID.test(args.id)) throw new Error("The id must be a UUID.");
    if (args.type === "ack" && !UUID.test(args.reply_to || "")) throw new Error("The ack needs reply_to with the original UUID.");
    if (args.type === "memory" && args.replaces && !isDreamingRecord(args)) throw new Error("memory records are never edited or deleted; add a new one.");
  }
  enqueue(member, entry) {
    let list = this.queue.load(member.key);
    const previous = entry.op === "routine" && list.find(item => entryKey(item) === entryKey(entry));
    if (previous) { entry = { ...entry, changes: { ...previous.changes, ...entry.changes } }; list = list.filter(item => item !== previous); }
    if (entry.op === "save" && list.some(item => entryKey(item) === entryKey(entry))) return;
    list.push(entry);
    if (list.length > QUEUE_LIMIT) throw new Error("The local copy queue is full; reconnect the memories.");
    this.queue.save(member.key, list);
  }
  run(entry, adapter) {
    return entry.op === "save" ? adapter.save({ ...entry.args, copia: true }) : adapter.routines("actualizar", entry.changes);
  }
  async replicate(entry, primaryRun) {
    const primary = this.primary;
    const main = await this.attempt(primary, primaryRun);
    if (main.rejected) throw main.error;
    if (main.failed) this.enqueue(primary, entry);
    let copied = 0, pending = 0;
    await Promise.all(this.mirrors.map(async member => {
      const outcome = await this.attempt(member, adapter => this.run(entry, adapter));
      if (outcome.failed) { this.enqueue(member, entry); pending++; }
      else if (outcome.value !== undefined) copied++;
    }));
    return { main, copied, pending };
  }
  async findRecord(id) {
    if (!id) return null;
    try {
      const result = await this.search({ id });
      return result?.records?.find((row) => row.id === id) || null;
    } catch {
      return null;
    }
  }
  async save(input = {}) {
    const { copia, ...fields } = input;
    const args = { ...fields, id: fields.id || crypto.randomUUID() };
    this.check(args);
    if (args.type === "message") {
      const reply = args.reply_to ? await this.findRecord(args.reply_to) : null;
      const replaced = args.replaces ? await this.findRecord(args.replaces) : null;
      Object.assign(args, normalizeMemoryMessage(args, { eco: this.primary.config.eco, reply, replaced }));
      try {
        const result = await this.search({ type: "message", thread: args.thread, eco_author: this.primary.config.eco });
        const twin = (result?.records || []).find((row) => isDuplicateMessage(args, row, this.primary.config.eco));
        if (twin) return { ok: true, id: twin.id, duplicado: true };
      } catch {}
    }
    const entry = { op: "save", args };
    const { main, copied, pending } = await this.replicate(entry, adapter => adapter.save(args));
    if (main.value) return pending ? { ...main.value, copias_pendientes: pending } : main.value;
    if (copied) return { ok: true, id: args.id, aviso: "The main memory is not responding; the record was kept in a copy and will be sent to the main one with the same id." };
    return { ok: true, id: args.id, en_cola: true, aviso: "No memory is responding; the record was queued on this device and will be sent with the same id." };
  }
  async agents(action = "listar", changes = {}, identity = {}) {
    if (action === "listar") return this.read(adapter => adapter.agents(action, changes, identity));
    const outcomes = await Promise.all(this.members.map(member => this.attempt(member, adapter => adapter.agents(action, changes, identity))));
    const done = outcomes.find(outcome => outcome.value);
    if (done) return done.value;
    throw outcomes.find(outcome => outcome.rejected)?.error || outcomes[0].error;
  }
  async routines(action = "listar", changes = {}) {
    if (action === "listar") return this.read(adapter => adapter.routines(action, changes));
    const { main, copied, pending } = await this.replicate({ op: "routine", changes }, adapter => adapter.routines(action, changes));
    if (main.value) return pending ? { ...main.value, copias_pendientes: pending } : main.value;
    return { ok: true, en_cola: true, copias: copied, aviso: "The main memory is not responding; the routine will be sent when it comes back." };
  }
  pending() { return Object.fromEntries(this.members.map(member => [member.key, this.queue.load(member.key).length])); }
  flush() {
    if (!this.flushing) this.flushing = this.drain().finally(() => { this.flushing = null; });
    return this.flushing;
  }
  async drain() {
    let sent = 0, dropped = 0;
    for (const member of this.members) {
      let list = this.queue.load(member.key);
      if (!list.length || !member.connected) continue;
      while (list.length && !isWiping()) {
        const outcome = await this.attempt(member, adapter => this.run(list[0], adapter));
        if (outcome.failed) break;
        if (outcome.rejected) dropped++; else sent++;
        const done = entryKey(list[0]);
        const stored = this.queue.load(member.key), index = stored.findIndex(item => entryKey(item) === done);
        if (index >= 0) stored.splice(index, 1);
        this.queue.save(member.key, stored);
        list = stored;
      }
    }
    return { enviados: sent, descartados: dropped };
  }
}
