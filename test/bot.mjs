import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import * as game from "../src/game.js";
import { createBot } from "../src/bot.js";
import { createPay } from "../src/pay.js";
import { friendlyAddress } from "../src/ton.js";

const sent = [];
globalThis.fetch = async (url, init) => {
  const method = String(url).split("/").pop();
  const body = JSON.parse(init.body);
  sent.push({ method, body });
  return { json: async () => ({ ok: true, result: {} }) };
};
const db = await openDb({ mongoUri: "", file: null });
game.init(db);
game.runtime.price = { get: async () => ({ tonUsd: 2, utyaUsd: 0.02, at: Date.now(), sources: ["mock"] }), peek: () => null };
game.runtime.envDepositAddress = friendlyAddress({ wc: 0, hash: Buffer.alloc(32, 1) });
const pay = createPay({ tonApi: { recentEvents: async () => [] } });
const bot = createBot({ token: "1:x", username: "UTYA_miner_bot", publicUrl: "https://x.test", adminIds: [1], webhookSecret: "s", pay });

const msg = (from, text) => ({ update_id: 1, message: { from: { id: from, first_name: from === 1 ? "Admin" : "User" }, chat: { id: from, type: "private" }, text } });
const last = () => sent.filter((s) => s.method === "sendMessage").at(-1).body;
const say = async (from, text) => { sent.length = 0; await bot.handleUpdate(msg(from, text)); return sent.filter((s) => s.method === "sendMessage").map((s) => s.body.text).join("\n---\n"); };

let o = await say(2, "/start"); assert.match(o, /UTYA Miner/); assert.match(o, /not affiliated|unofficial/i); assert.doesNotMatch(o, /Tanos/i);
o = await say(2, "/stats"); assert.match(o, /Open UTYA Miner|button/i, "players do not get admin commands");
o = await say(2, "/help"); assert.doesNotMatch(o, /Admin commands/);
o = await say(1, "/help"); assert.match(o, /Admin commands/); assert.match(o, /\/delivered/); assert.match(o, /\/refunded/);
o = await say(1, "/price"); assert.match(o, /1 TON → <b>100 UTYA/);
o = await say(1, "/setfee 2"); assert.match(o, /2%/);
o = await say(1, "/setfee 50"); assert.match(o, /Usage/);
o = await say(1, "/setmin 2"); assert.match(o, /2 TON/);
o = await say(1, "/setmax 1"); assert.match(o, /can not be below/);
o = await say(1, "/setdelivery 12"); assert.match(o, /12 hours/);
o = await say(1, "/buyoff"); assert.match(o, /PAUSED/);
o = await say(1, "/buyon"); assert.match(o, /OPEN/);
o = await say(1, "/settings"); assert.match(o, /fee: <b>2%/);
o = await say(1, "/orders"); assert.match(o, /No paid order/);
o = await say(1, "/addadmin 5"); assert.match(o, /now an admin/);
o = await say(5, "/orders"); assert.match(o, /No paid order/, "extra admins work");
o = await say(5, "/setdepositaddress UQabc"); assert.match(o, /Only the owner/);
o = await say(1, "/channeljoinpopupshow @mychannel"); assert.match(o, /must join/);
o = await say(1, "/channeljoinlist"); assert.match(o, /@mychannel/);
o = await say(1, "/noneedchanneljoin"); assert.match(o, /OFF/);
o = await say(1, "/setsupport @helper_name"); assert.match(o, /saved/);
o = await say(1, "/setwelcome Hello {x}"); assert.match(o, /saved/);
o = await say(2, "/start"); assert.match(o, /Hello/);
o = await say(1, "/setwelcome reset");

// a real order through the bot
await game.setWallet(2, friendlyAddress({ wc: 0, hash: Buffer.alloc(32, 8) }));
const prep = await pay.prepare(2, 5);
await pay.confirmManually(prep.id, 1);
sent.length = 0;
o = await say(1, "/orders"); assert.match(o, new RegExp(prep.id)); assert.match(o, /490 UTYA/);
const btn = last().reply_markup.inline_keyboard[0][0]; assert.equal(btn.callback_data, `od:ok:${prep.id}`);
o = await say(1, `/order ${prep.id}`); assert.match(o, /paid/);

// refund path
await game.requestRefund(2, prep.id);
o = await say(1, "/refunds"); assert.match(o, new RegExp(prep.id));
o = await say(1, `/delivered ${prep.id}`); assert.match(o, /refund/);
sent.length = 0;
o = await say(1, `/refunded ${prep.id} TXREF`); assert.match(o, /refunded/);
assert.ok(sent.some((s) => s.body.chat_id === 2 && /refunded/i.test(s.body.text)), "the buyer is told");

// button path
const prep2 = await pay.prepare(2, 4); await pay.confirmManually(prep2.id, 1);
sent.length = 0;
await bot.handleUpdate({ update_id: 2, callback_query: { id: "c1", from: { id: 1 }, data: `od:ok:${prep2.id}`, message: { chat: { id: 1 }, message_id: 7 } } });
assert.equal((await game.getOrder(prep2.id)).status, "delivered");
assert.ok(sent.some((s) => s.method === "editMessageReplyMarkup"));
assert.ok(sent.some((s) => s.body.chat_id === 2 && /sent to your wallet/i.test(s.body.text)));
// a non admin can not press it
const prep3 = await pay.prepare(2, 3); await pay.confirmManually(prep3.id, 1);
await bot.handleUpdate({ update_id: 3, callback_query: { id: "c2", from: { id: 2 }, data: `od:ok:${prep3.id}`, message: { chat: { id: 2 }, message_id: 8 } } });
assert.equal((await game.getOrder(prep3.id)).status, "paid");

o = await say(1, "/stats"); assert.match(o, /TON received: <b>12.00/);
o = await say(1, "/user 2"); assert.match(o, /Last orders/);
o = await say(1, "/ban 2 spam"); assert.match(o, /banned/);
o = await say(2, "/start"); assert.match(o, /blocked|заблок|ব্লক/);
o = await say(1, "/unban 2"); assert.match(o, /unbanned/);
o = await say(1, "/totalusers"); assert.match(o, /Total/);
console.log("bot commands OK");
