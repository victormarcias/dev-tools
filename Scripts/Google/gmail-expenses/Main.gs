// Gmail Expenses: reads expense emails every few hours and writes one row per
// transaction into a Google Sheet, one tab per month.
// author: @victormarcias
//
// Usage (from the Apps Script editor):
//   install()  sets up the trigger that calls run() every RUN_EVERY_HOURS.
//              Run it once, and again after changing RUN_EVERY_HOURS.
//   run()      processes every inbox email from a known sender that isn't
//              labeled yet, however old. The trigger calls this; it can also
//              be run by hand at any time.
//   dryRun()   logs what the last DRY_RUN_HOURS of emails would produce,
//              without labeling them or touching the sheet.

function install() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('FILE_ID')) {
    throw new Error('Missing FILE_ID in Script Properties.');
  }
  SpreadsheetApp.openById(props.getProperty('FILE_ID'));

  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === 'run')
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger('run').timeBased().everyHours(RUN_EVERY_HOURS).create();

  getLabelIds();
}

// Apps Script stops any execution at 6 minutes. Scanning stops after this
// long, so there's time left to write the rows and label the emails; whatever
// wasn't reached is picked up by the next run.
const TIME_BUDGET_MS = 4 * 60 * 1000;

function run() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;

  try {
    const props = PropertiesService.getScriptProperties();
    if (!props.getProperty('FILE_ID')) {
      throw new Error('Missing FILE_ID in Script Properties.');
    }
    const spreadsheet = SpreadsheetApp.openById(props.getProperty('FILE_ID'));
    const labels = getLabelIds();
    const deadline = Date.now() + TIME_BUDGET_MS;
    const rows = [];
    const processed = [];

    const finished = scanMessages(null, false, (source, id, message, result) => {
      if (result.review) {
        console.error(`${source.name} "${message.getSubject()}": ${result.review}`);
        markMessage(id, labels.review);
        return;
      }
      rows.push(...result.rows);
      processed.push(id);
    }, deadline).finished;

    // Everything goes to the tab of the month the run happens in, not the
    // email's: a bill sent on the 31st is paid next month, so it belongs there.
    // Rows first, labels after: if writing fails, the emails stay unlabeled
    // and the next run retries them instead of losing them.
    if (rows.length) {
      const month = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
      writeRows(spreadsheet, month, rows);
    }
    processed.forEach((id) => markMessage(id, labels.processed));

    if (!finished) {
      console.warn(`Time budget reached after ${processed.length} emails: run() again to continue.`);
    }
  } finally {
    lock.releaseLock();
  }
}

// For tuning Categories.gs: one log line per email from a known sender, labeled
// or not, saying what run() would do with it.
function dryRun(hours = DRY_RUN_HOURS) {
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  const formatDate = (date) => Utilities.formatDate(date, Session.getScriptTimeZone(), 'dd/MM/yyyy');
  let count = 0;

  const { unmatched } = scanMessages(since, true, (source, id, message, result) => {
    count++;
    const email = `[${source.category}] ${formatDate(message.getDate())} ${source.name} – ${message.getSubject()}`;
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

// Calls handle(source, id, message, result) once per inbox email from a known
// sender whose subject matches (`since`: unix seconds, or null for no limit).
// Stops early once `deadline` (ms timestamp) passes. Returns whether it got
// through every email, and the emails from known senders that no subject
// matched, for dryRun().
function scanMessages(since, includeLabeled, handle, deadline = Infinity) {
  const seen = {};
  const unmatched = {};
  let finished = true;

  sources().filter((source) => !source.viaPayments).forEach((source) => {
    if (!finished) return;
    findMessageIds(source, since, includeLabeled).forEach((id) => {
      // The same sender can feed two categories (Uber / Uber Eats)
      if (!finished || seen[id]) return;
      if (Date.now() > deadline) {
        finished = false;
        return;
      }

      const message = GmailApp.getMessageById(id);
      const subject = message.getSubject();
      if (!source.subject.test(subject) || (source.excludeSubject && source.excludeSubject.test(subject))) {
        unmatched[id] = `${source.name} – ${subject}`;
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

// Flattens CATEGORIES into one source per sender, with the category defaults
// applied. Fails early on incomplete entries, since Categories.gs is hand-edited.
function sources() {
  if (!CATEGORIES[PAYMENTS.category]) {
    throw new Error(`PAYMENTS: unknown category "${PAYMENTS.category}".`);
  }
  const aliases = transfers();
  Object.keys(aliases).forEach((alias) => {
    if (!CATEGORIES[aliases[alias]]) {
      throw new Error(`TRANSFERS / ${alias}: unknown category "${aliases[alias]}".`);
    }
  });
  const groups = Object.keys(CATEGORIES).map((category) => ({ ...CATEGORIES[category], category }));
  // Payments last: a wallet can also send card statements
  groups.push({ ...PAYMENTS, payment: true });

  const result = [];
  groups.forEach(({ entries, category, ...defaults }) => {
    entries.forEach((entry) => {
      const overrides = typeof entry === 'string' ? { name: entry } : entry;
      const source = { ...defaults, from: overrides.name, ...overrides, category };
      // Never scanned: only used to categorize payments
      if (source.viaPayments) {
        result.push(source);
        return;
      }
      if (!source.subject) throw new Error(`${category} / ${source.name}: missing subject pattern.`);
      if (!source.amount && !source.usd) throw new Error(`${category} / ${source.name}: missing amount pattern.`);
      if (!source.status) throw new Error(`${category} / ${source.name}: missing status.`);
      result.push(source);
    });
  });
  return result;
}
