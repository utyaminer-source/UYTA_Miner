# UTYA Miner 🦆 (@UTYA_miner_bot)

Telegram Mini App where people **mine UTYA** (and **withdraw** it), **buy UTYA with TON**, and watch a **live price chart**. An admin sends the UTYA from his own wallet to the user's wallet **by hand**, both for purchases and for withdrawals.

> **Independent service (default).** Unless you are the Utya project, this service is not affiliated with it, and the app and the bot say so on the first screen and in the Terms tab. UTYA is a community token (a real jetton on TON, traded on DeDust), its price goes up and down.
>
> **If you ARE the Utya project** (or have its written permission), set `UTYA_OFFICIAL=1`: the app and the bot then say "official service". Never turn it on otherwise: users send real money to this bot and must not be told something untrue.

| | |
|---|---|
| Bot name | UTYA Miner |
| Username | @UTYA_miner_bot |
| Token | Utya (UTYA), TON jetton |
| Contract | `EQBaCgUwOoc6gHCNln_oJzb0mVs79YG7wYoavh-o1ItaneLA` (raw `0:5a0a05303a873a80708d967fe82736f4995b3bf581bbc18a1abe1fa8d48b5a9d`) |

No build step. Node 20+ and one dependency (`mongodb`). The bot **never holds a private key**: it only reads your wallet's incoming transfers. You send the UTYA and the refunds yourself, so no script can move your funds.

## Mining and withdrawals
1. **Mine tab.** The user taps **Start mining**. A session lasts 4 hours (`MINING.sessionHours`). The counter runs live; nothing is lost if he closes the app. When the session is over he taps **Claim** and the UTYA goes to his *mined balance*. Everything is calculated on the server (the speed is fixed when the session starts), so the app cannot cheat.
2. **Withdraw.** With a connected wallet the user asks for a withdrawal (at least `/setminwithdraw`). The amount is **held** at once (taken off his balance). Every admin gets a message with the wallet, the amount and two buttons: **✅ I sent the UTYA** / **❌ Reject** (or `/wsent <id> [tx]`, `/wreject <id> [reason]`). The user is told. *Rejected* and *cancelled* requests give the amount back to the mined balance. The user can cancel a request while it is waiting.
3. **Who pays?** You do. Mined UTYA is a promise to pay from **your** wallet, so choose the speed with care: `/setminerate <UTYA per hour>` (first value 1 UTYA/hour, see `MINING` in `src/config.js`). `/stats` shows how much was mined (claimed) and how much you already paid out.
4. **Abuse.** Free mining attracts people with many accounts and bots. You approve every withdrawal by hand, so look at `/user <id>`, ban cheaters with `/ban`, and use `/channeljoinpopupshow` to make users join your channel. The Terms tab tells users that cheaters can be blocked.

## Live price chart
The **Chart tab** shows the UTYA price in USD for 1 hour, 24 hours or 7 days. The server reads the live price every 15 seconds (`PRICE.refreshMs`) and the app asks for the chart every 5 seconds, so the line, the price and the ▲ / ▼ change move live (the number flashes green or red when the price changes). Touch or hover the chart to see the price at any point. Past prices come from TonAPI (`GET /v2/rates/chart`); the points the server reads itself are added on top. If the history API is down the chart is built from live points only; it never invents a price. The chart is empty when no price source works.

## How buying works
1. The buyer opens the app, connects a TON wallet (TonConnect) and enters an amount in TON.
2. The app shows a **live quote** (UTYA price from the market, the fee, the UTYA he receives). Nothing is hard-coded: the price comes from TonAPI (backup: GeckoTerminal for UTYA, CoinGecko for TON). If no fresh price exists (older than 5 minutes) **buying pauses by itself**.
3. He presses Pay. The quote is **locked for 30 minutes**; the wallet opens with the amount and a comment `UTYA-XXXXXXXX`.
4. The server finds the transfer (comment + your address + enough TON) every 30 seconds and right away when the app asks. The order becomes **paid**, the buyer gets a Telegram message, **every admin gets a message with the wallet and the exact UTYA amount and a ✅ button**.
5. You send the UTYA from your wallet and tap **✅ I sent the UTYA** (or `/delivered <id> [tx hash]`). The buyer gets a message.
6. **Refund:** until you tapped ✅, the buyer can press *Request refund* in the app. You get a message, send the TON back and send `/refunded <id> [tx hash]`. The buyer is told. After the UTYA was sent there is no refund.
7. A payment that arrives **after the quote expired** (up to 24 h) is **re-quoted at the live price** (the buyer is told, you see a 🔁 note), so an old price can not be used against you or against the buyer.

What the buyer is promised, always visible in the app: the live price, the fee (`/setfee`), the delivery time (`/setdelivery`, default 24 h), the refund rule, the address that receives the payments and the contract of UTYA. **There are no hidden fees, no "verify" fee and no extra purchase needed before an order is delivered.**

## Setup (step by step)
1. **Create the bot.** @BotFather → `/newbot` → name `UTYA Miner`, username `UTYA_miner_bot`. Copy the token.
2. **Database.** Free MongoDB Atlas cluster, connection string with a database name, e.g. `mongodb+srv://USER:PASS@cluster.mongodb.net/utya`. Without it, orders are lost on every redeploy. **Do not run this bot without MongoDB.**
3. **Payment wallet.** A TON wallet **you control** that receives the TON and holds the UTYA you will send. Its address goes into `TON_DEPOSIT_ADDRESS` (or `/setdepositaddress <address>` later).
4. **TonAPI key (recommended).** Free at https://tonconsole.com → `TONAPI_KEY`. Without a key TonAPI allows about 1 request per second.
5. Upload to GitHub, create a **Web Service** on Render (`render.yaml` is included).
6. **Environment variables:**

| Name | Value |
|---|---|
| `BOT_TOKEN` | token from BotFather |
| `BOT_USERNAME` | `UTYA_miner_bot` |
| `PUBLIC_URL` | your Render URL, no `/` at the end |
| `WEBHOOK_SECRET` | any long random text (optional, a random one is made when empty) |
| `ADMIN_IDS` | your numeric Telegram ID(s), comma separated (ask @userinfobot) |
| `MONGODB_URI` | Atlas connection string |
| `TON_DEPOSIT_ADDRESS` | the wallet that receives payments |
| `TONAPI_KEY` | optional but recommended |
| `FORCE_CHANNELS` | optional, e.g. `@mychannel` (the bot must be admin there) |
| `UTYA_OFFICIAL` | optional. `1` = the app and the bot say "official". Only if you are the Utya project (see above) |
| `TON_TESTNET` | `1` only to test the payment flow on testnet (prices are always read from mainnet) |

7. Open `https://YOUR-URL/health`. You should see `{"ok":true,"db":"mongodb","bot":true,"payments":true,"price":true}`. `"price":false` means no live price could be read yet (wait a minute and reload; if it stays false check the Render logs).
8. In @BotFather set the **Menu Button / Mini App URL** to `PUBLIC_URL` (the bot also sets its own menu button at start).

## Test checklist (do this once with a small amount, before you tell anybody)
1. `/price` shows a live price and a sample quote. `/settings` shows your wallet. Open the **Chart** tab: the price must move within a minute.
2. With a second Telegram account: open the app, connect a wallet, buy the minimum. Confirm in the wallet. Within about a minute the order is **paid**, the buyer and you get a message.
3. Send the UTYA yourself and tap **✅ I sent the UTYA**. The buyer gets the message.
4. Do a second order and press **Request refund** in the app. Send the TON back, `/refunded <id>`.
5. `/stats` must match what you see in your wallet.
6. Mining: with a second account start mining, testing is easier with a high speed, e.g. `/setminerate 100` and `/setminwithdraw 10`; after the 4 hours (or after you lower `MINING.sessionHours` for the test) claim, request a withdrawal, then press ✅ in the admin message. Do it once with ❌ too and check that the balance comes back. Set the speed back afterwards.
7. Compare the quote with the price on DeDust / your wallet app. If they differ a lot, `/buyoff` and look at the logs before you open the bot.

**Not tested against the real services:** the live price sources, the TonAPI chart history and TonConnect inside real Telegram. The environment this was built in had no internet, so these were tested with simulated answers only (and the screens in a headless browser with a simulated server). That is why the checklist above matters.

## Admin commands
Anyone: `/start` · `/help` · `/balance` · `/myid`

Admins (IDs in `ADMIN_IDS` are owners; `/help` shows everything):

- **Orders:** `/orders` (`/pending`) · `/delivered <id> [tx]` · `/refunds` · `/refunded <id> [tx]` · `/order <id>` · `/payments` · `/confirmpay <id>` (`/confirmdeposit`)
- **Mining:** `/withdrawals` (`/wd`) · `/wsent <id> [tx]` · `/wreject <id> [reason]` · `/setminerate <UTYA/hour>` · `/setminwithdraw <UTYA>` · `/mineon` · `/mineoff` · `/withdrawon` · `/withdrawoff`
- **Selling:** `/price` · `/buyon` · `/buyoff` · `/setmin <TON>` · `/setmax <TON>` · `/setfee <percent 0-20>` · `/setdelivery <hours>` · `/settings`
- **Players:** `/stats` · `/totalusers` · `/user <id>` · `/ban <id> [reason]` · `/unban <id>`
- **Channel join popup:** `/channeljoinpopupshow <@channel>` · `/channeljoinlist` · `/channeljoinremove <n>` · `/noneedchanneljoin` · `/channeljoinon`
- **Messages:** `/broadcast <text>` (`/announcement`) · `/setwelcome <text|reset>` · `/setsupportusername <@name|link|off>` (`/setsupport`)
- **Owner only:** `/setdepositaddress <address>` · `/addadmin <id>` · `/removeadmin <id>` · `/admins`

`/confirmpay` is for the case that a buyer paid but TonAPI did not show the transfer: check your wallet first, then confirm by hand.

## Files
```
server.js        http server, API, channel gate, rate limit
src/config.js    token, default limits, timings, mining and chart settings, official switch
src/price.js     live price (TonAPI, GeckoTerminal, CoinGecko) and the chart data
src/game.js      quotes, orders, refunds, delivery, mining, withdrawals
src/pay.js       finds the TON payments on the blockchain
src/bot.js       bot messages and admin commands
src/messages.js  bot messages in English, Bangla, Russian
src/ton.js       addresses, payment comment, TonAPI
src/db.js        MongoDB or JSON file (development only): users, orders, withdrawals
public/index.html  the Mini App (Mine, Buy, Chart, Orders, Terms)
test/            npm test (price, order flow, bot commands, server)
```

## Notes
- The app and the bot speak English, Bangla and Russian. Add a language in `src/messages.js` and in `I18N` of `public/index.html`, and add its code to `LANGS` in `src/config.js`.
- Everything is in `src/config.js`: first limits, timings, the token contract.
- Orders can only be marked once (a double tap on ✅ does nothing). A paid order can not be both delivered and refunded.
