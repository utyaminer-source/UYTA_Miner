// The live market price of UTYA and TON. Nothing is hard-coded: if no fresh price can be read, buying pauses.
// UTYA in USD:  TonAPI rates  ->  GeckoTerminal (backup)
// TON in USD:   TonAPI rates  ->  CoinGecko (backup)
import { CHART, PRICE, TOKEN } from "./config.js";
import { parseAddress, rawAddress } from "./ton.js";

const num = (x) => {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function createPrice({ base = "https://tonapi.io", key = "", fetchImpl = fetch, now = () => Date.now() } = {}) {
  let last = null; // { tonUsd, utyaUsd, at, sources }
  let inflight = null;
  const ticks = []; // every live UTYA price we read: [time ms, usd]. This is what makes the chart move live.
  const history = new Map(); // range -> { at, points } long history from TonAPI, cached
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
    ticks.push([last.at, utyaUsd]);
    if (ticks.length > CHART.maxTicks) ticks.splice(0, ticks.length - CHART.maxTicks);
    return last;
  }

  // ------------------------------- chart ---------------------------------

  /** Past prices from TonAPI (GET /v2/rates/chart). Returns [[ms, usd], ...] sorted by time. */
  async function historyFromTonApi(range) {
    const cfg = CHART.ranges[range];
    const cached = history.get(range);
    if (cached && now() - cached.at < CHART.historyCacheMs) return cached.points;
    const end = Math.floor(now() / 1000);
    const start = end - Math.floor(cfg.ms / 1000);
    const url = `${base}/v2/rates/chart?token=${encodeURIComponent(TOKEN.jettonFriendly)}&currency=usd&start_date=${start}&end_date=${end}&points_count=${cfg.points}`;
    let points = cached?.points ?? [];
    try {
      const data = await getJson(url, key ? { authorization: `Bearer ${key}` } : {});
      const rows = Array.isArray(data?.points) ? data.points : [];
      const out = [];
      for (const row of rows) {
        const ts = Array.isArray(row) ? row[0] : row?.time ?? row?.t;
        const price = num(Array.isArray(row) ? row[1] : row?.price ?? row?.p);
        const t = Number(ts);
        if (!price || !Number.isFinite(t)) continue;
        out.push([t < 1e12 ? t * 1000 : t, price]); // seconds -> ms
      }
      out.sort((a, b) => a[0] - b[0]);
      if (out.length) points = out;
    } catch (err) {
      console.warn("[price] chart history:", err.message);
    }
    history.set(range, { at: now(), points }); // also remembers a failure for a while, so a broken API is not hammered
    return points;
  }

  /** At most `max` points, evenly spread, and always including the newest one. */
  function thin(points, max) {
    if (points.length <= max) return points;
    const out = [];
    const step = (points.length - 1) / (max - 1);
    for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
    return out;
  }

  /**
   * The data of the chart for "1h" | "24h" | "7d": past prices from TonAPI, joined with the live prices this server read itself.
   * It never invents a point: with no data at all, `points` is empty.
   */
  async function chart(range) {
    const name = CHART.ranges[range] ? range : CHART.defaultRange;
    const cfg = CHART.ranges[name];
    const current = await (async () => {
      try {
        return await api.get();
      } catch {
        return null;
      }
    })();
    const from = now() - cfg.ms;
    const live = ticks.filter((t) => t[0] >= from);
    const past = await historyFromTonApi(name);
    const firstLive = live.length ? live[0][0] : Infinity;
    const merged = [...past.filter((p) => p[0] >= from && p[0] < firstLive), ...live];
    const points = thin(merged, cfg.points);
    const prices = points.map((p) => p[1]);
    const first = prices[0] ?? null;
    const lastPrice = current?.utyaUsd ?? prices[prices.length - 1] ?? null;
    return {
      range: name,
      points,
      last: lastPrice,
      first,
      high: prices.length ? Math.max(...prices) : null,
      low: prices.length ? Math.min(...prices) : null,
      changePct: first && lastPrice ? ((lastPrice - first) / first) * 100 : null,
      live: Boolean(current), // false: the newest price is older than PRICE.staleMs
      at: current?.at ?? 0,
      now: now(),
    };
  }

  const api = {
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
    chart,
  };
  return api;
}
