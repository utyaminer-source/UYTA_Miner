import { BRAND, NFT, TOKEN } from "./config.js";
import * as game from "./game.js";
import { T } from "./messages.js";

const fmt = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = game.escapeHtml;
const when = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "-");

const USER_COMMANDS = ["/start — open UTYA Miner", "/balance — your mined balance", "/help — how it works", "/myid — show your Telegram ID"];

const ADMIN_HELP = [
  "🛠 <b>Admin commands</b>",
  "",
  "<b>Orders (every buyer pays TON, you send the UTYA by hand)</b>",
  "/clearorders — shows what would be deleted: ALL old orders (customers of still-open orders get a \"your order was cancelled\" message)",
  "/clearorders yes — really deletes them (orders that still wait for UTYA or a refund are kept)",
  "/clearorders yes all — deletes those too (only when you already handled them!)",
  "/orders (or /pending) — paid orders waiting for your UTYA, each with a ✅ button",
  "/delivered &lt;id&gt; [tx hash] — you sent the UTYA (same as the button)",
  "/refunds — refund requests of buyers",
  "/refunded &lt;id&gt; [tx hash] — you sent the TON back (also works for a paid order the buyer did not ask about)",
  "/order &lt;id&gt; — show one order",
  "/payments — orders still waiting for the blockchain",
  "/confirmpay &lt;id&gt; (or /confirmdeposit) — confirm one by hand when you saw the transfer in your wallet",
  "",
  "<b>Mining and withdrawals (the mined UTYA is paid by you, from your wallet, by hand)</b>",
  "/withdrawals (or /wd) — withdrawal requests waiting for you, each with ✅ / ❌ buttons",
  "/wsent &lt;id&gt; [tx hash] — you sent the UTYA (same as the ✅ button)",
  "/wreject &lt;id&gt; [reason] — refuse; the UTYA goes back to the user's mined balance",
  "/setminerate &lt;UTYA per hour&gt; — mining speed for new sessions",
  "/setminwithdraw &lt;UTYA&gt; — smallest withdrawal",
  "/setrefbonus &lt;UTYA&gt; — bonus the inviter gets for every friend who connects a wallet (0 = none, first value 5)",
  "/mineon · /mineoff — open / pause starting new mining sessions",
  "/withdrawon · /withdrawoff — open / pause withdrawal requests",
  "",
  "<b>NFT ducks (mining boost)</b>",
  "/nfts — the NFT list with ids, boosts and drop chances (change them in src/config.js)",
  "/setnftprice &lt;TON&gt; — price of one mystery NFT (first value 5)",
  "/givenft &lt;telegramId&gt; &lt;nftId&gt; [number] — give an NFT for free (a negative number takes it away)",
  "/nfton · /nftoff — open / close the NFT shop",
  "",
  "<b>Selling settings</b>",
  "/price — the live price and a sample quote",
  "/buyon · /buyoff — open / pause buying",
  "/setmin &lt;TON&gt; · /setmax &lt;TON&gt; — smallest / largest order",
  "/setfee &lt;percent&gt; — service fee (0 to 20). It is shown to buyers before they pay",
  "/setdelivery &lt;hours&gt; — the delivery time the app promises",
  "/settings — every setting in one list",
  "",
  "<b>Stats and players</b>",
  "/stats — users, orders, TON received",
  "/totalusers — total / today / last 7 days",
  "/user &lt;telegramId&gt; — show a player and his last orders",
  "/ban &lt;telegramId&gt; [reason] · /unban &lt;telegramId&gt;",
  "",
  "<b>Channel join popup</b>",
  "/channeljoinpopupshow &lt;@channel or https://t.me/channel&gt; — players must join it (use again to add more)",
  "/channeljoinlist — required channels",
  "/channeljoinremove &lt;number&gt; — remove one",
  "/noneedchanneljoin — turn the join popup OFF (/channeljoinon to turn it back ON)",
  "",
  "<b>Messages</b>",
  "/broadcast &lt;text&gt; (or /announcement) — message every player",
  "/setwelcome &lt;text&gt; — custom /start message (/setwelcome reset to go back)",
  "/setsupportusername &lt;@username or link&gt; (or /setsupport) — Support button in the app (off to hide)",
  "",
  "<b>Owner only (IDs in ADMIN_IDS)</b>",
  "/setdepositaddress &lt;TON address&gt; — wallet that receives all payments",
  "/addadmin &lt;telegramId&gt; · /removeadmin &lt;telegramId&gt; · /admins",
].join("\n");

const helpFor = (lang, admin, hours) => {
  const base = `${esc(T(lang, "help", { symbol: TOKEN.symbol, hours }))}\n\n${esc(USER_COMMANDS.join("\n"))}`;
  return admin ? `${base}\n\n${ADMIN_HELP}` : base;
};

const ALIASES = {
  "/commands": "/help",
  "/admin": "/help",
  "/pending": "/orders",
  "/confirmdeposit": "/confirmpay",
  "/setcontact": "/setsupport",
  "/setsupportusername": "/setsupport",
  "/announcement": "/broadcast",
  "/wd": "/withdrawals",
};
const OWNER_ONLY = new Set(["/setdepositaddress", "/addadmin", "/removeadmin"]);

export function createBot({ token, username, publicUrl, adminIds, webhookSecret, pay, extraChannels = [] }) {
  const api = `https://api.telegram.org/bot${token}`;

  async function tg(method, body = {}) {
    try {
      const res = await fetch(`${api}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!data.ok) {
        console.error(`[bot] ${method} failed:`, data.description);
        return null;
      }
      return data.result;
    } catch (err) {
      console.error(`[bot] ${method} error:`, err.message);
      return null;
    }
  }

  const send = (chatId, text, extra = {}) => tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
  const openButton = (lang) => ({ inline_keyboard: [[{ text: T(lang, "btn.open"), web_app: { url: publicUrl } }]] });

  // ---- hooks used by the game
  game.hooks.notify = async (userId, text) => {
    const u = await game.getUser(userId);
    await send(userId, esc(text), { reply_markup: openButton(u?.lang ?? "en") });
  };
  const allAdminIds = async () => [...new Set([...adminIds, ...(await game.getSettings()).admins])];
  game.hooks.notifyAdmins = async (text, buttons) => {
    for (const id of await allAdminIds()) await send(id, text, buttons ? { reply_markup: { inline_keyboard: buttons } } : {});
  };
  game.hooks.checkMember = async (chat, userId) => {
    const m = await tg("getChatMember", { chat_id: chat, user_id: userId });
    if (!m) return null;
    if (["creator", "administrator", "member"].includes(m.status)) return true;
    if (m.status === "restricted") return Boolean(m.is_member);
    return false;
  };
  game.hooks.botUsername = String(username ?? "").replace(/^@/, "");

  async function welcome(chatId, u) {
    const settings = await game.getSettings();
    const lang = u.lang ?? "en";
    const text = settings.welcome
      ? esc(settings.welcome)
      : [`<b>${esc(T(lang, "welcome.title", { name: u.name }))}</b>`, "", esc(T(lang, "welcome.body", { symbol: TOKEN.symbol }))].join("\n");
    await send(chatId, `${text}\n\n${esc(T(lang, BRAND.official ? "welcome.official" : "welcome.unofficial"))}\n\n${esc(T(lang, "welcome.cta"))}`, { reply_markup: openButton(lang) });
  }

  const isOwner = (id) => adminIds.includes(id);
  const isAdmin = async (id) => isOwner(id) || (await game.getSettings()).admins.includes(id);

  // Telegram channel name from "@name", "t.me/name" or "https://t.me/name"
  const channelName = (raw) => {
    const m = /^(?:https?:\/\/)?(?:t\.me\/|telegram\.me\/)?@?([A-Za-z][A-Za-z0-9_]{4,31})\/?$/.exec(raw.trim());
    return m ? `@${m[1]}` : null;
  };

  const orderCard = async (o) => {
    const u = await game.getUser(o.userId);
    return [
      `📦 <b>Order ${esc(o.id)}</b> · ${esc(o.status)}`,
      `${esc(u?.name ?? o.userId)} (<code>${o.userId}</code>)${u?.username ? " @" + esc(u.username) : ""}`,
      `${o.ton} TON → <b>${fmt(o.utya)} ${TOKEN.symbol}</b>${o.requoted ? " (re-quoted, paid late)" : ""}`,
      `Wallet: <code>${esc(o.wallet)}</code>`,
      `Created ${when(o.createdAt)}${o.paidAt ? " · paid " + when(o.paidAt) : ""}`,
    ].join("\n");
  };

  const withdrawCard = async (w) => {
    const u = await game.getUser(w.userId);
    return [
      `⛏️ <b>Withdrawal ${esc(w.id)}</b> · ${esc(w.status)}`,
      `${esc(u?.name ?? w.userId)} (<code>${w.userId}</code>)${u?.username ? " @" + esc(u.username) : ""}`,
      `<b>${fmt(w.amount)} ${TOKEN.symbol}</b>`,
      `Wallet: <code>${esc(w.wallet)}</code>`,
      `Requested ${when(w.createdAt)}${w.doneAt ? " · closed " + when(w.doneAt) : ""}`,
    ].join("\n");
  };

  async function adminCommand(msg, cmdRaw, arg) {
    const chatId = msg.chat.id;
    const cmd = ALIASES[cmdRaw] ?? cmdRaw;
    const fail = (err) => send(chatId, esc(err.message));
    const reply = (t) => send(chatId, t);

    if (OWNER_ONLY.has(cmd) && !isOwner(msg.from.id)) return reply("⛔ Only the owner (the IDs in ADMIN_IDS) can use this command.");

    // ---------- orders
    if (cmd === "/clearorders") {
      const [sure, which] = arg.toLowerCase().split(/\s+/);
      const all = which === "all";
      const prev = await game.clearOrders({ all, dryRun: true });
      if (sure !== "yes") {
        return reply(
          [
            `🗑 <b>Delete old orders</b>`,
            `Orders in total: <b>${prev.total}</b>`,
            `Would be deleted: <b>${prev.deleted}</b>`,
            `Customers who get a "your order was cancelled" message: <b>${prev.told}</b>`,
            prev.kept.length ? `Kept (they still wait for UTYA or a refund): <b>${prev.kept.length}</b> — ${prev.kept.slice(0, 15).map((o) => `<code>${esc(o.id)}</code>`).join(" ")}` : "Nothing is kept.",
            "",
            "To do it send: <code>/clearorders yes</code>",
            prev.kept.length ? "To delete the kept ones too: <code>/clearorders yes all</code> (a customer who paid and did not get the UTYA yet would lose his order!)" : "",
          ].filter(Boolean).join("\n"),
        );
      }
      await reply(`Deleting ${prev.deleted} orders and telling ${prev.told} customers... one moment.`);
      const r = await game.clearOrders({ all });
      return reply(`✅ Deleted <b>${r.deleted}</b> orders. Messages sent: <b>${r.told}</b>. Kept: <b>${r.kept.length}</b>.`);
    }
    if (cmd === "/orders") {
      const s = await game.adminStats();
      if (!s.awaiting.length) return reply("No paid order is waiting. 🎉");
      for (const o of s.awaiting) await send(chatId, `${await orderCard(o)}\n\nSend <b>${fmt(o.utya)} ${TOKEN.symbol}</b> to the wallet above, then tap the button.`, { reply_markup: { inline_keyboard: [[{ text: "✅ I sent the UTYA", callback_data: `od:ok:${o.id}` }]] } });
      return;
    }
    if (cmd === "/delivered" || cmd === "/refunded") {
      const [id, ...rest] = arg.split(/\s+/);
      if (!id) return reply(`Usage: ${cmd} &lt;order id&gt; [tx hash]`);
      try {
        const o = cmd === "/delivered" ? await game.markDelivered(id, msg.from.id, rest.join(" ")) : await game.markRefunded(id, msg.from.id, rest.join(" "));
        return reply(`Order ${esc(o.id)} is now <b>${o.status}</b> ✅ The buyer was told.`);
      } catch (err) {
        return fail(err);
      }
    }
    if (cmd === "/refunds") {
      const s = await game.adminStats();
      if (!s.refunds.length) return reply("No refund request is waiting. 🎉");
      for (const o of s.refunds) await send(chatId, `${await orderCard(o)}\n\nSend back <b>${o.ton} TON</b> to the wallet above, then: <code>/refunded ${o.id}</code>`);
      return;
    }
    if (cmd === "/order") {
      const o = await game.getOrder(arg.trim());
      if (!o) return reply("Order not found.");
      return reply(`${await orderCard(o)}${o.txHash ? `\nPayment tx: <code>${esc(o.txHash)}</code>` : ""}${o.deliveryTx ? `\nDelivery tx: <code>${esc(o.deliveryTx)}</code>` : ""}${o.refundTx ? `\nRefund tx: <code>${esc(o.refundTx)}</code>` : ""}`);
    }
    if (cmd === "/payments") {
      const s = await game.adminStats();
      if (!s.unpaid.length) return reply("No order is waiting for a payment. 🎉");
      return reply(s.unpaid.map((o) => `<code>${esc(o.id)}</code> · ${o.ton} TON · user <code>${o.userId}</code> · ${o.status} · ${when(o.createdAt)}`).join("\n") + "\n\n/confirmpay &lt;id&gt; if you saw the transfer in your wallet.");
    }
    if (cmd === "/confirmpay") {
      if (!pay) return reply("Payments are not set up.");
      try {
        const o = await pay.confirmManually(arg.trim(), msg.from.id);
        return reply(`Order <code>${esc(o.id)}</code> (${o.ton} TON) confirmed ✅`);
      } catch (err) {
        return fail(err);
      }
    }

    // ---------- mining and withdrawals
    if (cmd === "/withdrawals") {
      const s = await game.adminStats();
      if (!s.withdrawals.length) return reply("No withdrawal is waiting. 🎉");
      for (const w of s.withdrawals) await send(chatId, `${await withdrawCard(w)}\n\nSend <b>${fmt(w.amount)} ${TOKEN.symbol}</b> to the wallet above, then tap ✅.`, { reply_markup: { inline_keyboard: [[{ text: "✅ I sent the UTYA", callback_data: `wd:ok:${w.id}` }, { text: "❌ Reject", callback_data: `wd:no:${w.id}` }]] } });
      return;
    }
    if (cmd === "/wsent" || cmd === "/wreject") {
      const [id, ...rest] = arg.split(/\s+/);
      if (!id) return reply(`Usage: ${cmd} &lt;withdrawal id&gt; ${cmd === "/wsent" ? "[tx hash]" : "[reason]"}`);
      try {
        const w = cmd === "/wsent" ? await game.markWithdrawSent(id, msg.from.id, rest.join(" ")) : await game.rejectWithdraw(id, msg.from.id, rest.join(" "));
        return reply(`Withdrawal ${esc(w.id)} is now <b>${w.status}</b> ✅ The user was told.`);
      } catch (err) {
        return fail(err);
      }
    }
    if (cmd === "/setminerate" || cmd === "/setminwithdraw") {
      const n = Number(arg.replace(",", "."));
      if (!Number.isFinite(n) || n <= 0 || n > 1e9) return reply(cmd === "/setminerate" ? "Usage: /setminerate &lt;UTYA per hour&gt; (for example /setminerate 0.5)" : "Usage: /setminwithdraw &lt;UTYA&gt; (for example /setminwithdraw 100)");
      await game.updateSettings(cmd === "/setminerate" ? { mineRate: n } : { minWithdraw: n });
      return reply(cmd === "/setminerate" ? `Mining speed is now <b>${n} ${TOKEN.symbol} per hour</b>. Sessions that already run keep their old speed.` : `The smallest withdrawal is now <b>${n} ${TOKEN.symbol}</b>.`);
    }
    if (cmd === "/setrefbonus") {
      const n = Number(arg.replace(",", "."));
      if (!Number.isFinite(n) || n < 0 || n > 1e6) return reply("Usage: /setrefbonus &lt;UTYA&gt; (for example /setrefbonus 5, or 0 to stop paying)");
      await game.updateSettings({ refBonus: n });
      return reply(`The referral bonus is now <b>${n} ${TOKEN.symbol}</b> for every friend who connects a wallet.`);
    }
    // ---------- NFT
    if (cmd === "/nfts") {
      const st = await game.getSettings();
      const total = NFT.items.reduce((x, n) => x + n.weight, 0);
      return reply(["🦆 <b>NFT ducks</b>", `Price: <b>${st.nftPrice} TON</b> · supply ${NFT.supply} · max ${NFT.maxPerUser} per player`, ...NFT.items.map((n) => `<code>${esc(n.id)}</code> · ${esc(n.name)} · ${n.rarity} · +${n.boostPct}% · chance ${Math.round((n.weight / total) * 1000) / 10}%`)].join("\n"));
    }
    if (cmd === "/setnftprice") {
      const n = Number(arg);
      if (!Number.isFinite(n) || n < 0.1 || n > 100000) return reply("Usage: /setnftprice &lt;TON&gt; (for example /setnftprice 5)");
      await game.updateSettings({ nftPrice: n });
      return reply(`One mystery NFT now costs <b>${n} TON</b>. Orders that are already open keep their old price.`);
    }
    if (cmd === "/givenft") {
      const [idText, nftId, num] = arg.split(/\s+/);
      if (!Number(idText) || !nftId) return reply(`Usage: /givenft &lt;telegramId&gt; &lt;nftId&gt; [number]\nNFT ids: ${esc(NFT.items.map((n) => n.id).join(", "))}`);
      try {
        const r = await game.adminGiveNft(Number(idText), nftId, num === undefined ? 1 : Number(num));
        return reply(`✅ ${esc(r.item.name)}: the player now has <b>${r.count}</b>. His NFT boost: <b>+${r.boostPct}%</b>.`);
      } catch (err) {
        return fail(err);
      }
    }
    if (cmd === "/nfton" || cmd === "/nftoff") {
      await game.updateSettings({ nftOpen: cmd === "/nfton" });
      return reply(cmd === "/nfton" ? "NFT shop is OPEN ✅" : "NFT shop is CLOSED ⏸ (what players own keeps boosting)");
    }
    if (cmd === "/mineon" || cmd === "/mineoff") {
      await game.updateSettings({ mineOpen: cmd === "/mineon" });
      return reply(cmd === "/mineon" ? "Mining is OPEN ✅" : "New mining sessions are PAUSED ⏸ (running sessions can still be claimed)");
    }
    if (cmd === "/withdrawon" || cmd === "/withdrawoff") {
      await game.updateSettings({ withdrawOpen: cmd === "/withdrawon" });
      return reply(cmd === "/withdrawon" ? "Withdrawal requests are OPEN ✅" : "Withdrawal requests are PAUSED ⏸ (requests already made are still handled)");
    }

    // ---------- selling settings
    if (cmd === "/price") {
      const price = await game.runtime.price?.get().catch(() => null);
      if (!price) return reply("⚠️ No live price right now (every source failed). Buying is paused until a price is available.");
      const s = await game.getSettings();
      const q = game.computeQuote(1, price, s.feePct);
      return reply(
        [
          "📈 <b>Live price</b>",
          `1 ${TOKEN.symbol} = $${price.utyaUsd}`,
          `1 TON = $${price.tonUsd}`,
          `Sample: 1 TON → <b>${fmt(q.utya)} ${TOKEN.symbol}</b> (fee ${s.feePct}%)`,
          `Sources: ${esc(price.sources.join(", "))} · ${Math.round((Date.now() - price.at) / 1000)}s ago`,
        ].join("\n"),
      );
    }
    if (cmd === "/buyon" || cmd === "/buyoff") {
      await game.updateSettings({ buyOpen: cmd === "/buyon" });
      return reply(cmd === "/buyon" ? "Buying is OPEN ✅" : "Buying is PAUSED ⏸ (orders already paid are still handled)");
    }
    if (cmd === "/setmin" || cmd === "/setmax") {
      const n = Number(arg.replace(",", "."));
      const st = await game.getSettings();
      if (!Number.isFinite(n) || n <= 0) return reply(`Usage: ${cmd} &lt;TON&gt;`);
      if (cmd === "/setmin" && n > st.maxTon) return reply(`The minimum can not be above the maximum (${st.maxTon} TON).`);
      if (cmd === "/setmax" && n < st.minTon) return reply(`The maximum can not be below the minimum (${st.minTon} TON).`);
      await game.updateSettings(cmd === "/setmin" ? { minTon: n } : { maxTon: n });
      return reply(`${cmd === "/setmin" ? "Minimum" : "Maximum"} order is now <b>${n} TON</b>.`);
    }
    if (cmd === "/setfee") {
      const n = Number(arg.replace(",", "."));
      if (!Number.isFinite(n) || n < 0 || n > 20) return reply("Usage: /setfee &lt;percent 0-20&gt; (for example /setfee 2)");
      await game.updateSettings({ feePct: n });
      return reply(`Service fee is now <b>${n}%</b>. Buyers see it before they pay. An order that was already started keeps its old quote.`);
    }
    if (cmd === "/setdelivery") {
      const n = Number(arg);
      if (!Number.isFinite(n) || n < 1 || n > 168) return reply("Usage: /setdelivery &lt;hours 1-168&gt;");
      await game.updateSettings({ deliveryHours: Math.round(n) });
      return reply(`The app now promises delivery within <b>${Math.round(n)} hours</b>.`);
    }
    if (cmd === "/settings") {
      const st = await game.getSettings();
      const addr = await game.getDepositAddress();
      const chans = [...new Set([...(extraChannels ?? []), ...st.channels])];
      return reply(
        [
          "⚙️ <b>Settings</b>",
          `Buying: <b>${st.buyOpen ? "open" : "paused"}</b> · min ${st.minTon} TON · max ${st.maxTon} TON`,
          `Service fee: <b>${st.feePct}%</b> · delivery promise: <b>${st.deliveryHours} h</b>`,
          `Mining: <b>${st.mineOpen ? "open" : "paused"}</b> · <b>${st.mineRate} ${TOKEN.symbol}/h</b> · withdrawals: <b>${st.withdrawOpen ? "open" : "paused"}</b> · min ${st.minWithdraw} ${TOKEN.symbol} · referral bonus: <b>${st.refBonus} ${TOKEN.symbol}</b>`,
          `NFT shop: <b>${st.nftOpen ? "open" : "closed"}</b> · <b>${st.nftPrice} TON</b> each · ${NFT.items.length} NFT types (/nfts)`,
          `Payment wallet: ${addr ? `<code>${esc(addr)}</code>` : "<b>not set</b> (/setdepositaddress)"}`,
          `Support button: ${st.support ? esc(st.support) : "hidden"}`,
          `Welcome message: ${st.welcome ? "custom" : "default"}`,
          `Channel join popup: <b>${st.joinEnabled ? "ON" : "OFF"}</b> · ${chans.length} channel(s)`,
          `Extra admins: ${st.admins.length}`,
        ].join("\n"),
      );
    }

    // ---------- channel join popup
    if (cmd === "/channeljoinpopupshow") {
      const name = channelName(arg);
      if (!name) return reply("Usage: /channeljoinpopupshow &lt;@channel or https://t.me/channel&gt;\nOnly public channels work. Make the bot an <b>admin</b> of it.");
      const st = await game.getSettings();
      await game.updateSettings({ channels: st.channels.includes(name) ? st.channels : [...st.channels, name], joinEnabled: true });
      return reply(`✅ Players must join ${esc(name)}.\n⚠️ The bot must be an <b>admin</b> of that channel, otherwise the check cannot work.`);
    }
    if (cmd === "/channeljoinlist") {
      const st = await game.getSettings();
      const rows = [...(extraChannels ?? []).map((c) => `${c} (from FORCE_CHANNELS)`), ...st.channels.map((c, i) => `${i + 1}. ${c}`)];
      return reply(`Channel join popup: <b>${st.joinEnabled ? "ON" : "OFF"}</b>\n\n${rows.length ? esc(rows.join("\n")) : "No channel added. Use /channeljoinpopupshow"}`);
    }
    if (cmd === "/channeljoinremove") {
      const st = await game.getSettings();
      const n = Number(arg);
      if (!Number.isInteger(n) || n < 1 || n > st.channels.length) return reply("Usage: /channeljoinremove &lt;number&gt; (see /channeljoinlist)");
      const [gone] = st.channels.splice(n - 1, 1);
      await game.updateSettings({ channels: st.channels });
      return reply(`Removed ${esc(gone)}.`);
    }
    if (cmd === "/noneedchanneljoin" || cmd === "/channeljoinon") {
      const on = cmd === "/channeljoinon";
      await game.updateSettings({ joinEnabled: on });
      return reply(on ? "Channel join popup is ON ✅" : "Channel join popup is OFF. Players can use the app without joining.");
    }

    // ---------- admins and wallet
    if (cmd === "/admins") {
      const st = await game.getSettings();
      return reply([`👑 <b>Owner(s)</b>: ${adminIds.map((i) => `<code>${i}</code>`).join(", ") || "-"}`, `🛡 <b>Admins</b>: ${st.admins.map((i) => `<code>${i}</code>`).join(", ") || "none"}`].join("\n"));
    }
    if (cmd === "/addadmin" || cmd === "/removeadmin") {
      const id = Number(arg);
      if (!Number.isInteger(id) || id <= 0) return reply(`Usage: ${cmd} &lt;telegramId&gt;`);
      const st = await game.getSettings();
      if (cmd === "/addadmin") {
        if (isOwner(id) || st.admins.includes(id)) return reply("That ID is already an admin.");
        await game.updateSettings({ admins: [...st.admins, id] });
        return reply(`✅ <code>${id}</code> is now an admin. The person must press /start in this bot to receive messages.`);
      }
      if (isOwner(id)) return reply("The owner cannot be removed here (change ADMIN_IDS).");
      if (!st.admins.includes(id)) return reply("That ID is not an admin.");
      await game.updateSettings({ admins: st.admins.filter((a) => a !== id) });
      return reply(`Admin <code>${id}</code> removed.`);
    }
    if (cmd === "/setdepositaddress") {
      const { normalizeWallet } = await import("./ton.js");
      const addr = normalizeWallet(arg);
      if (!addr) return reply("Usage: /setdepositaddress &lt;TON address&gt;\nThat is not a valid TON address.");
      await game.updateSettings({ depositAddress: addr });
      return reply(`✅ Payments now go to:\n<code>${esc(addr)}</code>\nMake a small test order yourself before you open the bot to buyers. Use a wallet you control.`);
    }

    // ---------- stats and players
    if (cmd === "/stats") {
      const s = await game.adminStats();
      return reply(
        [
          `📊 <b>${esc(BRAND.name)} stats</b>`,
          `Users: <b>${fmt(s.users)}</b>`,
          `Waiting for your UTYA: <b>${s.awaiting.length}</b> · refund requests: <b>${s.refunds.length}</b> · unpaid: <b>${s.unpaid.length}</b>`,
          `TON received: <b>${s.receivedTon.toFixed(2)}</b> · refunded: <b>${s.refundedTon.toFixed(2)}</b>`,
          `${TOKEN.symbol} delivered: <b>${fmt(s.deliveredUtya)}</b>`,
          `🦆 NFTs sold: <b>${fmt(s.nftSold)}</b> / ${NFT.supply}`,
          `⛏️ Mined (claimed by users): <b>${fmt(s.minedUtya)} ${TOKEN.symbol}</b> · withdrawn: <b>${fmt(s.withdrawnUtya)}</b> · referral bonuses paid: <b>${fmt(s.bonusUtya)}</b> · withdrawals waiting: <b>${s.withdrawals.length}</b>`,
        ].join("\n"),
      );
    }
    if (cmd === "/totalusers") {
      const c = await game.userCounts();
      return reply(["👥 <b>Users</b>", `Total: <b>${fmt(c.total)}</b>`, `Today (UTC): <b>${fmt(c.today)}</b>`, `Last 7 days: <b>${fmt(c.week)}</b>`].join("\n"));
    }
    if (cmd === "/user") {
      try {
        const u = await game.userInfo(Number(arg));
        return reply(
          [
            `👤 <b>${esc(u.name)}</b> (<code>${u.id}</code>)${u.username ? " @" + esc(u.username) : ""}`,
            `Wallet: <code>${esc(u.wallet || "-")}</code>`,
            `Language: ${u.lang} · Banned: ${u.banned ? "yes — " + esc(u.banReason || "no reason saved") : "no"}`,
            `Joined: ${new Date(u.createdAt).toISOString().slice(0, 10)}`,
            `⛏️ Mined balance: <b>${fmt(u.mining.balance)} ${TOKEN.symbol}</b> · mined in total ${fmt(u.mining.total)} · withdrawn ${fmt(u.mining.withdrawn)}`,
            `🦆 NFTs: ${Object.keys(u.nfts).length ? esc(Object.entries(u.nfts).map(([k, n]) => `${k} x${n}`).join(", ")) + ` · boost <b>+${u.nftBoostPct}%</b>` : "none"}`,
            ...(u.withdrawals.length ? ["<b>Last withdrawals</b>", ...u.withdrawals.map((w) => `<code>${esc(w.id)}</code> · ${fmt(w.amount)} ${TOKEN.symbol} · ${w.status}`)] : []),
            ...(u.orders.length ? ["", "<b>Last orders</b>", ...u.orders.map((o) => `<code>${esc(o.id)}</code> · ${o.ton} TON → ${fmt(o.utya)} ${TOKEN.symbol} · ${o.status}`)] : ["No orders."]),
          ].join("\n"),
        );
      } catch (err) {
        return fail(err);
      }
    }
    if (cmd === "/ban" || cmd === "/unban") {
      const [idText, ...why] = arg.split(/\s+/);
      const id = Number(idText);
      if (!Number.isInteger(id)) return reply(cmd === "/ban" ? "Usage: /ban &lt;telegramId&gt; [reason]" : "Usage: /unban &lt;telegramId&gt;");
      try {
        const u = await game.setBanned(id, cmd === "/ban", why.join(" ") || "Banned by an admin");
        return reply(`${esc(u.name)} (<code>${u.id}</code>) is now ${u.banned ? "banned 🚫" : "unbanned ✅"}.`);
      } catch (err) {
        return fail(err);
      }
    }

    // ---------- messages
    if (cmd === "/setsupport") {
      if (arg.toLowerCase() === "off") {
        await game.updateSettings({ support: "" });
        return reply("Support button hidden.");
      }
      const m = /^(?:https?:\/\/)?(?:t\.me\/|telegram\.me\/)?@?([A-Za-z][A-Za-z0-9_]{4,31})\/?$/.exec(arg.trim());
      const url = m ? `https://t.me/${m[1]}` : /^https:\/\/\S+$/.test(arg.trim()) ? arg.trim() : null;
      if (!url) return reply("Usage: /setsupportusername &lt;@username or link&gt;\nExamples: /setsupportusername @myname · /setsupportusername https://t.me/myname · /setsupportusername off");
      await game.updateSettings({ support: url });
      return reply(`Support contact saved ✅\n${esc(url)}`);
    }
    if (cmd === "/setwelcome") {
      if (!arg) return reply("Usage: /setwelcome &lt;text&gt; (or /setwelcome reset)");
      await game.updateSettings({ welcome: arg.toLowerCase() === "reset" ? "" : arg });
      return reply(arg.toLowerCase() === "reset" ? "Welcome message reset to the default." : "Welcome message saved ✅");
    }
    if (cmd === "/broadcast") {
      if (!arg) return reply("Usage: /broadcast &lt;text&gt;");
      const ids = await game.allUserIds();
      await reply(`Sending to ${ids.length} users…`);
      let ok = 0;
      for (const id of ids) {
        const u = await game.getUser(id);
        const r = await send(id, esc(arg), { reply_markup: openButton(u?.lang ?? "en") });
        if (r) ok += 1;
        await sleep(50); // stay under Telegram limits (about 30 messages per second)
      }
      return reply(`Broadcast finished: ${ok}/${ids.length} delivered.`);
    }
    return false;
  }

  async function handleMessage(msg) {
    if (!msg.from || msg.chat.type !== "private") return;
    const text = (msg.text ?? "").trim();
    const m = /^(\/[A-Za-z_]+)(?:@\w+)?(?:\s+([\s\S]+))?$/.exec(text);
    const cmd = m?.[1]?.toLowerCase();
    const arg = (m?.[2] ?? "").trim();

    // t.me/BOT?start=ref_123 : the friend who brought this new user (only counted for a new account, see game.ensureUser)
    const refMatch = cmd === "/start" ? /^ref_(\d{3,15})$/.exec(arg) : null;
    const u = await game.ensureUser(msg.from, refMatch ? { ref: Number(refMatch[1]) } : {});
    if (u.banned) return send(msg.chat.id, esc(T(u.lang, "banned")));

    if (cmd === "/start") return welcome(msg.chat.id, u);
    if (cmd === "/myid") {
      const admin = await isAdmin(msg.from.id);
      return send(msg.chat.id, `Your Telegram ID: <code>${msg.from.id}</code>\nAdmin: <b>${admin ? (isOwner(msg.from.id) ? "yes (owner)" : "yes") : "no"}</b>`);
    }
    if (cmd === "/balance") {
      const st = await game.stateFor(msg.from.id);
      const waiting = st.withdrawals.filter((w) => w.status === "pending").length;
      return send(msg.chat.id, esc(T(u.lang, "balance", { balance: fmt(st.mining.balance), total: fmt(st.mining.total), withdrawn: fmt(st.mining.withdrawn), waiting, symbol: TOKEN.symbol })), { reply_markup: openButton(u.lang) });
    }
    const admin = cmd ? await isAdmin(msg.from.id) : false;
    if (cmd === "/help" || cmd === "/commands" || (cmd === "/admin" && admin)) {
      const st = await game.getSettings();
      return send(msg.chat.id, helpFor(u.lang ?? "en", admin, st.deliveryHours), { reply_markup: openButton(u.lang ?? "en") });
    }
    if (cmd && admin) {
      const handled = await adminCommand(msg, cmd, arg);
      if (handled !== false) return;
    }
    return send(msg.chat.id, esc(T(u.lang, "open.hint")), { reply_markup: openButton(u.lang) });
  }

  async function handleCallback(cb) {
    const ub = /^ub:(\d+)$/.exec(cb.data ?? "");
    if (ub && (await isAdmin(cb.from.id))) {
      try {
        const u = await game.setBanned(Number(ub[1]), false);
        await tg("answerCallbackQuery", { callback_query_id: cb.id, text: `${u.name} is unbanned` });
      } catch (err) {
        await tg("answerCallbackQuery", { callback_query_id: cb.id, text: String(err.message).slice(0, 150) });
      }
      return;
    }
    const wd = /^wd:(ok|no):([0-9A-Fa-f]{8})$/.exec(cb.data ?? "");
    if (wd && (await isAdmin(cb.from.id))) {
      try {
        const w = wd[1] === "ok" ? await game.markWithdrawSent(wd[2], cb.from.id) : await game.rejectWithdraw(wd[2], cb.from.id, "Rejected by an admin");
        await tg("answerCallbackQuery", { callback_query_id: cb.id, text: `Withdrawal ${w.id} ${w.status}` });
        if (cb.message) await tg("editMessageReplyMarkup", { chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [[{ text: wd[1] === "ok" ? "✅ Sent" : "❌ Rejected", callback_data: "noop" }]] } });
      } catch (err) {
        await tg("answerCallbackQuery", { callback_query_id: cb.id, text: String(err.message).slice(0, 190), show_alert: true });
      }
      return;
    }
    const m = /^od:ok:([0-9A-Fa-f]{8})$/.exec(cb.data ?? "");
    if (!m || !(await isAdmin(cb.from.id))) return tg("answerCallbackQuery", { callback_query_id: cb.id });
    try {
      const o = await game.markDelivered(m[1], cb.from.id);
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: `Order ${o.id} delivered` });
      if (cb.message) await tg("editMessageReplyMarkup", { chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [[{ text: "✅ Delivered", callback_data: "noop" }]] } });
    } catch (err) {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: String(err.message).slice(0, 190), show_alert: true });
    }
  }

  async function handleUpdate(update) {
    try {
      if (update.message) await handleMessage(update.message);
      else if (update.callback_query) await handleCallback(update.callback_query);
    } catch (err) {
      console.error("[bot] update failed:", err);
    }
  }

  async function setup() {
    if (!publicUrl) {
      console.warn("[bot] PUBLIC_URL is not set: webhook and menu button were not configured.");
      return;
    }
    await tg("setWebhook", { url: `${publicUrl}/bot`, secret_token: webhookSecret, allowed_updates: ["message", "callback_query"], drop_pending_updates: false });
    await tg("setChatMenuButton", { menu_button: { type: "web_app", text: "🦆 Open", web_app: { url: publicUrl } } });
    await tg("setMyCommands", { commands: [{ command: "start", description: "Open UTYA Miner" }, { command: "balance", description: "My mined balance" }, { command: "help", description: "How it works" }, { command: "myid", description: "Show my Telegram ID" }] });
    console.log(`[bot] webhook set for @${username}`);
  }

  return { handleUpdate, setup, send, isMember: game.hooks.checkMember };
}
