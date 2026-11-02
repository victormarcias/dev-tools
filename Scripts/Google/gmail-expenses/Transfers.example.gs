// Gmail Expenses: transfer recipients. Template: copy it to Transfers.gs,
// which is git-ignored, and fill it in there.
// author: @victormarcias
//
// Each key is the alias you transfer to (or anything else that identifies the
// recipient in the payment email, like their CVU), and its value the category
// the transfer goes to. Aliases match ignoring case, accents and spaces.
// Transfers to anyone else go to PAYMENTS.category.

const TRANSFERS = {
  'x.y.z': 'Hogar',
};
