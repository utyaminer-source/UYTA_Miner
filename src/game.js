// All the rules of UTYA Miner: settings, players, live quotes, orders, refunds and delivery.
// One order = one TON payment from the buyer + the UTYA the buyer is owed. An admin sends the UTYA by hand.
//
// Order status:  pending (waiting for the TON) -> expired (quote over, still found if paid late) -> failed (never paid)
//                paid (TON received, waiting for the admin) -> delivered (admin sent the UTYA)
//                paid -> refund_requested (buyer asked) -> refunded (admin sent the TON back)
//
// Mining: a user starts a session (MINING.sessionHours long, speed = the rate at the start), comes back, claims it and the UTYA lands in his
//         mined balance. Everything is calculated on the server, the app only shows it.
// Withdrawal status: pending (balance is held) -> sent (admin sent the UTYA) | rejected (balance goes back) | cancelled (user took it back)
import crypto from "node:crypto";
import { BRAND, DEFAULTS, LANGS, MINING, NFT, ORDER, REFERRAL, TOKEN } from "./config.js";
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
const floor4 = (n) => Math.floor(n * 1e4 + 1e-6) / 1e4;
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
    mineOpen: s.mineOpen !== false, // /mineon /mineoff
    nftOpen: s.nftOpen !== false, // /nfton /nftoff
    nftPrice: pos(s.nftPrice, NFT.priceTon), // TON, /setnftprice
    withdrawOpen: s.withdrawOpen !== false, // /withdrawon /withdrawoff
    mineRate: pos(s.mineRate, MINING.ratePerHour), // UTYA per hour
    minWithdraw: pos(s.minWithdraw, MINING.minWithdraw), // UTYA
    refBonus: Number.isFinite(s.refBonus) && s.refBonus >= 0 ? s.refBonus : REFERRAL.bonusUtya, // UTYA per counted friend (0 = referrals pay nothing)
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
  if (l === "fa") return "ar"; // Persian speakers get Arabic (the closest language the app has)
  return LANGS.includes(l) ? l : "en";
};
const langOf = (u) => (u && LANGS.includes(u.lang) ? u.lang : "en");

async function mustUser(id) {
  const u = await db.getUser(id);
  if (!u) throw new GameError("Account not found. Open the bot and press Start.", "no_account");
  return u;
}

/**
 * Creates the account on the first contact. `opts.ref` is the Telegram id of the inviter (from the link t.me/bot?start=ref_ID).
 * A referral is only remembered for a brand-new account, for a real inviter, and never for yourself.
 */
export async function ensureUser(tg, opts = {}) {
  return withLock("u" + tg.id, async () => {
    const now = Date.now();
    const name = displayName(tg);
    let u = await db.getUser(tg.id);
    if (!u) {
      u = { id: tg.id, name, username: tg.username ?? "", lang: langFromTelegram(tg.language_code), createdAt: now, lastSeen: now, wallet: "", banned: false };
      const ref = Number(opts.ref);
      if (Number.isSafeInteger(ref) && ref > 0 && ref !== tg.id && (await db.getUser(ref))) u.referredBy = ref;
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

/** The mining data of a user. Old accounts get it the first time it is needed. */
function mineOf(u) {
  u.mining = { balance: 0, total: 0, withdrawn: 0, sessionStart: 0, sessionRate: 0, refEarned: 0, refCount: 0, ...(u.mining ?? {}) };
  return u.mining;
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
  await creditReferral(id).catch((err) => console.error("[game] referral:", err.message));
  return friendly;
}

/**
 * A friend counts once: he came with the link of an inviter, and he connected a wallet that no other account uses.
 * Then the inviter gets the bonus in his mined balance and a message.
 */
async function creditReferral(id) {
  const first = await db.getUser(id);
  if (!first?.referredBy || first.refCounted || !first.wallet) return false;
  const s = await getSettings();
  let inviter = 0;
  const counted = await patchUser(id, async (u) => {
    if (!u.referredBy || u.refCounted || !u.wallet) return false;
    if (await db.findUserByWallet(u.wallet, id)) return false; // the same wallet on two accounts is not a new friend
    u.refCounted = true;
    u.refCountedAt = Date.now();
    inviter = u.referredBy;
    return true;
  });
  if (!counted) return false;
  const paid = await patchUser(inviter, (r) => {
    if (r.banned) return false;
    const m = mineOf(r);
    m.refCount += 1;
    m.balance = round4(m.balance + s.refBonus);
    m.refEarned = round4(m.refEarned + s.refBonus);
    return true;
  }).catch(() => false);
  if (paid && s.refBonus > 0) {
    await db.incMeta("bonusUtya4", Math.round(s.refBonus * 1e4));
    const r = await db.getUser(inviter);
    void hooks.notify(inviter, T(langOf(r), "ref.counted", { name: first.name, bonus: fmt(s.refBonus), symbol: TOKEN.symbol }));
  }
  return true;
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
/** The live price, as fast as possible. The server reads the market in the background every few seconds, so the price in memory is
 *  normally fresh: it is used at once if it is younger than a minute. Only when there is none the request waits for the market. */
async function livePrice() {
  const cached = runtime.price?.peek?.();
  if (cached && Date.now() - cached.at < 60_000) return cached;
  return runtime.price?.get();
}

export async function quote(rawTon) {
  const s = await getSettings();
  if (!s.buyOpen) throw new GameError("Buying is paused right now.", "buy_closed");
  const ton = checkAmount(rawTon, s);
  const price = await livePrice();
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
    kind: o.kind ?? "buy",
    nftId: o.nftId ?? "",
    nftSerial: o.nftSerial ?? 0,
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
  const same = open.find((o) => o.kind !== "nft" && o.ton === q.ton && now - o.createdAt < 60_000 && o.wallet === u.wallet);
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
  // no message here: the player and the admin are told only when the payment really arrived
  return o;
}

/** The player cancelled the payment in his wallet. Quiet: no message to anybody, and the order disappears from his list.
 *  It is not thrown away, only marked, so that TON which still arrives afterwards is found and delivered as usual. */
export async function cancelOrder(userId, id) {
  const o = await db.getOrder(String(id).toUpperCase());
  if (!o || o.userId !== userId) throw new GameError("Order not found.", "order_missing");
  const moved = await db.transitionOrder(o.id, ["pending"], { status: "expired", cancelled: true, expiresAt: Date.now() });
  return Boolean(moved);
}

/**
 * Admin: delete the old orders. Orders whose customer still waits for UTYA or for a refund (paid, refund_requested) are KEPT, unless all = true.
 * Everybody whose order was still open (pending / expired) gets one message: "your order was cancelled".
 * dryRun only counts.
 */
export async function clearOrders({ all = false, dryRun = false } = {}) {
  const owing = ["paid", "refund_requested"];
  const deletable = ["pending", "expired", "failed", "delivered", "refunded", ...(all ? owing : [])];
  const rows = await db.listOrders({ limit: 1_000_000 });
  const gone = rows.filter((o) => deletable.includes(o.status));
  const kept = rows.filter((o) => !deletable.includes(o.status));
  const toTell = gone.filter((o) => (o.status === "pending" || o.status === "expired") && !o.cancelled);
  if (dryRun) return { total: rows.length, deleted: gone.length, kept, told: toTell.length };
  let told = 0;
  for (const o of toTell) {
    const user = await db.getUser(o.userId);
    void hooks.notify(o.userId, T(langOf(user), "order.cancelled", { id: o.id, ton: o.ton }));
    told++;
    await new Promise((r) => setTimeout(r, 60)); // slowly, Telegram does not like a flood of messages
  }
  const deleted = await db.deleteOrders(gone.map((o) => o.id), deletable);
  return { total: rows.length, deleted, kept, told };
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
      if (moved) o.status = "expired"; // quiet: an unpaid order that runs out is not worth a message
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
  const done = await db.transitionOrder(o.id, ["pending", "expired"], { status: "paid", txHash: paid.txHash, paidNano: String(paid.nano), paidAt: now, cancelled: false });
  if (!done) return false;
  if (done.kind === "nft") return completeNftOrder(done); // an NFT order: the NFT is given at once, nothing to send by hand
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

// ---------------------------------- mining -----------------------------------

/** Where the session of a user stands right now. `earned` is what the full session pays. */
export function sessionView(u, now = Date.now()) {
  const m = mineOf({ mining: u.mining });
  if (!m.sessionStart) return null;
  const end = m.sessionStart + MINING.sessionMs;
  return { start: m.sessionStart, end, rate: m.sessionRate, earned: floor4(m.sessionRate * MINING.sessionHours), ready: now >= end };
}

/** Start a mining session. The speed is fixed for the whole session (an admin change only counts from the next one). */
export async function startMining(userId) {
  const s = await getSettings();
  if (!s.mineOpen) throw new GameError("Mining is paused right now.", "mine_closed");
  return patchUser(userId, (u) => {
    const m = mineOf(u);
    const now = Date.now();
    if (m.sessionStart && now < m.sessionStart + MINING.sessionMs) throw new GameError("You are already mining.", "already_mining");
    if (m.sessionStart) throw new GameError("Claim your finished session first.", "claim_first");
    m.sessionStart = now;
    m.sessionRate = effectiveRate(s.mineRate, u); // base speed + the boost of the NFTs the player owns right now
    return sessionView(u, now);
  });
}

/** Claim a finished session: the whole session is paid into the mined balance, once. */
export async function claimMining(userId) {
  const claimed = await patchUser(userId, (u) => {
    const m = mineOf(u);
    const now = Date.now();
    if (!m.sessionStart) throw new GameError("No mining session is running.", "not_mining");
    if (now < m.sessionStart + MINING.sessionMs) throw new GameError("Your session is not finished yet.", "not_ready");
    const earned = floor4(m.sessionRate * MINING.sessionHours);
    m.balance = round4(m.balance + earned);
    m.total = round4(m.total + earned);
    m.sessionStart = 0;
    m.sessionRate = 0;
    return earned;
  });
  await db.incMeta("minedUtya4", Math.round(claimed * 1e4));
  return claimed;
}

// -------------------------------- withdrawals --------------------------------

const newWithdrawId = () => crypto.randomBytes(4).toString("hex").toUpperCase();

export function withdrawView(w) {
  return { id: w.id, amount: w.amount, status: w.status, wallet: w.wallet, createdAt: w.createdAt, doneAt: w.doneAt ?? 0, tx: w.tx ?? "", reason: w.reason ?? "" };
}

const returnBalance = (userId, amount) =>
  patchUser(userId, (u) => {
    const m = mineOf(u);
    m.balance = round4(m.balance + amount);
  });

/** The user asks to be paid out. The amount leaves his balance at once (it is held) and an admin sends the UTYA by hand. */
export async function requestWithdraw(userId, rawAmount) {
  return withLock("wd" + userId, async () => {
    const s = await getSettings();
    if (!s.withdrawOpen) throw new GameError("Withdrawals are paused right now.", "withdraw_closed");
    const amount = floor4(Number(rawAmount));
    if (!Number.isFinite(amount) || amount <= 0) throw new GameError("Enter how many UTYA you want to withdraw.", "bad_utya_amount", { min: s.minWithdraw });
    if (amount < s.minWithdraw) throw new GameError(`The minimum withdrawal is ${s.minWithdraw} UTYA.`, "too_low", { min: s.minWithdraw });
    const waiting = await db.listWithdrawals({ statuses: ["pending"], userId, limit: 20 });
    if (waiting.length >= MINING.maxOpenWithdrawals) throw new GameError("You already have withdrawal requests waiting.", "too_many_withdrawals");
    let wallet = "";
    await patchUser(userId, (u) => {
      if (!u.wallet) throw new GameError("Connect your TON wallet first.", "no_wallet");
      const m = mineOf(u);
      if (m.balance + 1e-9 < amount) throw new GameError("Not enough mined UTYA.", "no_balance");
      m.balance = round4(Math.max(0, m.balance - amount));
      wallet = u.wallet;
    });
    const w = { id: newWithdrawId(), userId, amount, wallet, status: "pending", createdAt: Date.now() };
    try {
      await db.addWithdrawal(w);
    } catch (err) {
      await returnBalance(userId, amount); // the request could not be saved: nothing is lost
      throw err;
    }
    const user = await db.getUser(userId);
    void hooks.notify(userId, T(langOf(user), "wd.requested", { id: w.id, amount: fmt(amount), symbol: TOKEN.symbol, hours: s.deliveryHours }));
    void hooks.notifyAdmins(
      [
        `⛏️ <b>Withdrawal ${escapeHtml(w.id)}</b>`,
        `${escapeHtml(user?.name ?? userId)} (<code>${userId}</code>)${user?.username ? " @" + escapeHtml(user.username) : ""}`,
        `Send: <b>${fmt(amount)} ${TOKEN.symbol}</b>`,
        `To wallet:\n<code>${escapeHtml(wallet)}</code>`,
        `Mined in total: ${fmt(mineOf(user ?? {}).total)} ${TOKEN.symbol} · withdrawn before: ${fmt(mineOf(user ?? {}).withdrawn)} ${TOKEN.symbol}`,
        "",
        `After you sent it, tap ✅ (or /wsent ${w.id} [tx hash]). To refuse: ❌ (or /wreject ${w.id} [reason]).`,
      ].join("\n"),
      [[{ text: "✅ I sent the UTYA", callback_data: `wd:ok:${w.id}` }, { text: "❌ Reject", callback_data: `wd:no:${w.id}` }]],
    );
    return withdrawView(w);
  });
}

/** The user takes a waiting request back. */
export async function cancelWithdraw(userId, id) {
  const w = await db.getWithdrawal(String(id).toUpperCase());
  if (!w || w.userId !== userId) throw new GameError("Withdrawal not found.", "withdraw_missing");
  const moved = await db.transitionWithdrawal(w.id, ["pending"], { status: "cancelled", doneAt: Date.now() });
  if (!moved) throw new GameError("This withdrawal can not be cancelled any more.", "cannot_cancel");
  await returnBalance(userId, moved.amount);
  return withdrawView(moved);
}

/** Admin: the UTYA was sent to the user's wallet. */
export async function markWithdrawSent(id, adminId, tx = "") {
  const w = await db.getWithdrawal(String(id).toUpperCase());
  if (!w) throw new GameError(`Withdrawal ${id} not found.`);
  const moved = await db.transitionWithdrawal(w.id, ["pending"], { status: "sent", doneAt: Date.now(), doneBy: adminId, tx: String(tx ?? "").slice(0, 100) });
  if (!moved) throw new GameError(`Withdrawal ${w.id} is "${w.status}", it can not be marked as sent.`);
  await patchUser(moved.userId, (u) => {
    const m = mineOf(u);
    m.withdrawn = round4(m.withdrawn + moved.amount);
  }).catch((err) => console.error("[game] could not update withdrawn total:", err.message));
  await db.incMeta("withdrawnUtya4", Math.round(moved.amount * 1e4));
  const user = await db.getUser(moved.userId);
  void hooks.notify(moved.userId, T(langOf(user), "wd.sent", { id: moved.id, amount: fmt(moved.amount), symbol: TOKEN.symbol, tx: moved.tx ? `\nTx: ${moved.tx}` : "" }));
  return moved;
}

/** Admin: refuse a request. The held UTYA goes back to the user's mined balance. */
export async function rejectWithdraw(id, adminId, reason = "") {
  const w = await db.getWithdrawal(String(id).toUpperCase());
  if (!w) throw new GameError(`Withdrawal ${id} not found.`);
  const moved = await db.transitionWithdrawal(w.id, ["pending"], { status: "rejected", doneAt: Date.now(), doneBy: adminId, reason: String(reason ?? "").slice(0, 200) });
  if (!moved) throw new GameError(`Withdrawal ${w.id} is "${w.status}", it can not be rejected.`);
  await returnBalance(moved.userId, moved.amount);
  const user = await db.getUser(moved.userId);
  void hooks.notify(moved.userId, T(langOf(user), "wd.rejected", { id: moved.id, amount: fmt(moved.amount), symbol: TOKEN.symbol, reason: moved.reason ? `\n${moved.reason}` : "" }));
  return moved;
}

export const getWithdrawal = (id) => db.getWithdrawal(String(id).toUpperCase());

// ----------------------------------- NFT -------------------------------------
// A player owns NFTs as { nftId: count } in user.nfts (and user.nftLog keeps the serial numbers).
// Each one adds boostPct % to the speed of every NEW mining session.
// Buying: the player pays NFT price in TON (an order with kind "nft"); when the payment is found, one random NFT is given at once.

export const nftDef = (id) => NFT.items.find((n) => n.id === String(id)) ?? null;

/** The NFTs of a user, cleaned: only known ids and whole numbers. */
export function nftsOf(u) {
  const out = {};
  for (const it of NFT.items) {
    const n = Math.floor(Number(u?.nfts?.[it.id]));
    if (n > 0) out[it.id] = n;
  }
  return out;
}
const nftCount = (u) => Object.values(nftsOf(u)).reduce((a, b) => a + b, 0);
/** Total boost in percent of everything the user owns. */
export function nftBoostPct(u) {
  const owned = nftsOf(u);
  return NFT.items.reduce((sum, it) => sum + (owned[it.id] ?? 0) * it.boostPct, 0);
}
export const effectiveRate = (baseRate, u) => round4(baseRate * (1 + nftBoostPct(u) / 100));

/** Draw one NFT by its weight. */
export function rollNft(rand = Math.random) {
  const total = NFT.items.reduce((a, it) => a + it.weight, 0);
  let x = rand() * total;
  for (const it of NFT.items) {
    x -= it.weight;
    if (x < 0) return it;
  }
  return NFT.items[NFT.items.length - 1];
}

export async function nftView(u, s) {
  const owned = nftsOf(u);
  const total = NFT.items.reduce((a, it) => a + it.weight, 0);
  const sold = Math.min(NFT.supply, (await db.getMeta()).nftSold ?? 0);
  const log = Array.isArray(u.nftLog) ? u.nftLog : [];
  return {
    open: s.nftOpen,
    priceTon: s.nftPrice,
    supply: NFT.supply,
    sold,
    maxPerUser: NFT.maxPerUser,
    boostPct: nftBoostPct(u),
    count: Object.values(owned).reduce((a, b) => a + b, 0),
    items: NFT.items.map((it) => ({
      id: it.id,
      art: it.art,
      name: it.name,
      rarity: it.rarity,
      boostPct: it.boostPct,
      chance: Math.round((it.weight / total) * 1000) / 10,
      owned: owned[it.id] ?? 0,
      serials: log.filter((l) => l.id === it.id && l.serial > 0).map((l) => l.serial).slice(-12),
    })),
  };
}

/** The player pressed "Buy": makes the order he has to pay in TON. */
export async function createNftOrder(userId) {
  const s = await getSettings();
  if (!s.nftOpen) throw new GameError("The NFT shop is closed right now.", "nft_closed");
  const u = await mustUser(userId);
  if (nftCount(u) >= NFT.maxPerUser) throw new GameError(`You can own at most ${NFT.maxPerUser} NFTs.`, "nft_limit", { max: NFT.maxPerUser });
  const sold = (await db.getMeta()).nftSold ?? 0;
  if (sold >= NFT.supply) throw new GameError("All NFTs are sold out.", "nft_soldout");
  const now = Date.now();
  const open = await db.listOrders({ statuses: ["pending"], userId, since: now - ORDER.pendingMs, limit: 20 });
  const same = open.find((o) => o.kind === "nft" && now - o.createdAt < 60_000 && o.ton === s.nftPrice); // pressing twice must not make two orders
  if (same) return same;
  if (open.length >= ORDER.maxOpenPerUser) throw new GameError("You have too many unpaid orders. Finish or wait for them first.", "too_many_orders");
  const o = { id: newOrderId(), userId, kind: "nft", ton: s.nftPrice, utya: 0, status: "pending", createdAt: now, expiresAt: now + ORDER.pendingMs, wallet: u.wallet ?? "" };
  await db.addOrder(o);
  return o;
}

/** The TON of an NFT order was found: give one random NFT at once. Called by completePayment. */
async function completeNftOrder(order) {
  const now = Date.now();
  await db.incMeta("receivedMilliTon", Math.round(order.ton * 1000));
  const user = await db.getUser(order.userId);
  const serial = await db.incMeta("nftSold", 1);
  const stuck = (why) =>
    hooks.notifyAdmins(`⚠️ <b>NFT order ${escapeHtml(order.id)}</b> was paid (${order.ton} TON) but ${escapeHtml(why)}.\n${escapeHtml(user?.name ?? order.userId)} (<code>${order.userId}</code>)\nSend the TON back: /refunded ${order.id} [tx hash]`);
  if (serial > NFT.supply) {
    await db.incMeta("nftSold", -1);
    void stuck("all NFTs were already sold out");
    void hooks.notify(order.userId, T(langOf(user), "nft.soldout", { id: order.id, ton: order.ton }));
    return true;
  }
  const it = rollNft(() => crypto.randomInt(0, 1e9) / 1e9);
  try {
    await patchUser(order.userId, (u) => {
      const owned = nftsOf(u);
      u.nfts = { ...owned, [it.id]: (owned[it.id] ?? 0) + 1 };
      u.nftLog = [...(Array.isArray(u.nftLog) ? u.nftLog : []), { id: it.id, serial, at: now, order: order.id }].slice(-300);
    });
  } catch (err) {
    await db.incMeta("nftSold", -1);
    console.error("[game] could not give the NFT:", err.message);
    void stuck("the NFT could not be given");
    return true;
  }
  const done = await db.transitionOrder(order.id, ["paid"], { status: "delivered", deliveredAt: now, deliveredBy: 0, nftId: it.id, nftSerial: serial });
  const after = await db.getUser(order.userId);
  void hooks.notify(order.userId, T(langOf(after), "nft.won", { name: it.name, serial, boost: it.boostPct, total: nftBoostPct(after ?? {}) }));
  void hooks.notifyAdmins(`🦆 NFT #${serial} sold (${order.ton} TON): ${escapeHtml(it.name)} → ${escapeHtml(user?.name ?? order.userId)} (<code>${order.userId}</code>)`);
  return Boolean(done);
}

/** Admin: give (n > 0) or take away (n < 0) NFTs of one kind. Gifts do not count as sold. */
export async function adminGiveNft(userId, nftId, n = 1) {
  const it = nftDef(nftId);
  if (!it) throw new GameError(`Unknown NFT "${nftId}". Known: ${NFT.items.map((x) => x.id).join(", ")}`);
  const amount = Math.trunc(Number(n));
  if (!Number.isFinite(amount) || amount === 0) throw new GameError("The number must be a whole number, for example 1 or -1.");
  const res = await patchUser(userId, (u) => {
    const owned = nftsOf(u);
    const next = (owned[it.id] ?? 0) + amount;
    if (next < 0) throw new GameError(`He only has ${owned[it.id] ?? 0} of ${it.name}.`);
    u.nfts = { ...owned, [it.id]: next };
    if (next === 0) delete u.nfts[it.id];
    return { lang: langOf(u), count: next, boostPct: nftBoostPct(u) };
  });
  if (amount > 0) void hooks.notify(userId, T(res.lang, "nft.gifted", { name: it.name, boost: it.boostPct, total: res.boostPct }));
  return { item: it, ...res };
}

// ---------------------------------- app state ---------------------------------

export async function stateFor(id) {
  const u = await mustUser(id);
  const s = await getSettings();
  // opening the app must never wait for the market: take the price from memory (at most 1.5 s of waiting when there is none yet)
  const price =
    runtime.price?.peek?.() ??
    (await Promise.race([runtime.price?.get().catch(() => null) ?? null, new Promise((r) => setTimeout(() => r(null), 1500))])) ??
    null;
  const orders = (await db.listOrders({ userId: id, limit: 40 })).filter((o) => !o.cancelled).slice(0, 20);
  const withdrawals = await db.listWithdrawals({ userId: id, limit: 20 });
  const m = mineOf(u);
  const friends = await db.listReferrals(id, 100);
  return {
    official: BRAND.official,
    referral: {
      bonus: s.refBonus,
      link: `https://t.me/${hooks.botUsername || BRAND.username}?start=ref_${id}`,
      invited: friends.length,
      counted: friends.filter((f) => f.refCounted).length,
      earned: m.refEarned,
      friends: friends.slice(0, 50).map((f) => ({ name: f.name, counted: Boolean(f.refCounted), at: f.createdAt })),
    },
    mining: {
      open: s.mineOpen,
      withdrawOpen: s.withdrawOpen,
      balance: m.balance,
      total: m.total,
      withdrawn: m.withdrawn,
      rate: effectiveRate(s.mineRate, u), // the speed the next session will have (base + NFT boost)
      baseRate: s.mineRate,
      boostPct: nftBoostPct(u),
      sessionHours: MINING.sessionHours,
      minWithdraw: s.minWithdraw,
      session: sessionView(u),
    },
    nft: await nftView(u, s),
    withdrawals: withdrawals.map(withdrawView),
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
  const [awaiting, refunds, unpaid, withdrawals] = await Promise.all([
    db.listOrders({ statuses: ["paid"], oldestFirst: true, limit: 100 }),
    db.listOrders({ statuses: ["refund_requested"], oldestFirst: true, limit: 100 }),
    db.listOrders({ statuses: ["pending", "expired"], limit: 100 }),
    db.listWithdrawals({ statuses: ["pending"], oldestFirst: true, limit: 100 }),
  ]);
  return {
    users: await db.countUsers(),
    awaiting,
    refunds,
    unpaid: unpaid.filter((o) => !o.cancelled),
    withdrawals,
    minedUtya: (meta.minedUtya4 ?? 0) / 1e4,
    withdrawnUtya: (meta.withdrawnUtya4 ?? 0) / 1e4,
    bonusUtya: (meta.bonusUtya4 ?? 0) / 1e4,
    nftSold: meta.nftSold ?? 0,
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
  const withdrawals = await db.listWithdrawals({ userId: id, limit: 5 });
  return { ...u, mining: mineOf(u), nfts: nftsOf(u), nftBoostPct: nftBoostPct(u), orders, withdrawals };
}
export const getUser = (id) => db.getUser(id);
export const allUserIds = () => db.allUserIds();
