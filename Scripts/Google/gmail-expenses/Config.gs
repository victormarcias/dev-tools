// Gmail Expenses: configuration.
// author: @victormarcias
//
// Everything here is meant to be edited by hand. IDs (the spreadsheet's
// FILE_ID) never go here: they live in Script Properties.
//
// Each list entry is either a plain string (matched against the sender's name
// or address, using the category's default patterns) or an object that
// overrides any of the category's patterns for that sender:
//
//   { name: 'Ecogas', from: 'ecogas.com.ar', amount: /Total\s*\$\s*([\d.,]+)/i }

// Hours between runs. Apps Script only accepts 1, 2, 4, 6, 8 or 12, and
// doesn't guarantee the exact minute. Re-run install() after changing it.
const RUN_EVERY_HOURS = 1;

// How many hours back dryRun() looks, labeled emails included.
const DRY_RUN_HOURS = 24;

// How much of the cleaned body dryRun() logs for emails that go to review.
const DRY_RUN_BODY_LENGTH = 3000;

const LABEL_PROCESSED = 'Gastos/Procesado';
const LABEL_REVIEW = 'Gastos/Revisar';

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

// Bills ("tu factura está disponible"): electricity, gas, water, phone, etc.
// Short or common names go by domain, so they don't catch unrelated senders.
const SERVICES = [
  // Electricity
  'Cooperativa Electrica', 'Edemsa', 'Edenor', 'Edesur', 'Edelap', 'EPEC',
  // Gas
  'Ecogas', 'Metrogas', 'Naturgy', 'Camuzzi', 'Litoral Gas',
  // Water
  'AYSAM', 'AySA', 'Aguas Cordobesas', 'ABSA',
  // Phone, internet, TV
  'Movistar', 'Tuenti', { name: 'Claro', from: 'claro.com.ar' },
  { name: 'Personal', from: 'personal.com.ar' }, 'Telecentro', 'DirecTV',
  // Taxes
  'Municipio',
];

// Health insurance (prepaga).
const PREPAGAS = [
  'OSDE', 'Swiss Medical', 'Galeno', 'Medife', 'Omint', 'Medicus', 'Nobis',
  'Sancor Salud', 'Prevencion Salud', 'Avalian', 'Accord Salud',
  'Federada Salud', 'Jerarquicos Salud', 'Hospital Italiano', 'Hospital Aleman',
  'Hospital Britanico',
];

const STATUS_TO_PAY = 'Pagar';
const STATUS_PAID = 'Pagado';

// Generic patterns. The first capture group is the amount. Amounts can be
// written either way: 12.345,67 or 12,345.67. Pesos can come as "$", "ARS" or
// "AR$", but not "US$" or "U$S".
const PESOS = /(?:ARS\s*\$?|AR\$|(?<!US|U)\$)/.source;
const AMOUNT_ARS = new RegExp(`(?:total(?: a pagar)?|importe|monto|saldo actual)[^\\d$]{0,40}?${PESOS}\\s*([\\d.,]+)`, 'i');
const AMOUNT_USD = /(?:U\$S|US\$|USD)\s*([\d.,]+)/i;
const DUE_DATE = /venc(?:imiento|e)[^\d]{0,40}(\d{1,2}\/\d{1,2}\/\d{2,4})/i;

// Each key is a column of the sheet, in this order, between Detalle and USD.
// To add a category, add a key here: tabs that already exist get the new
// column appended at the end.
//
// Category defaults. `subject` must match for a message to be handled at all;
// messages from a known sender whose subject doesn't match are left untouched.
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
        skipIf: /tarjeta de cr[eé]dito|cuotas/i,
        onlyIf: /d[eé]bito|dinero (?:disponible|en cuenta)|mercado pago/i,
      },
    ],
    amount: AMOUNT_ARS,
    status: STATUS_PAID,
  },
  'Servicios': {
    entries: SERVICES,
    subject: /factura|disponible/i,
    amount: AMOUNT_ARS,
    due: DUE_DATE,
    status: STATUS_TO_PAY,
  },
  'Salud': {
    entries: PREPAGAS,
    subject: /factura|disponible|cuota/i,
    amount: AMOUNT_ARS,
    due: DUE_DATE,
    status: STATUS_TO_PAY,
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
