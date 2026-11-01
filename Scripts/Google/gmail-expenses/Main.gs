// Gmail Expenses: reads expense emails once a day and writes one row per
// transaction into a Google Sheet, one tab per month.
// author: @victormarcias
//
// Usage (from the Apps Script editor):
//   install()  sets up the daily trigger. Run it once, and again after
//              changing RUN_HOUR.
//   run()      processes new emails now. The trigger calls this.
//   dryRun()   logs what the last DRY_RUN_DAYS of emails would produce,
//              without labeling them or touching the sheet.

function install() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('FILE_ID')) {
    throw new Error('Missing FILE_ID in Script Properties.');
  }
  SpreadsheetApp.openById(props.getProperty('FILE_ID'));

  // Only emails received after the first install are processed.
  if (!props.getProperty('INSTALLED_AT')) {
    props.setProperty('INSTALLED_AT', String(Math.floor(Date.now() / 1000)));
  }

  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === 'run')
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger('run').timeBased().everyDays(1).atHour(RUN_HOUR).create();

  getLabelIds();
}

function run() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;

  try {
    const props = PropertiesService.getScriptProperties();
    const installedAt = Number(props.getProperty('INSTALLED_AT'));
    if (!installedAt) throw new Error('Run install() first.');

    // Triggers only guarantee the hour, so two daily runs can be more than
    // LOOKBACK_DAYS apart: always reach back to the previous run's start too.
    const startedAt = Math.floor(Date.now() / 1000);
    const lastRun = Number(props.getProperty('LAST_RUN')) || startedAt;
    const since = Math.max(installedAt, Math.min(lastRun, startedAt - LOOKBACK_DAYS * 86400));

    const spreadsheet = SpreadsheetApp.openById(props.getProperty('FILE_ID'));
    const labels = getLabelIds();
    const rowsByMonth = {};

    scanMessages(since, false, (source, id, message, result) => {
      if (result.review) {
        console.error(`${source.name} "${message.getSubject()}": ${result.review}`);
        markMessage(id, labels.review, false);
        return;
      }
      if (result.row) {
        const month = Utilities.formatDate(result.row.date, Session.getScriptTimeZone(), 'yyyy-MM');
        (rowsByMonth[month] = rowsByMonth[month] || []).push(result.row);
      }
      markMessage(id, labels.processed, ARCHIVE_PROCESSED);
    });

    // Sorted so new tabs are created in chronological order
    Object.keys(rowsByMonth).sort().forEach((month) => {
      writeRows(spreadsheet, month, rowsByMonth[month]);
    });
    props.setProperty('LAST_RUN', String(startedAt));
  } finally {
    lock.releaseLock();
  }
}

// For tuning Config.gs: one log line per email from a known sender, labeled
// or not, saying what run() would do with it.
function dryRun(days = DRY_RUN_DAYS) {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const formatDate = (date) => Utilities.formatDate(date, Session.getScriptTimeZone(), 'dd/MM/yyyy');
  let count = 0;

  const unmatched = scanMessages(since, true, (source, id, message, result) => {
    count++;
    const email = `[${source.category}] ${formatDate(message.getDate())} ${source.name} – ${message.getSubject()}`;
    if (result.review) {
      console.log(`REVIEW   ${email}\n         ${result.review}`);
    } else if (!result.row) {
      console.log(`SKIP     ${email}\n         skipIf matched`);
    } else {
      const row = result.row;
      const details = [`$ ${row.ars}`];
      if (row.usd) details.push(`USD ${row.usd}`);
      if (row.due) details.push(`vence ${formatDate(row.due)}`);
      details.push(row.status);
      console.log(`OK       ${email}\n         ${details.join(' | ')}`);
    }
  });

  unmatched.forEach((email) => console.log(`IGNORED  ${email}\n         subject didn't match`));
  console.log(`${count} handled, ${unmatched.length} ignored in the last ${days} days.`);
}

// Calls handle(source, id, message, result) once per email from a known
// sender whose subject matches. Returns the emails from known senders that no
// subject matched, for dryRun().
function scanMessages(since, includeLabeled, handle) {
  const seen = {};
  const unmatched = {};

  sources().forEach((source) => {
    findMessageIds(source, since, includeLabeled).forEach((id) => {
      // The same sender can feed two categories (Uber / Uber Eats)
      if (seen[id]) return;

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

  return Object.values(unmatched);
}

// Flattens CATEGORIES into one source per sender, with the category defaults
// applied. Fails early on incomplete entries, since Config.gs is hand-edited.
function sources() {
  const result = [];
  Object.keys(CATEGORIES).forEach((category) => {
    const { entries, ...defaults } = CATEGORIES[category];
    entries.forEach((entry) => {
      const overrides = typeof entry === 'string' ? { name: entry } : entry;
      const source = { ...defaults, from: overrides.name, ...overrides, category };
      if (!source.subject) throw new Error(`${category} / ${source.name}: missing subject pattern.`);
      if (!source.amount && !source.usd) throw new Error(`${category} / ${source.name}: missing amount pattern.`);
      if (!source.status) throw new Error(`${category} / ${source.name}: missing status.`);
      result.push(source);
    });
  });
  return result;
}
