// Everything you may want to change lives here. Prices are NEVER written here: they come live from the market (src/price.js).

export const BRAND = {
  name: "UTYA Miner",
  username: "UTYA_miner_bot",
  // Set the environment variable UTYA_OFFICIAL=1 ONLY if you really are the Utya project (or have its written permission).
  // Then the app and the bot say "official". Otherwise they say "independent service, not affiliated" (the truth for everybody else).
  official: process.env.UTYA_OFFICIAL === "1",
};

/** The token that is sold. A real jetton on TON, traded on DeDust. */
export const TOKEN = {
  name: "Utya",
  symbol: "UTYA",
  network: "TON",
  // the same address in two notations (raw / user friendly)
  jettonRaw: "0:5a0a05303a873a80708d967fe82736f4995b3bf581bbc18a1abe1fa8d48b5a9d",
  jettonFriendly: "EQBaCgUwOoc6gHCNln_oJzb0mVs79YG7wYoavh-o1ItaneLA",
};

/** First values; an admin changes them later with /setmin /setmax /setfee /setdelivery. */
export const DEFAULTS = {
  minTon: 1, // smallest order, in TON
  maxTon: 500, // largest order, in TON
  feePct: 0, // service fee in percent. It is always shown to the buyer before paying.
  deliveryHours: 24, // what the app promises: "UTYA is sent within this time"
};

/** Mining. The mined UTYA is paid by YOU (the operator) from your own wallet when you approve a withdrawal, so keep the rate low. */
export const MINING = {
  sessionHours: 4, // one session; the user comes back, claims, and starts the next one
  sessionMs: 4 * 3600_000,
  // first values; an admin changes them later with /setminerate and /setminwithdraw
  ratePerHour: 1, // UTYA per hour for every user
  minWithdraw: 100, // smallest withdrawal, in UTYA
  maxOpenWithdrawals: 2, // withdrawal requests one user may have waiting at the same time
};

/** Referrals: a friend counts when he opens the bot with your link AND connects his own TON wallet. */
export const REFERRAL = {
  bonusUtya: 5, // paid to the inviter, once per friend, into his mined balance (admin: /setrefbonus)
};

/** The price chart: how far back each range goes and how many points the app gets at most. */
export const CHART = {
  ranges: {
    "1h": { ms: 3600_000, points: 120 },
    "24h": { ms: 24 * 3600_000, points: 144 },
    "7d": { ms: 7 * 24 * 3600_000, points: 168 },
  },
  defaultRange: "24h",
  historyCacheMs: 60_000, // the long history (TonAPI chart) is fetched at most this often per range
  maxTicks: 6000, // live prices kept in memory (about 25 hours at one every 15 s)
};

export const PRICE = {
  refreshMs: 15_000, // how often the live price is fetched at most
  staleMs: 5 * 60_000, // if the last good price is older than this, buying is paused (never a made-up price)
};

export const ORDER = {
  pendingMs: 30 * 60_000, // the quote is held for this long after the player pressed Pay
  lateAcceptMs: 24 * 3600_000, // a payment that arrives late is still found for this long (then it is re-quoted at the live price)
  maxOpenPerUser: 3,
};

export const PAYMENT_SWEEP_MS = 30_000; // how often the server looks for payments on the blockchain
export const MAX_REQUESTS_PER_MINUTE = 90; // per player; far more than the app ever sends
export const LANGS = ["en", "ar", "ru"]; // English, Arabic, Russian
