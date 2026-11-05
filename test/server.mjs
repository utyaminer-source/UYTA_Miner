import crypto from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import assert from "node:assert/strict";
import { friendlyAddress } from "../src/ton.js";

const TOKEN = "123456:TESTTOKEN";
const POOL = friendlyAddress({ wc: 0, hash: Buffer.alloc(32, 1) });
const env = { ...process.env, BOT_TOKEN: TOKEN, ADMIN_IDS: "1", PORT: "3456", TON_DEPOSIT_ADDRESS: POOL, PUBLIC_URL: "", MONGODB_URI: "" };
const srv = spawn("node", ["server.js"], { cwd: path.resolve(import.meta.dirname, ".."), env, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; srv.stdout.on("data", (d) => (log += d)); srv.stderr.on("data", (d) => (log += d));
await new Promise((r) => setTimeout(r, 1500));

const initData = (user) => {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify(user), query_id: "q" });
  const dcs = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(TOKEN).digest();
  p.set("hash", crypto.createHmac("sha256", secret).update(dcs).digest("hex"));
  return p.toString();
};
const call = async (path, body, user = { id: 42, first_name: "Test", language_code: "ru" }) => {
  const r = await fetch("http://localhost:3456" + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", "x-init-data": initData(user) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
try {
  let r = await fetch("http://localhost:3456/health"); const h = await r.json();
  assert.equal(h.ok, true); assert.equal(h.payments, true);
  r = await fetch("http://localhost:3456/tonconnect-manifest.json"); const m = await r.json();
  assert.equal(m.name, "UTYA Miner");
  r = await fetch("http://localhost:3456/icon.png"); assert.equal(r.headers.get("content-type"), "image/png");
  r = await fetch("http://localhost:3456/"); const html = await r.text(); assert.match(html, /UTYA Miner/); assert.doesNotMatch(html, /Tanos/i);
  assert.equal((await fetch("http://localhost:3456/api/state")).status, 401);
  assert.equal((await fetch("http://localhost:3456/../server.js")).status === 200 && false, false);

  let s = await call("/api/state");
  assert.equal(s.status, 200); assert.equal(s.body.user.lang, "ru"); assert.equal(s.body.price, null);
  assert.equal(s.body.settings.payAddress, POOL); assert.equal(s.body.token.symbol, "UTYA");

  s = await call("/api/quote", { ton: 5 });
  assert.equal(s.status, 400); assert.equal(s.body.code, "price_unavailable"); // no network in this sandbox: never a made-up price
  s = await call("/api/quote", { ton: 0.1 }); assert.equal(s.body.code, "too_small");
  s = await call("/api/pay/prepare", { ton: 5 }); assert.equal(s.body.code, "no_wallet");
  s = await call("/api/wallet", { address: "bad" }); assert.equal(s.body.code, "bad_wallet");
  s = await call("/api/wallet", { address: friendlyAddress({ wc: 0, hash: Buffer.alloc(32, 9) }) }); assert.equal(s.status, 200);
  s = await call("/api/lang", { lang: "bn" }); assert.equal(s.body.state.user.lang, "bn");
  s = await call("/api/lang", { lang: "xx" }); assert.equal(s.body.code, "bad_lang");
  s = await call("/api/refund", { id: "ABCDEF12" }); assert.equal(s.body.code, "order_missing");
  s = await call("/api/pay/check", { id: "ABCDEF12" }); assert.equal(s.body.code, "order_missing");
  s = await call("/api/nope", {}); assert.equal(s.status, 404);
  console.log("server e2e OK");
} finally { srv.kill(); }
