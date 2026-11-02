// Gmail Expenses: configuration. Senders, categories and their patterns are
// in Categories.gs; transfer aliases, in Transfers.gs.
// author: @victormarcias
//
// Everything here is meant to be edited by hand. IDs (the spreadsheet's
// FILE_ID) never go here: they live in Script Properties.

// Hours between runs. Apps Script only accepts 1, 2, 4, 6, 8 or 12, and
// doesn't guarantee the exact minute. Re-run install() after changing it.
const RUN_EVERY_HOURS = 1;

// How many hours back dryRun() looks, labeled emails included.
const DRY_RUN_HOURS = 24;

// How much of the cleaned body dryRun() logs for emails that go to review.
const DRY_RUN_BODY_LENGTH = 3000;

// Which dollar USD amounts are converted at (selling price, from DolarApi):
// 'cripto' or 'blue'. Any other dolarapi.com/v1/dolares/<type> works too.
const USD_RATE = 'cripto';

const LABEL_PROCESSED = 'Gastos/Procesado';
const LABEL_REVIEW = 'Gastos/Revisar';
