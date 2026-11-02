// Gmail Expenses: Gmail access.
// author: @victormarcias
//
// Labels are applied per message with the Gmail advanced service: GmailApp
// only labels whole threads, and monthly emails (statements, bills) usually
// end up in the same thread.

function findMessageIds(source, since, includeLabeled) {
  const terms = ['in:inbox', `from:"${source.from}"`];
  if (since) terms.push(`after:${since}`);
  if (!includeLabeled) {
    terms.push(`-label:${searchName(LABEL_PROCESSED)}`, `-label:${searchName(LABEL_REVIEW)}`);
  }
  const query = terms.join(' ');

  const ids = [];
  let pageToken;
  do {
    const page = Gmail.Users.Messages.list('me', { q: query, pageToken });
    (page.messages || []).forEach((message) => ids.push(message.id));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return ids;
}

function markMessage(id, labelId) {
  Gmail.Users.Messages.modify({ addLabelIds: [labelId] }, 'me', id);
}

function getLabelIds() {
  [LABEL_PROCESSED, LABEL_REVIEW].forEach((name) => {
    // Parents first, so they show up nested
    const parts = name.split('/');
    parts.forEach((_, index) => {
      const path = parts.slice(0, index + 1).join('/');
      if (!GmailApp.getUserLabelByName(path)) GmailApp.createLabel(path);
    });
  });

  const labels = Gmail.Users.Labels.list('me').labels;
  const idOf = (name) => labels.find((label) => label.name === name).id;
  return { processed: idOf(LABEL_PROCESSED), review: idOf(LABEL_REVIEW) };
}

// Gmail search writes label "A/B c" as a-b-c
function searchName(label) {
  return label.toLowerCase().replace(/[\/\s]/g, '-');
}
