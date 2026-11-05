// Connects the orders to the TON blockchain: builds the payment the wallet has to confirm and finds it afterwards.
import * as game from "./game.js";
import { commentPayloadBase64, friendlyAddress, matchPayments, parseAddress, toNano } from "./ton.js";

export function createPay({ tonApi }) {
  async function adminAddress() {
    const text = await game.getDepositAddress();
    const addr = parseAddress(text);
    return addr ? { addr, text } : null;
  }

  /** Looks for the given orders on the blockchain. Returns Map(comment -> { txHash, nano }). */
  async function lookup(orders) {
    const admin = await adminAddress();
    if (!admin || !orders.length) return new Map();
    const events = await tonApi.recentEvents(friendlyAddress(admin.addr, { bounceable: true, testnet: game.runtime.testnet }));
    return matchPayments(
      events,
      admin.text,
      orders.map((o) => ({ comment: game.paymentComment(o), nano: toNano(o.ton) })),
    );
  }

  /** Creates the order and the message for TonConnect's sendTransaction. The wallet opens by itself on the phone. */
  async function prepare(userId, rawTon) {
    const admin = await adminAddress();
    if (!admin) throw new game.GameError("Payments are not open yet.", "pay_closed");
    const o = await game.createOrder(userId, rawTon);
    return {
      id: o.id,
      ton: o.ton,
      utya: o.utya,
      validUntil: Math.floor(Date.now() / 1000) + 600,
      messages: [
        {
          address: friendlyAddress(admin.addr, { bounceable: false, testnet: game.runtime.testnet }),
          amount: toNano(o.ton).toString(),
          payload: commentPayloadBase64(game.paymentComment(o)),
        },
      ],
    };
  }

  /** The app asks "did my payment arrive?" */
  async function checkOne(userId, id) {
    const o = await game.orderOf(userId, id);
    if (o.status === "pending" || o.status === "expired") {
      try {
        const hit = (await lookup([o])).get(game.paymentComment(o));
        if (hit) await game.completePayment(o, { txHash: hit.txHash, nano: hit.nano });
      } catch (err) {
        console.error("[pay] check failed:", err.message);
      }
    }
    return game.orderStatus(o.id);
  }

  /** Runs every few seconds: finishes payments even when the buyer has closed the app. */
  async function sweep() {
    const open = await game.openOrders();
    if (!open.length) return 0;
    let done = 0;
    const found = await lookup(open);
    for (const o of open) {
      const hit = found.get(game.paymentComment(o));
      if (hit && (await game.completePayment(o, { txHash: hit.txHash, nano: hit.nano }))) done += 1;
    }
    return done;
  }

  /** Admin: the buyer paid but the blockchain lookup did not find it (TonAPI down...). */
  async function confirmManually(id, adminId) {
    const o = await game.getOrder(id);
    if (!o) throw new game.GameError(`Order ${id} not found.`);
    const ok = await game.completePayment(o, { txHash: `manual:${adminId}`, nano: toNano(o.ton) });
    if (!ok) throw new game.GameError(`Order ${o.id} is already "${o.status}".`);
    return o;
  }

  return { prepare, checkOne, sweep, confirmManually, adminAddress };
}
