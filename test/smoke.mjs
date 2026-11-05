import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import * as game from "../src/game.js";
import { createPay } from "../src/pay.js";
import { createPrice } from "../src/price.js";
import { TOKEN } from "../src/config.js";
import { friendlyAddress, matchPayments, parseAddress, toNano } from "../src/ton.js";

const addr = (n) => friendlyAddress({ wc: 0, hash: Buffer.alloc(32, n) });
const jettonRaw = TOKEN.jettonRaw;

// ---------------- price module ----------------
{
  let calls = [];
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  const bad = { ok: false, status: 500, json: async () => ({}) };
  let t = 1_000_000;
  const mk = (handler) => createPrice({ fetchImpl: async (url) => { calls.push(url); return handler(url); }, now: () => t });

  // TonAPI answers for both
  let p = mk(() => ok({ rates: { TON: { prices: { USD: 2 } }, [jettonRaw]: { prices: { USD: 0.02 } } } }));
  let r = await p.get();
  assert.equal(r.tonUsd, 2); assert.equal(r.utyaUsd, 0.02); assert.deepEqual(r.sources, ["tonapi"]);
  // cached inside the refresh window
  const n = calls.length; await p.get(); assert.equal(calls.length, n);

  // TonAPI down -> backups
  calls = [];
  p = mk((url) => {
    if (url.includes("tonapi")) return bad;
    if (url.includes("geckoterminal")) return ok({ data: { attributes: { token_prices: { [TOKEN.jettonFriendly]: "0.0197" } } } });
    if (url.includes("coingecko")) return ok({ "the-open-network": { usd: 1.9 } });
    return bad;
  });
  r = await p.get();
  assert.equal(r.utyaUsd, 0.0197); assert.equal(r.tonUsd, 1.9); assert.deepEqual(r.sources, ["geckoterminal", "coingecko"]);

  // half a price is never used
  p = mk((url) => (url.includes("tonapi") ? ok({ rates: { TON: { prices: { USD: 2 } } } }) : bad));
  assert.equal(await p.get(), null);

  // everything down: null. A good price turns stale after 5 minutes.
  let up = true;
  p = mk(() => (up ? ok({ rates: { TON: { prices: { USD: 2 } }, [TOKEN.jettonFriendly]: { prices: { USD: 0.02 } } } }) : bad));
  assert.ok(await p.get());
  up = false; t += 60_000;
  assert.ok(await p.get(), "a 1 minute old price is still fine");
  t += 5 * 60_000;
  assert.equal(await p.get(), null, "a price older than 5 minutes must not be used");
  console.log("price module OK");
}

// ---------------- quote maths ----------------
{
  const price = { tonUsd: 2, utyaUsd: 0.02, at: 1 };
  assert.equal(game.computeQuote(2, price, 0).utya, 200);
  assert.equal(game.computeQuote(2, price, 2).utya, 196);
  assert.equal(game.computeQuote(1, { tonUsd: 1.9, utyaUsd: 0.0197, at: 1 }, 0).utya, 96.44); // rounded DOWN
  assert.equal(game.computeQuote(1, price, 0).perTon, 100);
  console.log("quote maths OK");
}

// ---------------- the whole flow ----------------
const db = await openDb({ mongoUri: "", file: null });
game.init(db);
const notes = [];
const adminNotes = [];
game.hooks.notify = async (id, text) => notes.push([id, text]);
game.hooks.notifyAdmins = async (text, buttons) => adminNotes.push([text, buttons]);
let price = { tonUsd: 2, utyaUsd: 0.02, at: Date.now(), sources: ["mock"] };
game.runtime.price = { get: async () => price, peek: () => price };
const POOL = addr(1);
game.runtime.envDepositAddress = POOL;
const pay = createPay({ tonApi: { recentEvents: async () => events } });
let events = [];

await game.ensureUser({ id: 10, first_name: "Buyer", language_code: "bn" });
assert.equal((await game.getUser(10)).lang, "bn");
await assert.rejects(() => game.createOrder(10, 5), (e) => e.code === "no_wallet");
await game.setWallet(10, addr(7));
await assert.rejects(() => game.setWallet(10, "nonsense"), (e) => e.code === "bad_wallet");

await assert.rejects(() => game.quote(0.2), (e) => e.code === "too_small");
await assert.rejects(() => game.quote(100000), (e) => e.code === "too_big");
await assert.rejects(() => game.quote("abc"), (e) => e.code === "bad_amount");
const q = await game.quote(5);
assert.equal(q.utya, 500);

// no live price -> buying is blocked, not guessed
const saved = game.runtime.price;
game.runtime.price = { get: async () => null, peek: () => null };
await assert.rejects(() => game.quote(5), (e) => e.code === "price_unavailable");
game.runtime.price = saved;

// buying paused
await game.updateSettings({ buyOpen: false });
await assert.rejects(() => game.quote(5), (e) => e.code === "buy_closed");
await game.updateSettings({ buyOpen: true });

// fee is part of the quote
await game.updateSettings({ feePct: 2 });
assert.equal((await game.quote(5)).utya, 490);
await game.updateSettings({ feePct: 0 });

// prepare: message for the wallet, same amount twice reuses the order
const prep = await pay.prepare(10, 5);
assert.equal(prep.messages[0].amount, "5000000000");
assert.equal(prep.utya, 500);
assert.equal((await pay.prepare(10, 5)).id, prep.id);
const order = await game.getOrder(prep.id);
assert.equal(order.status, "pending");
assert.equal(order.wallet, addr(7));

// the price moves AFTER the order was made: the quote stays locked
price = { ...price, utyaUsd: 0.04 };

// not paid yet
assert.equal((await pay.checkOne(10, prep.id)).status, "pending");

// payment appears on the blockchain: right comment, right address, enough TON
const ev = (comment, nano, to = POOL) => ({ event_id: "tx" + comment, actions: [{ type: "TonTransfer", status: "ok", TonTransfer: { comment, amount: String(nano), recipient: { address: to }, sender: { address: addr(7) } } }] });
events = [ev(game.paymentComment(order), 4_000_000_000)]; // too little
assert.equal((await pay.checkOne(10, prep.id)).status, "pending");
events = [ev(game.paymentComment(order), 5_000_000_000, addr(3))]; // wrong receiver
assert.equal((await pay.checkOne(10, prep.id)).status, "pending");
events = [ev(game.paymentComment(order), 5_000_000_000)];
const paid = await pay.checkOne(10, prep.id);
assert.equal(paid.status, "paid");
assert.equal(paid.utya, 500, "locked quote is paid out, not the new price");
assert.equal(adminNotes.length, 1);
assert.match(adminNotes[0][0], /500 UTYA/);
assert.equal(adminNotes[0][1][0][0].callback_data, `od:ok:${order.id}`);
assert.match(notes.at(-1)[1], /৷|পেমেন্ট/, "the buyer gets the message in Bangla");
// applied once
assert.equal(await pay.sweep(), 0);
assert.equal(await game.completePayment(order, { txHash: "x", nano: 5_000_000_000n }), false);

// refund request
const afterRefundReq = await game.requestRefund(10, order.id);
assert.equal(afterRefundReq.status, "refund_requested");
await assert.rejects(() => game.requestRefund(10, order.id), (e) => e.code === "refund_not_possible");
await assert.rejects(() => game.markDelivered(order.id, 1), /refund/);
await assert.rejects(() => game.requestRefund(99, order.id), (e) => e.code === "order_missing");
const refunded = await game.markRefunded(order.id, 1, "abc");
assert.equal(refunded.status, "refunded");
await assert.rejects(() => game.markRefunded(order.id, 1), /can not/);

// second order: delivered, after which no refund
const prep2 = await pay.prepare(10, 3);
assert.equal(prep2.utya, 150); // new price 0.04 -> 3 TON * 2 / 0.04
const o2 = await game.getOrder(prep2.id);
events = [ev(game.paymentComment(o2), 3_000_000_000)];
await pay.sweep();
assert.equal((await game.getOrder(o2.id)).status, "paid");
const del = await game.markDelivered(o2.id, 1, "hash1");
assert.equal(del.status, "delivered");
await assert.rejects(() => game.requestRefund(10, o2.id), (e) => e.code === "refund_not_possible");
await assert.rejects(() => game.markDelivered(o2.id, 1), /can not/);

// late payment is re-quoted at the live price
const prep3 = await pay.prepare(10, 4);
const o3 = await game.getOrder(prep3.id);
await db.transitionOrder(o3.id, ["pending"], { status: "expired", expiresAt: Date.now() - 1000 });
price = { ...price, utyaUsd: 0.01 }; // the market moved while the buyer was late
events = [ev(game.paymentComment(o3), 4_000_000_000)];
await pay.sweep();
const late = await game.getOrder(o3.id);
assert.equal(late.status, "paid");
assert.equal(late.requoted, true);
assert.equal(late.utya, 800);
assert.equal(late.quotedUtya, 200);

// manual confirm
const prep4 = await pay.prepare(10, 2);
await pay.confirmManually(prep4.id, 1);
assert.equal((await game.getOrder(prep4.id)).status, "paid");

// stats, state
const st = await game.adminStats();
assert.equal(st.awaiting.length, 2);
assert.equal(st.receivedTon, 14);
const state = await game.stateFor(10);
assert.equal(state.orders.length, 4);
assert.equal(state.settings.payAddress, POOL);
assert.equal(state.price.perTon, 200);

// bans
await game.setBanned(10, true, "test");
assert.equal((await game.getUser(10)).banned, true);

console.log("order flow OK");
