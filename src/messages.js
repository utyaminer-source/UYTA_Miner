// Messages the BOT sends to players, in every supported language. English is the fallback.
// (Admin messages are English only.)
const M = {
  en: {
    "welcome.title": "🦆 Welcome to UTYA Miner, {name}!",
    "welcome.body": "Buy {symbol} with TON. You see the live market price before you pay. After your payment an admin sends the {symbol} to your own TON wallet, and you can ask for a refund any time before it is sent.",
    "welcome.unofficial": "ℹ️ UTYA Miner is an unofficial service. It is not affiliated with the Utya project.",
    "welcome.cta": "Tap the button below 👇",
    "btn.open": "🦆 Open UTYA Miner",
    "open.hint": "Tap the button below to open UTYA Miner 👇",
    "help": "Open the app, connect your TON wallet, choose how many TON you want to spend and pay. The price is live, the fee is shown before you pay, and an admin sends the {symbol} to your wallet by hand (about {hours} hours). You can request a refund in the app until it is sent.",
    "banned": "Your account is blocked.",
    "order.paid": "✅ Payment received for order {id}: {ton} TON.\nYou will get {utya} {symbol} in your wallet within about {hours} hours.\nYou can request a refund in the app any time before it is sent.",
    "order.paidLate": "✅ Payment received for order {id}: {ton} TON.\nIt arrived after the price quote expired, so the amount was recalculated at the live price: you will get {utya} {symbol} within about {hours} hours.\nIf you do not agree, request a refund in the app.",
    "order.delivered": "🦆 Order {id}: {utya} {symbol} were sent to your wallet.{tx}",
    "order.refundReq": "↩️ Refund requested for order {id}. The team will send {ton} TON back to your wallet.",
    "order.refunded": "↩️ Order {id} refunded: {ton} TON were sent back to your wallet.{tx}",
  },
  bn: {
    "welcome.title": "🦆 UTYA Miner-এ স্বাগতম, {name}!",
    "welcome.body": "TON দিয়ে {symbol} কিনুন। পেমেন্টের আগে আপনি লাইভ বাজারদর দেখতে পাবেন। পেমেন্টের পর অ্যাডমিন আপনার নিজের TON ওয়ালেটে {symbol} পাঠিয়ে দেবে, আর পাঠানোর আগে যেকোনো সময় রিফান্ড চাইতে পারবেন।",
    "welcome.unofficial": "ℹ️ UTYA Miner একটি আনঅফিসিয়াল সার্ভিস। এটি Utya প্রজেক্টের সাথে যুক্ত নয়।",
    "welcome.cta": "নিচের বাটনে ট্যাপ করুন 👇",
    "btn.open": "🦆 UTYA Miner খুলুন",
    "open.hint": "UTYA Miner খুলতে নিচের বাটনে ট্যাপ করুন 👇",
    "help": "অ্যাপ খুলে আপনার TON ওয়ালেট কানেক্ট করুন, কত TON খরচ করবেন বেছে নিন এবং পেমেন্ট করুন। দাম লাইভ, ফি পেমেন্টের আগেই দেখানো হয়, আর অ্যাডমিন নিজে হাতে আপনার ওয়ালেটে {symbol} পাঠায় (প্রায় {hours} ঘণ্টা)। পাঠানোর আগ পর্যন্ত অ্যাপ থেকে রিফান্ড চাইতে পারবেন।",
    "banned": "আপনার অ্যাকাউন্ট ব্লক করা হয়েছে।",
    "order.paid": "✅ অর্ডার {id}-এর পেমেন্ট পাওয়া গেছে: {ton} TON।\nপ্রায় {hours} ঘণ্টার মধ্যে আপনার ওয়ালেটে {utya} {symbol} পাবেন।\nপাঠানোর আগে যেকোনো সময় অ্যাপ থেকে রিফান্ড চাইতে পারবেন।",
    "order.paidLate": "✅ অর্ডার {id}-এর পেমেন্ট পাওয়া গেছে: {ton} TON।\nদামের কোট শেষ হওয়ার পরে পেমেন্ট এসেছে, তাই লাইভ দামে পরিমাণ আবার হিসাব করা হয়েছে: প্রায় {hours} ঘণ্টার মধ্যে {utya} {symbol} পাবেন।\nরাজি না হলে অ্যাপ থেকে রিফান্ড চান।",
    "order.delivered": "🦆 অর্ডার {id}: {utya} {symbol} আপনার ওয়ালেটে পাঠানো হয়েছে।{tx}",
    "order.refundReq": "↩️ অর্ডার {id}-এর রিফান্ড চাওয়া হয়েছে। টিম আপনার ওয়ালেটে {ton} TON ফেরত পাঠাবে।",
    "order.refunded": "↩️ অর্ডার {id} রিফান্ড হয়েছে: {ton} TON আপনার ওয়ালেটে ফেরত পাঠানো হয়েছে।{tx}",
  },
  ru: {
    "welcome.title": "🦆 Добро пожаловать в UTYA Miner, {name}!",
    "welcome.body": "Покупайте {symbol} за TON. Перед оплатой вы видите актуальную рыночную цену. После оплаты администратор отправит {symbol} на ваш TON-кошелёк, а вернуть деньги можно в любой момент до отправки.",
    "welcome.unofficial": "ℹ️ UTYA Miner — неофициальный сервис. Он не связан с проектом Utya.",
    "welcome.cta": "Нажмите кнопку ниже 👇",
    "btn.open": "🦆 Открыть UTYA Miner",
    "open.hint": "Нажмите кнопку ниже, чтобы открыть UTYA Miner 👇",
    "help": "Откройте приложение, подключите TON-кошелёк, выберите сумму в TON и оплатите. Цена актуальная, комиссия показывается до оплаты, а администратор вручную отправляет {symbol} на ваш кошелёк (примерно {hours} ч). До отправки можно запросить возврат в приложении.",
    "banned": "Ваш аккаунт заблокирован.",
    "order.paid": "✅ Оплата заказа {id} получена: {ton} TON.\nВы получите {utya} {symbol} на кошелёк примерно в течение {hours} ч.\nДо отправки можно запросить возврат в приложении.",
    "order.paidLate": "✅ Оплата заказа {id} получена: {ton} TON.\nОна пришла после истечения котировки, поэтому сумма пересчитана по актуальной цене: вы получите {utya} {symbol} примерно в течение {hours} ч.\nЕсли вы не согласны, запросите возврат в приложении.",
    "order.delivered": "🦆 Заказ {id}: {utya} {symbol} отправлены на ваш кошелёк.{tx}",
    "order.refundReq": "↩️ Запрошен возврат по заказу {id}. Команда вернёт {ton} TON на ваш кошелёк.",
    "order.refunded": "↩️ Возврат по заказу {id} выполнен: {ton} TON отправлены на ваш кошелёк.{tx}",
  },
};

export function T(lang, key, vars = {}) {
  const text = M[lang]?.[key] ?? M.en[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined ? `{${k}}` : String(vars[k])));
}
