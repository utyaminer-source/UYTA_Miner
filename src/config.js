// Everything you may want to change lives here. Prices are NEVER written here: they come live from the market (src/price.js).

export const BRAND = {
  name: "UTYA Miner",
  username: "UTYA_miner_bot",
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
export const LANGS = ["en", "bn", "ru"];
