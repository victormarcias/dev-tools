// Gmail Expenses: categories, their senders and the patterns that read them.
// author: @victormarcias
//
// Everything here is meant to be edited by hand. Each list entry is either a
// plain string (matched against the sender's name or address, using the
// category's default patterns) or an object that overrides any of the
// category's patterns for that sender:
//
//   { name: 'X', from: 'x.com.ar', amount: /Total\s*\$\s*([\d.,]+)/i }

const STATUS_TO_PAY = 'Pagar';
const STATUS_PAID = 'Pagado';

// Generic patterns. The first capture group is the amount. Amounts can be
// written either way: 12.345,67 or 12,345.67. Pesos can come as "$", "ARS" or
// "AR$", but not "US$" or "U$S".
const PESOS = /(?:ARS\s*\$?|AR\$|(?<!US|U)\$)/.source;
const AMOUNT_ARS = new RegExp(`(?:total(?: a pagar)?|importe|monto|saldo actual)[^\\d$]{0,40}?${PESOS}\\s*([\\d.,]+)`, 'i');
const AMOUNT_USD = /(?:U\$S|US\$|USD)\s*([\d.,]+)/i;
const DUE_DATE = /venc(?:imiento|e)[^\d]{0,40}(\d{1,2}\/\d{1,2}\/\d{2,4})/i;

// Paid with a credit card, so already part of the card statement: entries
// with this as skipIf are marked as processed without a row.
const CREDIT_CARD = /tarjeta de cr[eé]dito|credit card|cuotas/i;

// Subject of a receipt (as opposed to a bill or a promo)
const RECEIPT = /recibo|pago|factura|cobro|compra|receipt|purchase|payment/i;

// Credit card statements (resumen de tarjeta).
const BANKS = [
  // Value first, then its label: "11 Noviembre 2026 Fecha de vencimiento
  // $ 50.079,83 Saldo en pesos U$S 88,84 Saldo en dólares"
  {
    name: 'Brubank',
    amount: /(?<!U)\$\s*([\d.,]+)\s*Saldo en pesos/i,
    usd: /(?:U\$S|US\$|USD)\s*([\d.,]+)\s*Saldo en d[oó]lares/i,
    due: /(\d{1,2}\s+[a-z]+\s+\d{4})\s*Fecha de vencimiento/i,
  },
  // "Saldo en pesos: 68.314,43" (no $), "Vencimiento: 11 Nov 26"
  {
    name: 'Galicia',
    amount: /Saldo en pesos:\s*\$?\s*([\d.,]+)/i,
    usd: /Saldo en d[oó]lares:\s*(?:U\$S|US\$|USD)?\s*([\d.,]+)/i,
    due: /Vencimiento:\s*(\d{1,2}\s+[a-z]{3}\w*\.?\s+\d{2,4})/i,
  },
  // Short or common names go by domain, so they don't catch unrelated senders.
  'Santander', 'BBVA', 'Banco Macro', 'ICBC', 'Credicoop', 'Banco Patagonia',
  'Supervielle', 'Comafi', 'Hipotecario', 'American Express',
  { name: 'Nación', from: 'bna.com.ar' },
  { name: 'Provincia', from: 'bancoprovincia.com.ar' },
  { name: 'Ciudad', from: 'bancociudad.com.ar' },
  { name: 'Naranja X', from: 'naranjax.com' },
  { name: 'Ualá', from: 'uala.com.ar' },
  'Mercado Pago',
];

// The house's essentials: electricity, gas, water, municipal taxes. They're
// paid through a wallet, so their bills are ignored: these names only decide
// that a payment to them goes in Hogar (see PAYMENTS). Expensas and cleaning
// are paid by transfer: their aliases go in TRANSFERS (Transfers.gs).
const HOGAR = [
  // Electricity
  'Cooperativa Electrica', 'Edemsa', 'Edenor', 'Edesur', 'Edelap', 'EPEC',
  // Gas
  'Ecogas', 'Metrogas', 'Naturgy', 'Camuzzi', 'Litoral Gas',
  // Water
  'AYSAM', 'AySA', 'Aguas Cordobesas', 'ABSA',
  // Taxes
  'Municipio',
];

// Secondary bills: phone, internet, TV, and any digital service.
const SERVICES = [
  // Phone, internet, TV: like HOGAR, bills are ignored and the names only
  // categorize payments
  'Movistar', 'Tuenti', { name: 'Claro', from: 'claro.com.ar' },
  { name: 'Personal', from: 'personal.com.ar' }, 'Telecentro', 'DirecTV',
  // Digital services (streaming, music, games, apps, cloud, AI): charged
  // automatically, so their receipts are read, with no due date, sometimes in
  // USD, and credit card charges are skipped. Only receipts, so promos are
  // ignored.
  ...[
    // Streaming and music
    { name: 'Netflix', from: 'netflix.com' },
    { name: 'HBO Max', from: 'hbomax.com' },
    { name: 'Disney+', from: 'disneyplus.com' },
    { name: 'Paramount+', from: 'paramountplus.com' },
    { name: 'Spotify', from: 'spotify.com' },
    // Games
    { name: 'Steam', from: 'steampowered.com' },
    { name: 'Nintendo', from: 'nintendo.com' },
    // Apps, cloud and AI
    { name: 'Google Play', from: 'googleplay-noreply@google.com' },
    { name: 'Apple', from: 'apple.com' },
    { name: 'Microsoft', from: 'microsoft.com' },
    { name: 'ChatGPT', from: 'openai.com' },
    { name: 'Claude', from: 'anthropic.com' },
  ].map((entry) => ({
    subject: RECEIPT, usd: AMOUNT_USD, skipIf: CREDIT_CARD, viaPayments: false, ...entry,
  })),
];

// Health insurance (prepaga).
const PREPAGAS = [
  'OSDE', 'Swiss Medical', 'Galeno', 'Medife', 'Omint', 'Medicus', 'Nobis',
  'Sancor Salud', 'Prevencion Salud', 'Avalian', 'Accord Salud',
  'Federada Salud', 'Jerarquicos Salud', 'Hospital Italiano', 'Hospital Aleman',
  'Hospital Britanico',
];

// Each key is a column of the sheet, in this order, between Detalle and USD.
// To add a category, add a key here: tabs that already exist get the new
// column appended at the end.
//
// Category defaults. `subject` must match for a message to be handled at all;
// messages from a known sender whose subject doesn't match are left untouched.
// `viaPayments`: the senders' own emails are never read; their names only
// decide the category of a payment to them (see PAYMENTS).
const CATEGORIES = {
  'Tarjetas': {
    entries: BANKS,
    // "Resumen" plus a card, in any order, so account statements (caja de
    // ahorro, cuenta corriente) are ignored. Galicia's card statement is
    // "Resumen de Cuenta VISA", so "cuenta" alone can't rule one out.
    subject: /^(?=.*resumen)(?=.*(?:tarjeta|visa|master|amex|american express|cabal|naranja))/i,
    amount: AMOUNT_ARS,
    usd: AMOUNT_USD,
    due: DUE_DATE,
    status: STATUS_TO_PAY,
  },
  'Transporte': {
    entries: [
      { name: 'Uber', from: 'uber.com', subject: /viaje|trip/i, excludeSubject: /eats/i },
      { name: 'Cabify', from: 'cabify.com', subject: /viaje|recibo|trip/i },
    ],
    amount: AMOUNT_ARS,
    usd: AMOUNT_USD,
    status: STATUS_PAID,
  },
  'Compras': {
    entries: [
      // Only debit / account money purchases: credit card ones are already
      // part of the card statement. skipIf marks the mail as processed without
      // adding a row; if onlyIf doesn't match, it goes to review.
      {
        name: 'MercadoLibre',
        from: 'mercadolibre.com.ar',
        subject: /compraste|tu compra/i,
        skipIf: CREDIT_CARD,
        onlyIf: /d[eé]bito|dinero (?:disponible|en cuenta)|mercado pago/i,
      },
    ],
    amount: AMOUNT_ARS,
    status: STATUS_PAID,
  },
  'Hogar': {
    entries: HOGAR,
    viaPayments: true,
  },
  'Servicios': {
    // Only the digital services are read (they set viaPayments: false)
    entries: SERVICES,
    viaPayments: true,
    amount: AMOUNT_ARS,
    status: STATUS_PAID,
  },
  'Salud': {
    entries: PREPAGAS,
    subject: /factura|disponible|cuota/i,
    amount: AMOUNT_ARS,
    due: DUE_DATE,
    // Paid by automatic debit: the bill is already paid when it's due
    status: STATUS_PAID,
  },
  'Delivery': {
    entries: [
      { name: 'PedidosYa', from: 'pedidosya.com', subject: /pedido|recibo|plus/i },
      { name: 'Rappi', from: 'rappi', subject: /pedido|orden|recibo|prime/i },
      { name: 'Uber Eats', from: 'uber.com', subject: /eats/i },
    ],
    amount: AMOUNT_ARS,
    status: STATUS_PAID,
  },
};

// Payment and transfer confirmations, from any wallet or homebanking ("Pago
// aprobado en X", "Pagaste tu factura de X", "Transferiste a X"). They're not
// a column: each one is a Pagado row named after the `payee` (or the
// subject), in the category of the recipient's alias (TRANSFERS, in
// Transfers.gs) or of a known sender with that name, or `category` if none. Paid by credit card (skipIf), it adds nothing: it's
// already in the statement. Entries accept the same overrides as any
// category's.
const PAYMENTS = {
  entries: [
    { name: 'Mercado Pago', from: 'mercadopago.com.ar' },
  ],
  subject: /pago|pagaste|compraste|transferiste|transferencia|enviaste/i,
  // Money coming in, failed payments, and purchases already handled by
  // their own entry in Compras
  excludeSubject: /recibiste|cobraste|devoluci[oó]n|reintegro|rechazad|pendiente|mercado ?libre/i,
  // On the subject; the capture group is who was paid
  payee: /(?:aprobado en|pagaste(?: tu factura de| a)?|compraste a|pago (?:a|de|en)|transferiste a|transferencia a|enviaste dinero a)\s+(.+)$/i,
  amount: new RegExp(`(?:pagaste|transferiste|enviaste|pago de|total|importe|monto)[^\\d$]{0,40}?${PESOS}\\s*([\\d.,]+)`, 'i'),
  skipIf: CREDIT_CARD,
  category: 'Compras',
  status: STATUS_PAID,
};
