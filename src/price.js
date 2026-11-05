// The live market price of UTYA and TON. Nothing is hard-coded: if no fresh price can be read, buying pauses.
// UTYA in USD:  TonAPI rates  ->  GeckoTerminal (backup)
// TON in USD:   TonAPI rates  ->  CoinGecko (backup)
import { PRICE, TOKEN } from "./config.js";
import { parseAddress, rawAddress } from "./ton.js";

const num = (x) => {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function createPrice({ base = "https://tonapi.io", key = "", fetchImpl = fetch, now = () => Date.now() } = {}) {
  let last = null; // { tonUsd, utyaUsd, at, sources }
  let inflight = null;
  const jettonRaw = rawAddress(parseAddress(TOKEN.jettonRaw));

  async function getJson(url, headers = {}) {
    const res = await fetchImpl(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
    return res.json();
  }

  async function fromTonApi() {
    const url = `${base}/v2/rates?tokens=ton,${encodeURIComponent(TOKEN.jettonFriendly)}&currencies=usd`;
    const data = await getJson(url, key ? { authorization: `Bearer ${key}` } : {});
    const rates = data?.rates ?? {};
    let ton = null;
    let utya = null;
    for (const [k, v] of Object.entries(rates)) {
      const usd = num(v?.prices?.USD ?? v?.prices?.usd);
      if (k.toUpperCase() === "TON") ton = usd;
      else {
        const a = parseAddress(k);
        if ((a && rawAddress(a) === jettonRaw) || (!a && k === TOKEN.jettonFriendly)) utya = usd;
      }
    }
    return { tonUsd: ton, utyaUsd: utya };
  }

  async function utyaFromGecko() {
    const data = await getJson(`https://api.geckoterminal.com/api/v2/simple/networks/ton/token_price/${encodeURIComponent(TOKEN.jettonFriendly)}`);
    const prices = data?.data?.attributes?.token_prices ?? {};
    for (const [k, v] of Object.entries(prices)) {
      const a = parseAddress(k);
      if (!a || rawAddress(a) === jettonRaw) return num(v); // the answer is for the one address we asked for
    }
    return null;
  }

  async function tonFromCoinGecko() {
    const data = await getJson("https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd");
    return num(data?.["the-open-network"]?.usd);
  }

  async function refresh() {
    let tonUsd = null;
    let utyaUsd = null;
    const sources = [];
    try {
      const r = await fromTonApi();
      tonUsd = r.tonUsd;
      utyaUsd = r.utyaUsd;
      if (tonUsd || utyaUsd) sources.push("tonapi");
    } catch (err) {
      console.warn("[price] TonAPI:", err.message);
    }
    if (!utyaUsd) {
      try {
        utyaUsd = await utyaFromGecko();
        if (utyaUsd) sources.push("geckoterminal");
      } catch (err) {
        console.warn("[price] GeckoTerminal:", err.message);
      }
    }
    if (!tonUsd) {
      try {
        tonUsd = await tonFromCoinGecko();
        if (tonUsd) sources.push("coingecko");
      } catch (err) {
        console.warn("[price] CoinGecko:", err.message);
      }
    }
    if (!tonUsd || !utyaUsd) return null; // never guess the missing half
    last = { tonUsd, utyaUsd, at: now(), sources };
    return last;
  }

  return {
    /** The live price, or null when there is no price younger than PRICE.staleMs. Fetches at most every PRICE.refreshMs. */
    async get() {
      if (last && now() - last.at < PRICE.refreshMs) return last;
      if (!inflight) inflight = refresh().finally(() => { inflight = null; });
      try {
        await inflight;
      } catch (err) {
        console.warn("[price] refresh failed:", err.message);
      }
      return last && now() - last.at < PRICE.staleMs ? last : null;
    },
    peek: () => (last && now() - last.at < PRICE.staleMs ? last : null),
  };
}
