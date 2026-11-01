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
const RUN_EVERY_HOURS = 2;

// How many days back dryRun() looks, labeled emails included.
const DRY_RUN_DAYS = 1;

const LABEL_PROCESSED = 'Gastos/Procesado';
const LABEL_REVIEW = 'Gastos/Revisar';

// Whether processed emails are also taken out of the inbox. Emails to review
// always stay there.
const ARCHIVE_PROCESSED = false;

// Credit card statements (resumen de tarjeta).
const BANKS = [
  'Brubank',
  // "Saldo en pesos: 68.314,43" (no $), "Vencimiento: 11 Nov 26"
  {
    name: 'Galicia',
    amount: /Saldo en pesos:\s*\$?\s*([\d.,]+)/i,
    usd: /Saldo en d[oó]lares:\s*(?:U\$S|US\$|USD)?\s*([\d.,]+)/i,
    due: /Vencimiento:\s*(\d{1,2}\s+[a-z]{3}\w*\.?\s+\d{2,4})/i,
  },
  'Santander',
  'BBVA',
];

// Bills ("tu factura está disponible"): electricity, gas, water, phone, etc.
const SERVICES = ['AYSAM', 'Cooperativa Electrica', 'Ecogas'];

// Health insurance (prepaga).
const PREPAGAS = ['OSDE', 'Medife', 'Nobis', 'Medicus', 'Swiss Medical'];

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
    subject: /resumen/i,
    amount: AMOUNT_ARS,
    usd: AMOUNT_USD,
    due: DUE_DATE,
    status: STATUS_TO_PAY,
  },
  'Transporte (Auto)': {
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
