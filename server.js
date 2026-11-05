import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyInitData } from "./src/auth.js";
import { createBot } from "./src/bot.js";
import { BRAND, MAX_REQUESTS_PER_MINUTE, PAYMENT_SWEEP_MS } from "./src/config.js";
import { openDb } from "./src/db.js";
import * as game from "./src/game.js";
import { iconPng } from "./src/icon.js";
import { createPay } from "./src/pay.js";
import { createPrice } from "./src/price.js";
import { createTonApi } from "./src/ton.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");

const env = process.env;
const BOT_TOKEN = env.BOT_TOKEN ?? "";
const BOT_USERNAME = env.BOT_USERNAME || BRAND.username;
const PUBLIC_URL = (env.PUBLIC_URL ?? "").replace(/\/+$/, "");
// The webhook secret is re-registered with Telegram at every start, so a random one is fine when none is given.
const WEBHOOK_SECRET = env.WEBHOOK_SECRET || crypto.randomBytes(24).toString("hex");
const ADMIN_IDS = (env.ADMIN_IDS ?? "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
const PORT = Number(env.PORT) || 3000;
// Optional: players must join these public channels before they can use the app, for example "@mychannel,@mygroup".
const FORCE_CHANNELS = (env.FORCE_CHANNELS ?? "")
  .split(",")
  .map((c) => c.trim())
  .filter((c) => /^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(c));

const TON_TESTNET = env.TON_TESTNET === "1";
game.runtime.envDepositAddress = (env.TON_DEPOSIT_ADDRESS ?? "").trim();
game.runtime.testnet = TON_TESTNET;

if (!BOT_TOKEN) console.warn("[server] BOT_TOKEN is not set. Nobody can log in until you set it.");
if (!ADMIN_IDS.length) console.warn("[server] ADMIN_IDS is not set. Nobody can use the admin commands.");

const db = await openDb({ mongoUri: env.MONGODB_URI, file: path.join(ROOT, "data", "db.json") });
game.init(db);

const tonApiBase = env.TONAPI_BASE || (TON_TESTNET ? "https://testnet.tonapi.io" : "https://tonapi.io");
const tonApi = createTonApi({ base: tonApiBase, key: env.TONAPI_KEY ?? "" });
// Prices always come from mainnet markets, also when TON_TESTNET is on (a testnet has no market).
game.runtime.price = createPrice({ base: env.TONAPI_BASE_PRICE || "https://tonapi.io", key: env.TONAPI_KEY ?? "" });
const pay = createPay({ tonApi });

const bot = BOT_TOKEN
  ? createBot({ token: BOT_TOKEN, username: BOT_USERNAME, publicUrl: PUBLIC_URL, adminIds: ADMIN_IDS, webhookSecret: WEBHOOK_SECRET, pay, extraChannels: FORCE_CHANNELS })
  : null;

// ------------------------------- http helpers --------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

function json(res, status, body) {
  const data = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(data);
}

function readBody(req, limit = 20_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new game.GameError("Request too large."));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new game.GameError("Bad request."));
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("Not found");
    }
    const ext = path.extname(file);
    res.writeHead(200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": ext === ".html" ? "no-cache" : "public, max-age=3600",
      "x-content-type-options": "nosniff",
    });
    res.end(data);
  });
}

// ------------------------------- channel gate --------------------------------

const joinedUntil = new Map(); // userId -> { until, key }  (key = the channel list that was checked)
const isStaff = async (id) => ADMIN_IDS.includes(id) || (await game.getSettings()).admins.includes(id);

async function missingChannels(userId) {
  if (!bot) return [];
  const settings = await game.getSettings();
  if (!settings.joinEnabled) return []; // /noneedchanneljoin
  const channels = [...new Set([...FORCE_CHANNELS, ...settings.channels])];
  if (!channels.length || (await isStaff(userId))) return [];
  const key = channels.join(",");
  const cached = joinedUntil.get(userId);
  if (cached && cached.key === key && cached.until > Date.now()) return [];
  const missing = [];
  for (const chan of channels) {
    const joined = await game.hooks.checkMember(chan, userId);
    if (joined === false) missing.push(chan);
    if (joined === null) console.warn(`[gate] cannot check ${chan}. Is the bot an admin of that channel?`); // fail open
  }
  if (!missing.length) joinedUntil.set(userId, { until: Date.now() + 5 * 60_000, key });
  return missing;
}

// ------------------------------- rate limit ---------------------------------

const hits = new Map(); // userId -> times of the requests of the last minute
function overLimit(id) {
  const now = Date.now();
  const a = (hits.get(id) ?? []).filter((t) => now - t < 60_000);
  a.push(now);
  hits.set(id, a);
  return a.length > MAX_REQUESTS_PER_MINUTE;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, a] of hits) if (!a.length || now - a[a.length - 1] > 120_000) hits.delete(k);
}, 5 * 60_000).unref();

const bannedBody = async () => ({ error: "Your account is blocked.", code: "banned", support: (await game.getSettings()).support || "" });

// ----------------------------------- API -------------------------------------

async function handleApi(req, res, pathname) {
  const auth = verifyInitData(req.headers["x-init-data"], BOT_TOKEN);
  if (!auth) return json(res, 401, { error: "Please open the app from Telegram." });
  const me = await game.ensureUser(auth.user);
  const id = me.id;
  if (me.banned) return json(res, 403, await bannedBody());
  if (overLimit(id) && !(await isStaff(id))) return json(res, 429, { error: "Too many requests. Please slow down.", code: "slow_down" });
  const missing = await missingChannels(id);
  if (missing.length) {
    return json(res, 403, { error: "Join our channel first.", code: "join_required", channels: missing.map((c) => ({ name: c, url: "https://t.me/" + c.slice(1) })) });
  }
  const body = req.method === "POST" ? await readBody(req) : {};

  switch (pathname) {
    case "/api/state":
      return json(res, 200, await game.stateFor(id));
    case "/api/quote":
      return json(res, 200, { quote: await game.quote(body.ton) });
    case "/api/lang":
      await game.setLang(id, String(body.lang ?? ""));
      return json(res, 200, { state: await game.stateFor(id) });
    case "/api/wallet":
      await game.setWallet(id, body.address);
      return json(res, 200, { state: await game.stateFor(id) });
    case "/api/pay/prepare":
      return json(res, 200, { payment: await pay.prepare(id, body.ton) });
    case "/api/pay/check": {
      const order = await pay.checkOne(id, String(body.id ?? ""));
      return json(res, 200, { order, state: await game.stateFor(id) });
    }
    case "/api/refund":
      await game.requestRefund(id, String(body.id ?? ""));
      return json(res, 200, { state: await game.stateFor(id) });
    default:
      return json(res, 404, { error: "Not found." });
  }
}

// ---------------------------------- server -----------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;
  try {
    if (pathname === "/health") {
      const price = game.runtime.price.peek();
      return json(res, 200, { ok: true, db: db.kind, bot: Boolean(bot), payments: Boolean(await pay.adminAddress()), price: Boolean(price) });
    }

    // TonConnect: wallets read the app name and icon from here
    if (pathname === "/tonconnect-manifest.json") {
      const origin = PUBLIC_URL || `https://${req.headers.host}`;
      return json(res, 200, { url: origin, name: BRAND.name, iconUrl: `${origin}/icon.png` });
    }
    if (pathname === "/icon.png") {
      res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" });
      return res.end(iconPng(180));
    }

    if (pathname === "/bot" && req.method === "POST") {
      if (!bot || req.headers["x-telegram-bot-api-secret-token"] !== WEBHOOK_SECRET) {
        res.writeHead(403);
        return res.end();
      }
      const update = await readBody(req, 200_000);
      res.writeHead(200);
      res.end("ok");
      void bot.handleUpdate(update);
      return;
    }

    if (pathname.startsWith("/api/")) return await handleApi(req, res, pathname);

    if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res, pathname);
    res.writeHead(405);
    res.end();
  } catch (err) {
    if (err instanceof game.GameError) return json(res, 400, { error: err.message, code: err.code, vars: err.vars });
    console.error("[server] error:", err);
    json(res, 500, { error: "Something went wrong. Please try again." });
  }
});

server.listen(PORT, () => {
  console.log(`[server] ${BRAND.name} running on port ${PORT} (db: ${db.kind})`);
  void bot?.setup();
  void game.runtime.price.get(); // warm up the live price
  // Finds payments on the blockchain, also when the buyer already closed the app
  const paySweep = () => pay.sweep().catch((err) => console.error("[pay] sweep failed:", err.message));
  setInterval(paySweep, PAYMENT_SWEEP_MS).unref();
});

process.on("unhandledRejection", (err) => console.error("[server] unhandled rejection:", err));
