// Storage layer. Uses MongoDB when MONGODB_URI is set, otherwise a JSON file (development only).
import fs from "node:fs";
import path from "node:path";

const strip = (doc) => {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return rest;
};

// ------------------------------- memory / file -------------------------------

class MemoryDB {
  constructor(file) {
    this.kind = file ? "file" : "memory";
    this.file = file;
    this.users = new Map();
    this.orders = new Map();
    this.withdrawals = new Map();
    this.meta = {};
    this.timer = null;
    this.load();
  }
  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const u of raw.users ?? []) this.users.set(u.id, u);
      for (const o of raw.orders ?? []) this.orders.set(o.id, o);
      for (const w of raw.withdrawals ?? []) this.withdrawals.set(w.id, w);
      this.meta = { ...(raw.meta ?? {}) };
    } catch (err) {
      console.error("[db] could not read", this.file, err.message);
    }
  }
  dirty() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const data = { users: [...this.users.values()], orders: [...this.orders.values()], withdrawals: [...this.withdrawals.values()], meta: this.meta };
        fs.writeFileSync(this.file + ".tmp", JSON.stringify(data));
        fs.renameSync(this.file + ".tmp", this.file);
      } catch (err) {
        console.error("[db] save failed", err.message);
      }
    }, 500);
    this.timer.unref?.();
  }
  async getUser(id) {
    const u = this.users.get(id);
    return u ? structuredClone(u) : null;
  }
  async putUser(u) {
    this.users.set(u.id, structuredClone(u));
    this.dirty();
  }
  async countUsers() {
    return this.users.size;
  }
  async countUsersSince(ts) {
    return [...this.users.values()].filter((u) => (u.createdAt ?? 0) >= ts).length;
  }
  async allUserIds() {
    return [...this.users.keys()];
  }
  /** Another account that already uses this wallet (used so one wallet can only count for one referral). */
  async findUserByWallet(wallet, exceptId) {
    for (const u of this.users.values()) if (u.wallet && u.wallet === wallet && u.id !== exceptId) return structuredClone(u);
    return null;
  }
  async listReferrals(referrerId, limit = 100) {
    return [...this.users.values()]
      .filter((u) => u.referredBy === referrerId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((u) => structuredClone(u));
  }
  async getMeta() {
    return structuredClone(this.meta);
  }
  async incMeta(field, n) {
    this.meta[field] = (this.meta[field] ?? 0) + n;
    this.dirty();
    return this.meta[field];
  }
  async setMeta(patch) {
    Object.assign(this.meta, structuredClone(patch));
    this.dirty();
  }
  // ---- orders (one order = one TON payment + the UTYA the buyer is owed)
  async addOrder(o) {
    this.orders.set(o.id, structuredClone(o));
    this.dirty();
  }
  async getOrder(id) {
    const o = this.orders.get(id);
    return o ? structuredClone(o) : null;
  }
  /** Changes an order only if its status is one of `from`. Returns the new order, or null when somebody else was first. */
  async transitionOrder(id, from, patch) {
    const o = this.orders.get(id);
    if (!o || !from.includes(o.status)) return null;
    Object.assign(o, structuredClone(patch));
    this.dirty();
    return structuredClone(o);
  }
  async listOrders({ statuses, userId, since, limit = 50, oldestFirst = false } = {}) {
    const rows = [...this.orders.values()]
      .filter((o) => (statuses ? statuses.includes(o.status) : true) && (userId ? o.userId === userId : true) && (since ? o.createdAt >= since : true))
      .sort((a, b) => (oldestFirst ? a.createdAt - b.createdAt : b.createdAt - a.createdAt));
    return rows.slice(0, limit).map((o) => structuredClone(o));
  }
  // ---- withdrawals (mined UTYA the user asked to get paid out)
  async addWithdrawal(w) {
    this.withdrawals.set(w.id, structuredClone(w));
    this.dirty();
  }
  async getWithdrawal(id) {
    const w = this.withdrawals.get(id);
    return w ? structuredClone(w) : null;
  }
  /** Changes a withdrawal only if its status is one of `from`. Returns the new row, or null when somebody else was first. */
  async transitionWithdrawal(id, from, patch) {
    const w = this.withdrawals.get(id);
    if (!w || !from.includes(w.status)) return null;
    Object.assign(w, structuredClone(patch));
    this.dirty();
    return structuredClone(w);
  }
  async listWithdrawals({ statuses, userId, limit = 50, oldestFirst = false } = {}) {
    const rows = [...this.withdrawals.values()]
      .filter((w) => (statuses ? statuses.includes(w.status) : true) && (userId ? w.userId === userId : true))
      .sort((a, b) => (oldestFirst ? a.createdAt - b.createdAt : b.createdAt - a.createdAt));
    return rows.slice(0, limit).map((w) => structuredClone(w));
  }
}

// --------------------------------- MongoDB ----------------------------------

class MongoDB {
  constructor(client, db) {
    this.kind = "mongodb";
    this.client = client;
    this.users = db.collection("users");
    this.ordersCol = db.collection("orders");
    this.metaCol = db.collection("meta");
    this.withdrawCol = db.collection("withdrawals");
  }
  static async connect(uri) {
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
    await client.connect();
    const db = client.db(); // database name comes from the connection string
    const self = new MongoDB(client, db);
    await self.users.createIndex({ createdAt: -1 });
    await self.users.createIndex({ referredBy: 1 });
    await self.users.createIndex({ wallet: 1 });
    await self.ordersCol.createIndex({ status: 1, createdAt: -1 });
    await self.ordersCol.createIndex({ userId: 1, createdAt: -1 });
    await self.withdrawCol.createIndex({ status: 1, createdAt: 1 });
    await self.withdrawCol.createIndex({ userId: 1, createdAt: -1 });
    return self;
  }
  async getUser(id) {
    return strip(await this.users.findOne({ _id: id }));
  }
  async putUser(u) {
    await this.users.replaceOne({ _id: u.id }, { ...u, _id: u.id }, { upsert: true });
  }
  async countUsers() {
    return this.users.estimatedDocumentCount();
  }
  async countUsersSince(ts) {
    return this.users.countDocuments({ createdAt: { $gte: ts } });
  }
  async allUserIds() {
    return (await this.users.find({}, { projection: { _id: 1 } }).toArray()).map((d) => d._id);
  }
  async findUserByWallet(wallet, exceptId) {
    return strip(await this.users.findOne({ wallet, _id: { $ne: exceptId } }));
  }
  async listReferrals(referrerId, limit = 100) {
    return (await this.users.find({ referredBy: referrerId }).sort({ createdAt: -1 }).limit(limit).toArray()).map(strip);
  }
  async getMeta() {
    const doc = await this.metaCol.findOne({ _id: "global" });
    return doc ? strip(doc) : {};
  }
  async incMeta(field, n) {
    const res = await this.metaCol.findOneAndUpdate({ _id: "global" }, { $inc: { [field]: n } }, { upsert: true, returnDocument: "after" });
    return (res?.[field] ?? res?.value?.[field]) ?? 0;
  }
  async setMeta(patch) {
    await this.metaCol.updateOne({ _id: "global" }, { $set: patch }, { upsert: true });
  }
  async addOrder(o) {
    await this.ordersCol.insertOne({ ...o, _id: o.id });
  }
  async getOrder(id) {
    return strip(await this.ordersCol.findOne({ _id: id }));
  }
  async transitionOrder(id, from, patch) {
    const res = await this.ordersCol.findOneAndUpdate({ _id: id, status: { $in: from } }, { $set: patch }, { returnDocument: "after" });
    return strip(res?.value !== undefined ? res.value : res);
  }
  async listOrders({ statuses, userId, since, limit = 50, oldestFirst = false } = {}) {
    const q = {};
    if (statuses) q.status = { $in: statuses };
    if (userId) q.userId = userId;
    if (since) q.createdAt = { $gte: since };
    return (await this.ordersCol.find(q).sort({ createdAt: oldestFirst ? 1 : -1 }).limit(limit).toArray()).map(strip);
  }
  async addWithdrawal(w) {
    await this.withdrawCol.insertOne({ ...w, _id: w.id });
  }
  async getWithdrawal(id) {
    return strip(await this.withdrawCol.findOne({ _id: id }));
  }
  async transitionWithdrawal(id, from, patch) {
    const res = await this.withdrawCol.findOneAndUpdate({ _id: id, status: { $in: from } }, { $set: patch }, { returnDocument: "after" });
    return strip(res?.value !== undefined ? res.value : res);
  }
  async listWithdrawals({ statuses, userId, limit = 50, oldestFirst = false } = {}) {
    const q = {};
    if (statuses) q.status = { $in: statuses };
    if (userId) q.userId = userId;
    return (await this.withdrawCol.find(q).sort({ createdAt: oldestFirst ? 1 : -1 }).limit(limit).toArray()).map(strip);
  }
}

export async function openDb({ mongoUri, file }) {
  if (mongoUri) {
    const db = await MongoDB.connect(mongoUri);
    console.log("[db] connected to MongoDB");
    return db;
  }
  if (file) console.warn("[db] MONGODB_URI is not set: using a local JSON file. Data is lost when the server is redeployed!");
  return new MemoryDB(file);
}
