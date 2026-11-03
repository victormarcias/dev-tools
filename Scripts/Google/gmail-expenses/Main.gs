// Gmail Expenses: reads expense emails every hour and writes one row per
// transaction into a Google Sheet, one tab per month.
// author: @victormarcias
//
// Usage (from the Apps Script editor):
//   install()  sets up the trigger that calls run() every RUN_EVERY_HOURS.
//              Run it once, and again after changing RUN_EVERY_HOURS.
//   run()      processes every inbox email that isn't labeled yet, however
//              old: from a known sender, or a payment confirmation from any
//              other. The trigger calls this; it can also be run by hand at
//              any time.
//   dryRun()   logs what the last DRY_RUN_HOURS of emails would produce,
//              without labeling them or touching the sheet.

function install() {
  openSpreadsheet();
  labelId();

  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === 'run')
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger('run').timeBased().everyHours(RUN_EVERY_HOURS).create();
}

function openSpreadsheet() {
  const fileId = PropertiesService.getScriptProperties().getProperty('FILE_ID');
  if (!fileId) throw new Error('Missing FILE_ID in Script Properties.');
  return SpreadsheetApp.openById(fileId);
}

// Apps Script stops any execution at 6 minutes. Scanning stops after this
// long, so there's time left to write the rows and label the emails; whatever
// wasn't reached is picked up by the next run.
const TIME_BUDGET_MS = 4 * 60 * 1000;

function run() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;

  try {
    const spreadsheet = openSpreadsheet();
    const label = labelId();
    const deadline = Date.now() + TIME_BUDGET_MS;
    const rows = [];
    const handled = [];

    // Unreadable emails are labeled too: the log is the only trace of them
    const finished = scanMessages(null, false, (source, id, message, result) => {
      if (result.review) console.error(`${logName(source, message)} "${message.getSubject()}": ${result.review}`);
      else rows.push(...result.rows);
      handled.push(id);
    }, deadline).finished;

    // Everything goes to the tab of the month the run happens in, not the
    // email's: a bill sent on the 31st is paid next month, so it belongs there.
    // Rows first, labels after: if writing fails, the emails stay unlabeled
    // and the next run retries them instead of losing them.
    if (rows.length) {
      const month = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
      writeRows(spreadsheet, month, rows);
    }
    markMessages(handled, label);

    if (!finished) {
      console.warn(`Time budget reached after ${handled.length} emails: run() again to continue.`);
    }
  } finally {
    lock.releaseLock();
  }
}

// For tuning Categories.gs: one log line per email run() would handle,
// labeled or not, saying what it would do with it.
function dryRun(hours = DRY_RUN_HOURS) {
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  const formatDate = (date) => Utilities.formatDate(date, Session.getScriptTimeZone(), 'dd/MM/yyyy');
  let count = 0;

  const { unmatched } = scanMessages(since, true, (source, id, message, result) => {
    count++;
    const email = `[${source.category}] ${formatDate(message.getDate())} ${logName(source, message)} – ${message.getSubject()}`;
    if (result.review) {
      // The cleaned body is what the patterns run against, and it often
      // differs from how the email looks.
      const body = JSON.stringify(cleanBody(message).slice(0, DRY_RUN_BODY_LENGTH));
      console.log(`REVIEW   ${email}\n         ${result.review}\n         body: ${body}`);
    } else if (!result.rows.length) {
      console.log(`SKIP     ${email}\n         skipIf matched`);
    } else {
      result.rows.forEach((row, index) => {
        const details = [`$ ${row.ars}`];
        if (row.usd) details.push(`USD ${row.usd}`);
        if (row.due) details.push(`vence ${formatDate(row.due)}`);
        details.push(row.status);
        const prefix = index ? '         ' : `OK       ${email}\n         `;
        console.log(`${prefix}${details.join(' | ')}`);
      });
    }
  });

  unmatched.forEach((email) => console.log(`IGNORED  ${email}\n         subject didn't match`));
  console.log(`${count} handled, ${unmatched.length} ignored in the last ${hours} hours.`);
}

// Who the email is from, for the logs: an `anySender` source's name says
// nothing about it
function logName(source, message) {
  return source.anySender ? `${source.name} (${senderName(message)})` : source.name;
}

// Calls handle(source, id, message, result) once per inbox email from a known
// sender whose subject matches, or from any other sender for `anySender`
// sources (`since`: unix seconds, or null for no limit). Stops early once
// `deadline` (ms timestamp) passes. Returns whether it got through every
// email, and the emails from known senders that no subject matched, for
// dryRun().
function scanMessages(since, includeLabeled, handle, deadline = Infinity) {
  const seen = {};
  const unmatched = {};
  let finished = true;
  // Known senders, scanned or not: `anySender` sources leave their emails alone
  // (a utility's own receipt would double the wallet payment)
  const known = sources().filter((source) => !source.anySender);
  const isKnown = (from) => known.some((source) => sameName(from, source.from));
  // `anySender` last, so the known senders claim their emails first
  const scanned = sources()
    .filter((source) => !source.viaPayments)
    .sort((a, b) => Boolean(a.anySender) - Boolean(b.anySender));

  scanned.forEach((source) => {
    if (!finished) return;
    findMessageIds(source, since, includeLabeled).forEach((id) => {
      // The same sender can feed two categories (Uber / Uber Eats)
      if (!finished || seen[id]) return;
      if (Date.now() > deadline) {
        finished = false;
        return;
      }

      const message = GmailApp.getMessageById(id);
      if (source.anySender && isKnown(message.getFrom())) return;
      const subject = message.getSubject();
      if (!source.subject.test(subject) || (source.excludeSubject && source.excludeSubject.test(subject))) {
        // Any email with "pago" in the subject: too many to list
        if (!source.anySender) unmatched[id] = `${source.name} – ${subject}`;
        return;
      }
      seen[id] = true;
      delete unmatched[id];

      let result;
      try {
        result = parseMessage(source, message);
      } catch (error) {
        result = { review: String(error) };
      }
      handle(source, id, message, result);
    });
  });

  return { finished, unmatched: Object.values(unmatched) };
}

let cachedSources = null;

// Flattens CATEGORIES into one source per sender, with the category defaults
// applied. Fails early on incomplete entries, since Categories.gs is hand-edited.
function sources() {
  if (cachedSources) return cachedSources;
  if (!CATEGORIES[PAYMENTS.category]) {
    throw new Error(`PAYMENTS: unknown category "${PAYMENTS.category}".`);
  }
  const aliases = transfers();
  Object.keys(aliases).forEach((alias) => {
    if (!CATEGORIES[aliases[alias]]) {
      throw new Error(`TRANSFERS / ${alias}: unknown category "${aliases[alias]}".`);
    }
  });
  const groups = Object.keys(CATEGORIES).map((category) => ({ ...CATEGORIES[category], category, group: category }));
  // Payments last: a wallet can also send card statements
  groups.push({ ...PAYMENTS, payment: true, group: 'PAYMENTS' });

  const result = [];
  groups.forEach(({ entries, category, group, ...defaults }) => {
    entries.forEach((entry) => {
      const overrides = typeof entry === 'string' ? { name: entry } : entry;
      // Only a payment entry can pick its own category (where its payments go
      // when the payee isn't known)
      const source = { ...defaults, from: overrides.name, ...overrides };
      source.category = (defaults.payment && overrides.category) || category;
      const fail = (problem) => { throw new Error(`${group} / ${source.name}: ${problem}.`); };

      if (!CATEGORIES[source.category]) fail(`unknown category "${source.category}"`);
      // Never scanned: only used to categorize payments
      if (!source.viaPayments) {
        if (!source.subject) fail('missing subject pattern');
        if (!source.amount && !source.usd) fail('missing amount pattern');
        if (!source.status) fail('missing status');
        if (source.anySender && !source.query) fail('missing query');
      }
      result.push(source);
    });
  });
  cachedSources = result;
  return result;
}
