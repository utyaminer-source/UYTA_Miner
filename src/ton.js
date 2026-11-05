// Everything that touches the TON blockchain: addresses, the payment message and finding payments.

// ------------------------------- addresses -----------------------------------

export function crc16(buf) {
  let crc = 0;
  for (const byte of buf) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** Accepts "0:abc…" (raw) and "UQ…/EQ…" (user friendly, base64 or base64url). Returns { wc, hash } or null. */
export function parseAddress(input) {
  const s = String(input ?? "").trim();
  let m = /^(-?\d+):([0-9a-fA-F]{64})$/.exec(s);
  if (m) {
    const wc = Number(m[1]);
    if (wc !== 0 && wc !== -1) return null;
    return { wc, hash: Buffer.from(m[2], "hex") };
  }
  if (!/^[A-Za-z0-9_\-+/]{48}$/.test(s)) return null;
  const bytes = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (bytes.length !== 36) return null;
  if (crc16(bytes.subarray(0, 34)) !== bytes.readUInt16BE(34)) return null;
  const wc = bytes.readInt8(1);
  if (wc !== 0 && wc !== -1) return null;
  return { wc, hash: Buffer.from(bytes.subarray(2, 34)) };
}

export const rawAddress = (addr) => `${addr.wc}:${addr.hash.toString("hex")}`;

/** "UQ…" (non-bounceable, right for a normal wallet) or "EQ…" (bounceable). */
export function friendlyAddress(addr, { bounceable = false, testnet = false } = {}) {
  const buf = Buffer.alloc(36);
  buf[0] = (bounceable ? 0x11 : 0x51) | (testnet ? 0x80 : 0);
  buf.writeInt8(addr.wc, 1);
  addr.hash.copy(buf, 2);
  buf.writeUInt16BE(crc16(buf.subarray(0, 34)), 34);
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

/** Normalizes anything the wallet gives us into a friendly address, or null when it is not an address. */
export function normalizeWallet(input, opts) {
  const a = parseAddress(input);
  return a ? friendlyAddress(a, opts) : null;
}

// ------------------------- the comment inside a payment ----------------------

/**
 * The payload of a TON transfer that carries a text comment, as a base64 BOC (one cell: 32 zero bits + the text).
 * The comment is how we know which player paid for what.
 */
export function commentPayloadBase64(text) {
  const data = Buffer.concat([Buffer.alloc(4), Buffer.from(text, "utf8")]);
  if (data.length > 127) throw new Error("Comment too long");
  const cell = Buffer.concat([Buffer.from([0, data.length * 2]), data]);
  const boc = Buffer.concat([Buffer.from([0xb5, 0xee, 0x9c, 0x72, 0x01, 0x01, 0x01, 0x01, 0x00, cell.length, 0x00]), cell]);
  return boc.toString("base64");
}

export const toNano = (ton) => BigInt(Math.round(Number(ton) * 1e9));

// ---------------------------------- TonAPI -----------------------------------

export function createTonApi({ base = "https://tonapi.io", key = "", fetchImpl = fetch } = {}) {
  let cache = { at: 0, address: "", events: [] };
  return {
    /** The latest events of an address. Cached for a few seconds so a busy server does not hit the rate limit. */
    async recentEvents(address, limit = 100) {
      if (cache.address === address && Date.now() - cache.at < 4000) return cache.events;
      const res = await fetchImpl(`${base}/v2/accounts/${encodeURIComponent(address)}/events?limit=${limit}`, {
        headers: key ? { authorization: `Bearer ${key}` } : {},
      });
      if (!res.ok) throw new Error(`TonAPI answered ${res.status}`);
      const data = await res.json();
      cache = { at: Date.now(), address, events: data.events ?? [] };
      return cache.events;
    },
  };
}

/**
 * Looks through TonAPI events for incoming TON transfers to `adminAddress` that carry one of the wanted comments.
 * wanted = [{ comment, nano }] where nano is the minimum amount (BigInt).
 * Returns Map(comment -> { txHash, nano, sender }).
 */
export function matchPayments(events, adminAddress, wanted) {
  const admin = parseAddress(adminAddress);
  const found = new Map();
  if (!admin) return found;
  const adminRaw = rawAddress(admin);
  const byComment = new Map(wanted.map((w) => [w.comment, w]));
  for (const ev of events) {
    if (ev.is_scam) continue;
    for (const action of ev.actions ?? []) {
      if (action.type !== "TonTransfer" || action.status !== "ok") continue;
      const tr = action.TonTransfer;
      if (!tr || typeof tr.comment !== "string") continue;
      const want = byComment.get(tr.comment.trim());
      if (!want || found.has(want.comment)) continue;
      const to = parseAddress(tr.recipient?.address);
      if (!to || rawAddress(to) !== adminRaw) continue;
      let nano;
      try {
        nano = BigInt(tr.amount);
      } catch {
        continue;
      }
      if (nano < want.nano) continue;
      found.set(want.comment, { txHash: String(ev.event_id ?? ""), nano, sender: tr.sender?.address ?? "" });
    }
  }
  return found;
}
