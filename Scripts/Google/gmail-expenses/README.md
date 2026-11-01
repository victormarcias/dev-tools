## Gmail Expenses

📧 Google Apps Script that reads expense emails from Gmail once a day and writes
them into a Google Sheet, one row per transaction. Made for Argentina: amounts
like `$ 12.345,67`, dólar tarjeta, local senders.

It only reads the email body, never PDF attachments.

### What it detects

| Column | Senders | Estado |
|---|---|---|
| Tarjetas | `BANKS` (credit card statements: one row with the statement total) | Pagar |
| Transporte (Auto) | Uber, Cabify | Pagado |
| Compras | MercadoLibre, only debit / account money purchases | Pagado |
| Servicios | `SERVICES` ("tu factura está disponible") | Pagar |
| Salud | `PREPAGAS` (health insurance) | Pagar |
| Delivery | PedidosYa (orders and Plus), Rappi (orders and Prime), Uber Eats | Pagado |

### The sheet

One tab per month (`2026-11`), every tab following
[gastos.example.csv](gastos.example.csv) (with the default categories):

- One row per transaction, sorted by email date, with the amount in its
  category column.
- `USD`: the original amount of USD charges. The same charge is also added to
  its category in pesos, at the dólar tarjeta from [DolarApi](https://dolarapi.com).
  The rate used is in the cell's note; if DolarApi is down, the last rate that
  worked is used and the note says so.
- `Vencimiento`: due date for bills and statements.
- `Estado`: Pagar / Pagado dropdown. Bills and statements come in as Pagar;
  switch them by hand once paid.
- `TOTAL` row at the bottom: per-column sums, and the grand total in pesos under
  `Detalle`. It's rebuilt on every run, so rows added by hand are included.

### Emails

- Processed: labeled `Gastos/Procesado`. Left in the inbox unless
  `ARCHIVE_PROCESSED` is on.
- From a known sender but the amount couldn't be read: labeled `Gastos/Revisar`
  and left in the inbox, no row added. After fixing the patterns, remove the
  label and it'll be picked up again if it's within `LOOKBACK_DAYS`.
- Only emails received after the first `install()` are processed.

### ⚠️ Double counting

Card statements are added to the total. Anything paid with a credit card that
also has its own email (an Uber, a bill, the prepaga) is counted twice: once in
its column and once inside the statement. MercadoLibre already skips credit
card purchases for this reason; the rest don't, since they're assumed to be
paid with debit or account money.

### Setup

1. Create a Google Sheet (set *File → Settings → Locale* to Argentina) and copy
   its ID from the URL: `docs.google.com/spreadsheets/d/<FILE_ID>/edit`.
2. Create an empty project at https://script.google.com.
3. Upload the code, with either option below.
4. In the Apps Script editor: *Project Settings → Script Properties* → add
   `FILE_ID` with the sheet's ID.
5. Run `install()` from the editor and accept the permissions. That creates the
   daily trigger at `RUN_HOUR`.

To process right away, run `run()`.

#### Option A: clasp (from the terminal)

[clasp](https://github.com/google/clasp) is Google's CLI for Apps Script:
`clasp push` uploads the local files, `clasp pull` downloads the ones in the
web editor. Handy when editing `Config.gs` often, and it keeps the repo and
what runs in Google in sync.

1. Install it, log in, and enable the Apps Script API at
   https://script.google.com/home/usersettings:
   ```bash
   npm install -g @google/clasp
   clasp login
   ```
2. Copy the project's Script ID (*Project Settings*). Copy `.clasp.example.json`
   to `.clasp.json` (git-ignored), set the ID and push. `clasp create` is
   avoided on purpose: it overwrites `appsscript.json`.
   ```bash
   cp .clasp.example.json .clasp.json
   clasp push --force
   ```

After that, every change is a `clasp push`, and `clasp open` opens the editor.

#### Option B: copy by hand (from the web)

1. In the editor, create one script file per `.gs` file, with the same names
   (`Config`, `Gmail`, `Main`, `Parse`, `Sheet`), and paste each one's
   content.
2. *Project Settings* → check *Show "appsscript.json" manifest file in editor*,
   then paste the content of [appsscript.json](appsscript.json) into it. Don't
   skip it: it sets the time zone and enables the Gmail API.

Changes made in the web editor don't reach the repo: copy them back by hand,
or with `clasp pull` if you set up clasp later.

> ⚠️ Pick one side to edit. `clasp push` overwrites whatever was changed in
> the web editor, and `clasp pull` overwrites local changes.

### Configuration

Everything lives in [Config.gs](Config.gs); only IDs go in Script Properties.

- `RUN_HOUR`: hour of the daily run. Run `install()` again after changing it.
- `ARCHIVE_PROCESSED`: also archive processed emails (default `false`, labels
  only).
- `LOOKBACK_DAYS`: how many days back each run looks (default 1). A run also
  always reaches back to the start of the previous successful run, so missed
  runs and trigger time jitter don't lose emails.
- `DRY_RUN_DAYS`: how many days back `dryRun()` looks (default 1). Raise it
  to test patterns against older emails.
- `BANKS`, `SERVICES`, `PREPAGAS`: senders, as they appear in the From name or
  address.
- Patterns: each category has default regexes for `subject`, `amount`, `usd`
  and `due` (the first capture group is the value). Any list entry can be an
  object that overrides them for that sender:
  ```js
  const SERVICES = [
    'AYSAM',
    { name: 'Ecogas', from: 'ecogas.com.ar', amount: /Importe\s*\$\s*([\d.,]+)/i },
  ];
  ```
- Amounts: the captured number can use either format (`12.345,67` or
  `12,345.67`): a separator followed by 1 or 2 trailing digits starts the
  decimals, the rest are thousands separators. To accept `$`, `ARS` and `AR$`
  (but not `US$`) in a custom pattern, build it with `PESOS`:
  `` new RegExp(`Importe\\s*${PESOS}\\s*([\\d.,]+)`, 'i') ``.
- `skipIf` / `onlyIf`: body patterns. `skipIf` marks the email as processed without a row;
  if `onlyIf` doesn't match, the email goes to review.

The default patterns are generic: tune them with the emails that end up in
`Gastos/Revisar`.

#### Adding a category

Add a key to `CATEGORIES`: the key is the column name, and the order of the
keys is the order of the columns (between `Detalle` and `USD`). It needs
`entries`, a `subject` and an `amount` (or `usd`) pattern and a `status`,
either at the category level or in each entry; `run()` fails with a clear
message if something is missing.

```js
'Mascotas': {
  entries: [{ name: 'Puppis', from: 'puppis.com.ar', subject: /pedido|compra/i }],
  amount: AMOUNT_ARS,
  status: STATUS_PAID,
},
```

Columns are matched by header name, so existing tabs keep working: missing
columns are appended at the end, and columns added by hand are left alone.
Renaming a category creates a new column; rename the header in existing tabs
too.

#### Testing changes

After editing `Config.gs` (and `clasp push`, if using clasp), run `dryRun()`
from the editor. It looks at the last `DRY_RUN_DAYS` days of emails from every known
sender, labeled or not, and logs what `run()` would do with each one, without
labeling anything or touching the sheet:

```
OK       [Salud] 12/11/2026 OSDE – Tu factura está disponible
         $ 185000 | vence 22/11/2026 | Pagar
REVIEW   [Servicios] 05/11/2026 Ecogas – Tu factura está disponible
         no amount found
SKIP     [Compras] 08/11/2026 MercadoLibre – Compraste Auriculares
         skipIf matched
IGNORED  Rappi – 50% OFF en tu próximo pedido
         subject didn't match
```
