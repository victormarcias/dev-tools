// Gmail Expenses: email parsing and USD conversion.
// author: @victormarcias

const DOLAR_TARJETA_URL = 'https://dolarapi.com/v1/dolares/tarjeta';

// Returns { review: reason } when the mail can't be read, or { rows } (empty
// when it should be marked as processed without a row). A mail with both a
// pesos and a USD amount (a card statement with both balances) gives two rows:
// one in pesos, and one with the USD amount and its conversion to pesos.
function parseMessage(source, message) {
  const body = cleanBody(message);

  if (source.skipIf && source.skipIf.test(body)) return { rows: [] };
  if (source.onlyIf && !source.onlyIf.test(body)) return { review: 'onlyIf did not match' };

  const ars = source.amount ? parseAmount(firstMatch(source.amount, body)) : null;
  const usd = source.usd ? parseAmount(firstMatch(source.usd, body)) : null;
  if (!ars && !usd) return { review: 'no amount found' };

  const base = {
    date: message.getDate(),
    detail: source.name,
    category: source.category,
    due: source.due ? parseDate(firstMatch(source.due, body)) : null,
    status: source.status,
  };
  const rows = [];

  if (ars) rows.push({ ...base, ars: round2(ars), usd: null, note: '' });

  // USD goes as is in its own column, and converted into the category
  if (usd) {
    const fx = usdRate();
    let note = `USD ${usd} × ${fx.rate} (dólar tarjeta ${fx.date})`;
    if (fx.stale) note += '\nDolarApi no respondió: cotización anterior.';
    rows.push({ ...base, ars: round2(usd * fx.rate), usd, note });
  }

  return { rows };
}

// The plain text version of the email, with what gets in the way of the
// patterns removed: *bold* and _italic_ markers, and line breaks (everything
// ends up on one line, single-spaced).
function cleanBody(message) {
  return message.getPlainBody().replace(/[*_]/g, '').replace(/\s+/g, ' ').trim();
}

function firstMatch(regex, text) {
  const match = text.match(regex);
  return match ? match[1] : null;
}

// Accepts 12.345,67 / 12,345.67 / 12.345 / 1234,5: a separator followed by 1
// or 2 trailing digits starts the decimals, and every other separator to its
// left is a thousands one, whichever the format.
function parseAmount(text) {
  if (!text) return null;
  const [, integer, decimals] = text.replace(/[.,]+$/, '').match(/^(.*?)(?:[.,](\d{1,2}))?$/);
  const amount = Number(`${integer.replace(/\D/g, '') || 0}.${decimals || 0}`);
  return amount || null;
}

// Spanish and English month abbreviations, for dates like "11 Nov 26"
const MONTHS = {
  ene: 1, jan: 1, feb: 2, mar: 3, abr: 4, apr: 4, may: 5, jun: 6, jul: 7,
  ago: 8, aug: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12, dec: 12,
};

// dd/mm/yy, dd/mm/yyyy, or "11 Nov 26" / "11 noviembre 2026"
function parseDate(text) {
  if (!text) return null;
  const named = text.match(/^(\d{1,2})\s+([a-z]{3})[a-z]*\.?\s+(\d{2,4})$/i);
  const [day, month, year] = named
    ? [Number(named[1]), MONTHS[named[2].toLowerCase()], Number(named[3])]
    : text.split('/').map(Number);
  if (!month) return null;
  return new Date(year < 100 ? 2000 + year : year, month - 1, day);
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

let cachedRate = null;

// Dólar tarjeta (selling price) from DolarApi. When it fails, falls back to
// the last rate that worked.
function usdRate() {
  if (cachedRate) return cachedRate;
  const props = PropertiesService.getScriptProperties();

  try {
    const response = UrlFetchApp.fetch(DOLAR_TARJETA_URL, { muteHttpExceptions: true });
    if (response.getResponseCode() === 200) {
      const data = JSON.parse(response.getContentText());
      if (data.venta > 0) {
        cachedRate = { rate: data.venta, date: data.fechaActualizacion.slice(0, 10), stale: false };
        props.setProperty('LAST_FX', JSON.stringify(cachedRate));
        return cachedRate;
      }
    }
  } catch (error) {
    console.error(`DolarApi: ${error}`);
  }

  const last = props.getProperty('LAST_FX');
  if (!last) throw new Error('No USD rate available.');
  cachedRate = { ...JSON.parse(last), stale: true };
  return cachedRate;
}
