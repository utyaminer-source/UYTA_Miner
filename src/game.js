// All the rules of UTYA Miner: settings, players, live quotes, orders, refunds and delivery.
// One order = one TON payment from the buyer + the UTYA the buyer is owed. An admin sends the UTYA by hand.
//
// Order status:  pending (waiting for the TON) -> expired (quote over, still found if paid late) -> failed (never paid)
//                paid (TON received, waiting for the admin) -> delivered (admin sent the UTYA)
//                paid -> refund_requested (buyer asked) -> refunded (admin sent the TON back)
import crypto from "node:crypto";
import { DEFAULTS, LANGS, ORDER, TOKEN } from "./config.js";
import { T } from "./messages.js";
import { normalizeWallet, toNano } from "./ton.js";

/** An error that is shown to the player. `code` + `vars` let the app show it in the player's language. */
export class GameError extends Error {
  constructor(message, code = "", vars = {}) {
    super(message);
    this.code = code;
    this.vars = vars;
  }
}

let db = null;
/** Set by bot.js. All of them must never throw. */
export const hooks = {
  notify: async (_userId, _text) => {},
  notifyAdmins: async (_text, _buttons) => {},
  /** true / false, or null when it cannot be checked (bot is not an admin of the channel, Telegram down...) */
  checkMember: async (_chat, _userId) => null,
  botUsername: "",
};
/** Values set by server.js. `price` is the live price service (src/price.js). */
export const runtime = { envDepositAddress: "", testnet: false, price: null };

export function init(database) {
  db = database;
}

const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 1e4) / 1e4;
const fmt = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });

// ------------------------------ per-key locking ------------------------------
// The server is a single process, so queueing the work per key is enough to stop double actions.
const chains = new Map();
export function withLock(key, fn) {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail = run.catch(() => {});
  chains.set(key, tail);
  tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// -------------------------------- settings -----------------------------------

export async function getSettings() {
  const meta = await db.getMeta();
  const s = meta.settings ?? {};
  const pos = (v, d) => (Number.isFinite(v) && v > 0 ? v : d);
  return {
    buyOpen: s.buyOpen !== false,
    minTon: pos(s.minTon, DEFAULTS.minTon),
    maxTon: pos(s.maxTon, DEFAULTS.maxTon),
    feePct: Number.isFinite(s.feePct) && s.feePct >= 0 && s.feePct <= 20 ? s.feePct : DEFAULTS.feePct,
    deliveryHours: pos(s.deliveryHours, DEFAULTS.deliveryHours),
    welcome: typeof s.welcome === "string" ? s.welcome : "",
    depositAddress: typeof s.depositAddress === "string" ? s.depositAddress : "",
    support: typeof s.support === "string" ? s.support : "",
    admins: Array.isArray(s.admins) ? s.admins.filter((n) => Number.isInteger(n)) : [], // extra admins (owners are in ADMIN_IDS)
    channels: Array.isArray(s.channels) ? s.channels.filter((c) => typeof c === "string") : [], // channels players must join
    joinEnabled: s.joinEnabled !== false,
  };
}
export async function updateSettings(patch) {
  const cur = await getSettings();
  await db.setMeta({ settings: { ...cur, ...patch } });
  return { ...cur, ...patch };
}
/** Where players send their TON. Set with /setdepositaddress or the TON_DEPOSIT_ADDRESS environment variable. */
export async function getDepositAddress() {
  const s = await getSettings();
  return s.depositAddress || runtime.envDepositAddress || "";
}

// ---------------------------------- users ------------------------------------

function displayName(tg) {
  const full = [tg.first_name, tg.last_name].filter(Boolean).join(" ").trim();
  return (full || tg.username || "Friend").slice(0, 40);
}
const langFromTelegram = (code) => {
  const l = String(code ?? "").slice(0, 2).toLowerCase();
  return LANGS.includes(l) ? l : "en";
};
const langOf = (u) => (u && LANGS.includes(u.lang) ? u.lang : "en");

async function mustUser(id) {
  const u = await db.getUser(id);
  if (!u) throw new GameError("Account not found. Open the bot and press Start.", "no_account");
  return u;
}

export async function ensureUser(tg) {
  return withLock("u" + tg.id, async () => {
    const now = Date.now();
    const name = displayName(tg);
    let u = await db.getUser(tg.id);
    if (!u) {
      u = { id: tg.id, name, username: tg.username ?? "", lang: langFromTelegram(tg.language_code), createdAt: now, lastSeen: now, wallet: "", banned: false };
      await db.putUser(u);
      return u;
    }
    if (u.name !== name || u.username !== (tg.username ?? "") || now - u.lastSeen > 60_000) {
      u.name = name;
      u.username = tg.username ?? "";
      u.lastSeen = now;
      await db.putUser(u);
    }
    return u;
  });
}

async function patchUser(id, fn) {
  return withLock("u" + id, async () => {
    const u = await mustUser(id);
    const out = await fn(u);
    await db.putUser(u);
    return out;
  });
}

export async function setLang(id, lang) {
  if (!LANGS.includes(lang)) throw new GameError("Unsupported language.", "bad_lang");
  await patchUser(id, (u) => {
    u.lang = lang;
  });
}

export async function setBanned(id, banned, reason = "") {
  return patchUser(id, (u) => {
    u.banned = Boolean(banned);
    u.banReason = u.banned ? String(reason ?? "").slice(0, 300) : "";
    u.bannedAt = u.banned ? Date.now() : 0;
    return u;
  });
}

/** The wallet the player connected with TonConnect. Stored as a friendly address; the UTYA is sent there. */
export async function setWallet(id, address) {
  const friendly = normalizeWallet(address, { testnet: runtime.testnet });
  if (!friendly) throw new GameError("That is not a valid TON wallet address.", "bad_wallet");
  await patchUser(id, (u) => {
    u.wallet = friendly;
  });
  return friendly;
}

// ---------------------------------- quotes -----------------------------------

/** Pure maths of a quote. fee comes off the value in USD, then the rest is converted to UTYA (rounded DOWN to 2 decimals). */
export function computeQuote(ton, price, feePct) {
  const usd = ton * price.tonUsd;
  const utya = Math.floor(((usd * (1 - feePct / 100)) / price.utyaUsd) * 100 + 1e-9) / 100;
  return {
    ton,
    feePct,
    feeTon: round4((ton * feePct) / 100),
    utya,
    tonUsd: price.tonUsd,
    utyaUsd: price.utyaUsd,
    perTon: round2(price.tonUsd / price.utyaUsd), // UTYA for 1 TON before the fee
    at: price.at,
  };
}

function checkAmount(raw, s) {
  const ton = round4(Number(raw));
  if (!Number.isFinite(ton) || ton <= 0) throw new GameError("Enter how many TON you want to spend.", "bad_amount", { min: s.minTon, max: s.maxTon });
  if (ton < s.minTon) throw new GameError(`The minimum order is ${s.minTon} TON.`, "too_small", { min: s.minTon });
  if (ton > s.maxTon) throw new GameError(`The maximum order is ${s.maxTon} TON.`, "too_big", { max: s.maxTon });
  return ton;
}

/** The live offer for `rawTon` TON. Throws when buying is paused or no fresh price exists. */
export async function quote(rawTon) {
  const s = await getSettings();
  if (!s.buyOpen) throw new GameError("Buying is paused right now.", "buy_closed");
  const ton = checkAmount(rawTon, s);
  const price = await runtime.price?.get();
  if (!price) throw new GameError("The live price is not available right now. Please try again in a minute.", "price_unavailable");
  return computeQuote(ton, price, s.feePct);
}

// ---------------------------------- orders -----------------------------------

const newOrderId = () => crypto.randomBytes(4).toString("hex").toUpperCase();
/** The comment inside the TON transfer. It tells us which order was paid. */
export const paymentComment = (o) => `UTYA-${o.id}`;

export function orderView(o) {
  return {
    id: o.id,
    ton: o.ton,
    utya: o.utya,
    status: o.status,
    createdAt: o.createdAt,
    paidAt: o.paidAt ?? 0,
    deliveredAt: o.deliveredAt ?? 0,
    refundedAt: o.refundedAt ?? 0,
    wallet: o.wallet,
    requoted: Boolean(o.requoted),
    deliveryTx: o.deliveryTx ?? "",
    refundTx: o.refundTx ?? "",
  };
}

export async function createOrder(userId, rawTon) {
  const u = await mustUser(userId);
  if (!u.wallet) throw new GameError("Connect your TON wallet first.", "no_wallet");
  const q = await quote(rawTon);
  const now = Date.now();
  const open = await db.listOrders({ statuses: ["pending"], userId, since: now - ORDER.pendingMs, limit: 20 });
  // Pressing "Pay" twice must not create two orders: reuse a fresh one for the same amount.
  const same = open.find((o) => o.ton === q.ton && now - o.createdAt < 60_000 && o.wallet === u.wallet);
  if (same) return same;
  if (open.length >= ORDER.maxOpenPerUser) throw new GameError("You have too many unpaid orders. Finish or wait for them first.", "too_many_orders");
  const o = {
    id: newOrderId(),
    userId,
    ton: q.ton,
    utya: q.utya,
    tonUsd: q.tonUsd,
    utyaUsd: q.utyaUsd,
    feePct: q.feePct,
    status: "pending",
    createdAt: now,
    expiresAt: now + ORDER.pendingMs,
    wallet: u.wallet, // the UTYA goes to this wallet, even if the player connects another one later
  };
  await db.addOrder(o);
  return o;
}

export const getOrder = (id) => db.getOrder(String(id).toUpperCase());
export async function orderOf(userId, id) {
  const o = await db.getOrder(String(id).toUpperCase());
  if (!o || o.userId !== userId) throw new GameError("Order not found.", "order_missing");
  return o;
}
export const orderStatus = async (id) => orderView(await db.getOrder(id));

/** Orders whose TON may still arrive (open, or a bit late). Also moves old ones to expired / failed. */
export async function openOrders() {
  const now = Date.now();
  const rows = await db.listOrders({ statuses: ["pending", "expired"], since: now - ORDER.lateAcceptMs, limit: 500 });
  for (const o of rows) {
    if (o.status === "pending" && now > o.expiresAt) {
      const moved = await db.transitionOrder(o.id, ["pending"], { status: "expired" });
      if (moved) o.status = "expired";
    }
  }
  const dead = await db.listOrders({ statuses: ["pending", "expired"], limit: 500 });
  for (const o of dead) if (now - o.createdAt > ORDER.lateAcceptMs) await db.transitionOrder(o.id, ["pending", "expired"], { status: "failed" });
  return rows;
}

const adminButtons = (o) => [[{ text: "✅ I sent the UTYA", callback_data: `od:ok:${o.id}` }]];

/**
 * The TON of an order was found on the blockchain. Applied once.
 * paid = { txHash, nano } (nano is a BigInt)
 * A payment that arrives after the quote ran out is re-quoted at the live price, so an old price can never be used.
 */
export async function completePayment(o, paid) {
  const now = Date.now();
  const done = await db.transitionOrder(o.id, ["pending", "expired"], { status: "paid", txHash: paid.txHash, paidNano: String(paid.nano), paidAt: now });
  if (!done) return false;
  let order = done;
  let requoted = false;
  let unquoted = false;
  if (now > done.expiresAt) {
    const price = await runtime.price?.get().catch(() => null);
    if (price) {
      const q = computeQuote(done.ton, price, (await getSettings()).feePct);
      order = (await db.transitionOrder(done.id, ["paid"], { utya: q.utya, quotedUtya: done.utya, utyaUsd: q.utyaUsd, tonUsd: q.tonUsd, feePct: q.feePct, requoted: true })) ?? done;
      requoted = true;
    } else {
      unquoted = true; // no live price right now: the old quote stays and the admin is told
    }
  }
  await db.incMeta("receivedMilliTon", Math.round(done.ton * 1000));

  const user = await db.getUser(order.userId);
  const s = await getSettings();
  void hooks.notify(
    order.userId,
    T(langOf(user), requoted ? "order.paidLate" : "order.paid", { id: order.id, ton: order.ton, utya: fmt(order.utya), symbol: TOKEN.symbol, hours: s.deliveryHours }),
  );
  const extra = paid.nano > toNano(order.ton) ? ` ⚠️ overpaid: received ${Number(paid.nano) / 1e9} TON` : "";
  const flags = [requoted ? `🔁 paid late, re-quoted at the live price (was ${fmt(order.quotedUtya)} ${TOKEN.symbol})` : "", unquoted ? "⚠️ paid late and no live price was available: the old quote was kept, check it" : ""].filter(Boolean).join("\n");
  void hooks.notifyAdmins(
    [
      `💰 <b>New order ${escapeHtml(order.id)}</b>`,
      `${escapeHtml(user?.name ?? order.userId)} (<code>${order.userId}</code>)${user?.username ? " @" + escapeHtml(user.username) : ""}`,
      `Paid: <b>${order.ton} TON</b>${extra}`,
      `Send: <b>${fmt(order.utya)} ${TOKEN.symbol}</b> (price ${order.utyaUsd} USD, fee ${order.feePct}%)`,
      `To wallet:\n<code>${escapeHtml(order.wallet)}</code>`,
      ...(flags ? [flags] : []),
      "",
      `After you sent it, tap the button (or /delivered ${order.id} [tx hash]).`,
    ].join("\n"),
    adminButtons(order),
  );
  return true;
}

/** The buyer asks for the TON back. Possible until the admin has sent the UTYA. */
export async function requestRefund(userId, id) {
  const o = await orderOf(userId, id);
  const moved = await db.transitionOrder(o.id, ["paid"], { status: "refund_requested", refundRequestedAt: Date.now() });
  if (!moved) throw new GameError("This order can not be refunded any more.", "refund_not_possible", { status: o.status });
  const user = await db.getUser(userId);
  void hooks.notify(userId, T(langOf(user), "order.refundReq", { id: o.id, ton: o.ton }));
  void hooks.notifyAdmins(
    [
      `↩️ <b>Refund requested: order ${escapeHtml(o.id)}</b>`,
      `${escapeHtml(user?.name ?? userId)} (<code>${userId}</code>)`,
      `Send back: <b>${o.ton} TON</b> to\n<code>${escapeHtml(o.wallet)}</code>`,
      "",
      `After you sent it: /refunded ${o.id} [tx hash]`,
    ].join("\n"),
  );
  return orderView(moved);
}

/** Admin: the UTYA was sent to the buyer's wallet. */
export async function markDelivered(id, adminId, tx = "") {
  const o = await db.getOrder(String(id).toUpperCase());
  if (!o) throw new GameError(`Order ${id} not found.`);
  const moved = await db.transitionOrder(o.id, ["paid"], { status: "delivered", deliveredAt: Date.now(), deliveredBy: adminId, deliveryTx: String(tx ?? "").slice(0, 100) });
  if (!moved) {
    if (o.status === "refund_requested") throw new GameError(`Order ${o.id}: the buyer asked for a refund. Send the TON back and use /refunded ${o.id}.`);
    throw new GameError(`Order ${o.id} is "${o.status}", it can not be marked as delivered.`);
  }
  const user = await db.getUser(o.userId);
  void hooks.notify(o.userId, T(langOf(user), "order.delivered", { id: o.id, utya: fmt(moved.utya), symbol: TOKEN.symbol, tx: moved.deliveryTx ? `\nTx: ${moved.deliveryTx}` : "" }));
  await db.incMeta("deliveredUtyaCents", Math.round(moved.utya * 100));
  return moved;
}

/** Admin: the TON was sent back to the buyer. */
export async function markRefunded(id, adminId, tx = "") {
  const o = await db.getOrder(String(id).toUpperCase());
  if (!o) throw new GameError(`Order ${id} not found.`);
  const moved = await db.transitionOrder(o.id, ["paid", "refund_requested"], { status: "refunded", refundedAt: Date.now(), refundedBy: adminId, refundTx: String(tx ?? "").slice(0, 100) });
  if (!moved) throw new GameError(`Order ${o.id} is "${o.status}", it can not be marked as refunded.`);
  const user = await db.getUser(o.userId);
  void hooks.notify(o.userId, T(langOf(user), "order.refunded", { id: o.id, ton: o.ton, tx: moved.refundTx ? `\nTx: ${moved.refundTx}` : "" }));
  await db.incMeta("refundedMilliTon", Math.round(moved.ton * 1000));
  return moved;
}

// ---------------------------------- app state ---------------------------------

export async function stateFor(id) {
  const u = await mustUser(id);
  const s = await getSettings();
  const price = (await runtime.price?.get().catch(() => null)) ?? null;
  const orders = await db.listOrders({ userId: id, limit: 20 });
  return {
    user: { id: u.id, name: u.name, wallet: u.wallet, lang: langOf(u) },
    settings: { buyOpen: s.buyOpen, minTon: s.minTon, maxTon: s.maxTon, feePct: s.feePct, deliveryHours: s.deliveryHours, support: s.support, payAddress: await getDepositAddress() },
    price: price ? { tonUsd: price.tonUsd, utyaUsd: price.utyaUsd, perTon: round2(price.tonUsd / price.utyaUsd), at: price.at } : null,
    token: { name: TOKEN.name, symbol: TOKEN.symbol, jetton: TOKEN.jettonFriendly },
    orders: orders.map(orderView),
    now: Date.now(),
  };
}

// ---------------------------------- admin ------------------------------------

export async function adminStats() {
  const meta = await db.getMeta();
  const [awaiting, refunds, unpaid] = await Promise.all([
    db.listOrders({ statuses: ["paid"], oldestFirst: true, limit: 100 }),
    db.listOrders({ statuses: ["refund_requested"], oldestFirst: true, limit: 100 }),
    db.listOrders({ statuses: ["pending", "expired"], limit: 100 }),
  ]);
  return {
    users: await db.countUsers(),
    awaiting,
    refunds,
    unpaid,
    receivedTon: (meta.receivedMilliTon ?? 0) / 1000,
    refundedTon: (meta.refundedMilliTon ?? 0) / 1000,
    deliveredUtya: (meta.deliveredUtyaCents ?? 0) / 100,
  };
}
export async function userCounts() {
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  return { total: await db.countUsers(), today: await db.countUsersSince(day.getTime()), week: await db.countUsersSince(Date.now() - 7 * 24 * 3600 * 1000) };
}
export async function userInfo(id) {
  const u = await mustUser(id);
  const orders = await db.listOrders({ userId: id, limit: 5 });
  return { ...u, orders };
}
export const getUser = (id) => db.getUser(id);
export const allUserIds = () => db.allUserIds();
