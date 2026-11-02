// Gmail Expenses: spreadsheet writing. Every monthly tab has a header, one
// row per transaction sorted by date, and a TOTAL row at the bottom.
// author: @victormarcias
//
// Columns are matched by header name, not position, so tabs created before a
// category was added (or with columns added by hand) keep working.

const TOTAL_LABEL = 'TOTAL';
const FORMAT_DATE = 'dd/mm/yyyy';
const FORMAT_ARS = '"$ "#,##0.00';
const FORMAT_USD = '"US$ "#,##0.00';

const LEADING_COLUMNS = ['Fecha', 'Detalle'];
const TRAILING_COLUMNS = ['USD', 'Vencimiento', 'Estado'];

function writeRows(spreadsheet, month, rows) {
  const sheet = spreadsheet.getSheetByName(month) || spreadsheet.insertSheet(month);
  const tabHeaders = ensureHeaders(sheet);
  const width = tabHeaders.length;
  const col = (header) => tabHeaders.indexOf(header) + 1;

  // The TOTAL row is rebuilt after sorting
  const lastRow = sheet.getLastRow();
  if (lastRow > 1 && sheet.getRange(lastRow, col('Fecha')).getValue() === TOTAL_LABEL) {
    sheet.deleteRow(lastRow);
  }

  const values = rows.map((row) => tabHeaders.map((header) => cellValue(row, header)));
  const notes = rows.map((row) => tabHeaders.map((header) => (header === row.category ? row.note : '')));

  const firstNew = sheet.getLastRow() + 1;
  sheet.getRange(firstNew, 1, values.length, width).setValues(values).setNotes(notes);

  const dataRows = sheet.getLastRow() - 1;
  sheet.getRange(2, 1, dataRows, width).sort({ column: col('Fecha'), ascending: true });

  // Formats and the Estado dropdown cover rows added by hand too
  const column = (header) => sheet.getRange(2, col(header), dataRows, 1);
  column('Fecha').setNumberFormat(FORMAT_DATE);
  column('Vencimiento').setNumberFormat(FORMAT_DATE);
  column('USD').setNumberFormat(FORMAT_USD);
  amountHeaders().forEach((header) => column(header).setNumberFormat(FORMAT_ARS));
  column('Estado').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList([STATUS_TO_PAY, STATUS_PAID], true).build()
  );

  writeTotalRow(sheet, col, width, dataRows);
}

// Writes the header of a new tab, or appends the columns an existing tab is
// missing. Returns the tab's headers.
function ensureHeaders(sheet) {
  const lastColumn = sheet.getLastColumn();
  const current = lastColumn ? sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(String) : [];
  const missing = headers().filter((header) => !current.includes(header));
  if (missing.length) {
    sheet.getRange(1, current.length + 1, 1, missing.length).setValues([missing]);
  }

  const all = current.concat(missing);
  sheet.getRange(1, 1, 1, all.length).setFontWeight('bold');
  sheet.setFrozenRows(1);
  return all;
}

function cellValue(row, header) {
  switch (header) {
    case 'Fecha': return row.date;
    case 'Detalle': return row.detail;
    case 'USD': return row.usd || '';
    case 'Vencimiento': return row.due || '';
    case 'Estado': return row.status;
    default: return header === row.category ? row.ars : '';
  }
}

// Per-column sums for every category and USD; Detalle holds the grand total
// in pesos (USD is already included, converted, in the categories).
function writeTotalRow(sheet, col, width, dataRows) {
  const totalRow = dataRows + 2;
  const cell = (header) => sheet.getRange(totalRow, col(header));
  const sumOf = (header) => `=SUM(${sheet.getRange(2, col(header), dataRows, 1).getA1Notation()})`;

  sheet.getRange(totalRow, 1, 1, width).clearDataValidations().setFontWeight('bold');
  cell('Fecha').setValue(TOTAL_LABEL);

  const categoryCells = amountHeaders().map((header) => cell(header).getA1Notation());
  cell('Detalle').setFormula(`=SUM(${categoryCells.join(',')})`).setNumberFormat(FORMAT_ARS);
  cell('USD').setFormula(sumOf('USD')).setNumberFormat(FORMAT_USD);
  amountHeaders().forEach((header) => {
    cell(header).setFormula(sumOf(header)).setNumberFormat(FORMAT_ARS);
  });
}

// Expected columns: the categories go in the same order as in CATEGORIES.
function headers() {
  return [...LEADING_COLUMNS, ...amountHeaders(), ...TRAILING_COLUMNS];
}

function amountHeaders() {
  return Object.keys(CATEGORIES);
}
