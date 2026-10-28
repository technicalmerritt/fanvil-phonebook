# Syncro &harr; Dojo card machine bridge

Press one button on the Syncro POS screen and the invoice amount appears on the
Dojo card machine. When the customer pays, the payment is written back against
the Syncro invoice automatically.

```
Syncro POS screen
   │  click the "Charge card machine" bookmark
   ▼
Bridge (this app, runs on the till machine)
   │  1. read the invoice balance from Syncro
   │  2. POST /payment-intents            ──►  Dojo
   │  3. POST /terminal-sessions          ──►  Dojo   ← amount lands on the machine
   │  4. poll GET /terminal-sessions/{id} ──►  Dojo   ← customer taps card
   │  5. POST /payments                   ──►  Syncro ← invoice marked paid
   ▼
Done, with an audit line written for every step
```

---

## Why a bridge, and not a button inside Syncro

Syncro is hosted software. There is no supported way to add a custom button to
its POS screen, and no way to make Syncro itself call Dojo. Anything that talks
to a card machine also has to run somewhere on your network, holding your keys.

So the bridge is a tiny service that runs on the till machine itself. You reach
it two ways:

- **The bookmarklet** (recommended) — a bookmark on the till browser's
  bookmarks bar. One click from any Syncro invoice or POS screen reads the
  invoice number off the page and opens the card-machine window for it. That is
  your "push a button" step. The setup page builds it for you.
- **The till window directly** — `http://127.0.0.1:8787/`, type or pick an
  invoice.

---

## Setup

### 1. Install

Needs Node.js 18.17 or newer. **No npm packages at all** — nothing to install
and nothing to keep patched.

```bash
cd syncro-dojo-bridge
cp .env.example .env
```

### 2. Fill in the placeholders

Everything goes in `.env`. Nothing is hard-coded anywhere in the source.

| Placeholder | What it is / where to get it |
|---|---|
| `BRIDGE_TOKEN` | **Invent this yourself.** A long random string the till UI uses to talk to the bridge. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `SYNCRO_SUBDOMAIN` | The first part of your Syncro address — `yourfirm` in `yourfirm.syncromsp.com` |
| `SYNCRO_API_KEY` | Syncro → **Admin → API Tokens → New Token**. Permissions needed: Invoices (view), Payments (view list + create) |
| `DOJO_API_KEY` | developer.dojo.tech → your app's keys. `sk_sandbox_…` to test, `sk_prod_…` for real money |
| `DOJO_SOFTWARE_HOUSE_ID` | Issued by Dojo when they onboard you as an EPOS integrator — ask your Dojo account contact |
| `DOJO_RESELLER_ID` | Issued by Dojo alongside the software-house id |
| `DOJO_TERMINAL_ID` | *Optional.* Pin one card machine. Leave blank to auto-pick an available one. The setup page lists the ids it can see |
| `SYNCRO_PAYMENT_METHOD` | Must match one of **your** Syncro payment method names, or Syncro may reject the payment. Defaults to `Credit Card` |

Everything else in `.env.example` has a sensible default and is commented.

### 3. Start it

```bash
npm start
```

### 4. Make the button

Open **http://127.0.0.1:8787/setup.html** on the till machine:

1. Paste your `BRIDGE_TOKEN` and press **Check** — this confirms the bridge can
   really reach both Syncro and Dojo, and lists the card machines it can see.
2. Drag the green **💳 Charge card machine** button onto the browser's
   bookmarks bar.

Then open any invoice in Syncro and click that bookmark.

> Tick *"skip the confirmation step"* on the setup page if you want the amount
> to go to the card machine the instant you click, with no confirm screen.

### 5. Test before going live

Keep `DOJO_API_KEY` on the `sk_sandbox_…` key and run a few sales end to end.
The till shows a **sandbox** badge whenever a test key is in use, so you can
always tell at a glance. Switch to `sk_prod_…` only once you are happy.

A good first live step is `SYNCRO_RECORD_PAYMENT=false`: the card gets charged
for real, but nothing is written to Syncro, so you can compare what Dojo
reports against what you expected before letting it touch your books.

### Keeping it running

For day-to-day use it should start with the machine:

- **Windows:** `nssm install SyncroDojoBridge "C:\Program Files\nodejs\node.exe" "C:\path\to\syncro-dojo-bridge\index.js"`, or a shortcut to `npm start` in `shell:startup`
- **Linux:** a small systemd unit running `node /path/to/index.js` with `WorkingDirectory` set to the project folder
- **macOS:** a launchd plist, same shape

---

## How it protects your money

These are the parts worth knowing about, because they are what stops a bad day
turning into a bad week.

- **The browser can never choose the amount.** The bridge reads the balance
  from Syncro itself. The till screen only *confirms* a figure; if the invoice
  changed in the meantime the charge is refused and you are told to refresh.
- **No double charging.** Only one live charge per invoice. A second attempt
  while one is running is refused with a clear message, and every Dojo call
  carries an idempotency key derived from the charge, so a retried request
  cannot create a second payment.
- **Charged-but-not-recorded is never silent.** If the card is charged and
  writing the payment to Syncro then fails, the sale stops in a loud
  `captured_not_recorded` state that says *do not charge again*, with a
  **Retry recording in Syncro** button. It also shows as a warning banner on
  the till until it is cleared, so it cannot be quietly forgotten.
- **Amounts are integers throughout.** Pence only, no floating-point money.
  `19.99` becomes `1999`, never `1998`.
- **A per-sale ceiling.** `MAX_AMOUNT_MINOR` (default £5,000) refuses anything
  larger, as a backstop against a bad invoice total.
- **Timeouts clean up after themselves.** If nobody taps a card within
  `CHARGE_TIMEOUT_MS` (default 3 minutes) the bridge cancels at the machine,
  then re-checks once in case payment landed in the last second.
- **An unknown terminal status is treated as "still waiting"**, never as
  success or failure — so if Dojo adds a status later, the bridge waits and
  shows it rather than guessing.
- **Everything is logged.** Every state change appends a line to
  `data/ledger.jsonl`, independent of Dojo's and Syncro's own records.
- **Keys stay on the machine.** The bridge binds to `127.0.0.1` by default, so
  nothing is exposed to the network. The API keys live only in `.env`, which is
  gitignored, and are never sent to the browser.

---

## Verify points

Three details could not be confirmed against live documentation while this was
built, because the session had no network access to `docs.dojo.tech` or
`api-docs.syncromsp.com`. All three are configurable or self-healing, and all
three will show up in the first sandbox test. Check them before going live:

1. **`DOJO_API_VERSION`** — set to `2024-02-05`, the value in Dojo's own
   examples, but newer samples use a later date. If Dojo returns a version
   error, change this one setting. Your Dojo portal shows the current value.
2. **`SYNCRO_BALANCE_FIELD`** — the invoice field holding the outstanding
   balance, which differs between Syncro tenants. Defaults to `balance_due`,
   and the bridge automatically falls back through `balance`, `amount_due`,
   `total_due`, `outstanding`, and finally `total − paid`. The till screen
   always prints which field the figure came from ("read from Syncro
   (balance_due)"), so check that line on your first lookup.
3. **Cancel-session path** — Dojo documents a cancel operation but not a
   verifiable path, so `cancelTerminalSession` tries
   `POST /terminal-sessions/{id}/cancel` and falls back to
   `DELETE /terminal-sessions/{id}`. Only affects the Cancel button and the
   timeout path, never taking payment. If both fail, cancel on the machine
   itself and the bridge will notice.

Also worth confirming on your tenant: `SYNCRO_PAYMENT_METHOD` must match one of
your own Syncro payment method names.

---

## Tests

```bash
npm test
```

17 tests run the whole flow against stand-in Dojo and Syncro servers — no
credentials and no network needed. They cover the happy path, declines,
cancellation, the charged-but-not-recorded recovery, double-charge refusal,
the stale-amount guard, part payments, the per-sale ceiling, and money
rounding.

---

## API

All `/api/*` calls need `Authorization: Bearer <BRIDGE_TOKEN>`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Are both Syncro and Dojo reachable with these keys? |
| `GET` | `/api/config` | Non-secret settings for the UI |
| `GET` | `/api/terminals` | Card machines Dojo can see |
| `GET` | `/api/invoices` | Unpaid invoices (`?customer_id=`, `?limit=`) |
| `GET` | `/api/quote?invoice=123` | What we would charge — touches no card machine |
| `POST` | `/api/charges` | **Push the amount to the card machine.** Body: `{ "invoice": 123, "expectedAmountMinor": 8400 }`. `amountMinor` optionally part-pays |
| `GET` | `/api/charges/{id}` | Live state of one charge (the till polls this) |
| `POST` | `/api/charges/{id}/cancel` | Cancel at the machine |
| `POST` | `/api/charges/{id}/retry-record` | Retry writing a captured payment to Syncro |
| `GET` | `/api/attention` | Charges that took money but are not recorded |
| `GET` | `/api/ledger` | Recent audit entries |

### Charge states

| State | Meaning |
|---|---|
| `starting` / `intent_created` | Preparing, nothing on the machine yet |
| `on_terminal` | Amount is on the card machine, waiting for the customer |
| `captured` | Money taken, writing to Syncro |
| `recorded` | **Done** — paid and recorded |
| `captured_not_recorded` | **Needs attention** — money taken, Syncro write failed. Retry the record; do not re-charge |
| `failed` | Declined or cancelled at the machine. No money taken |
| `cancelled` | Cancelled from the till |
| `timed_out` | Nobody paid in time; cancelled at the machine |

---

## Layout

```
syncro-dojo-bridge/
├── index.js              entry point
├── .env.example          every placeholder, commented
├── src/
│   ├── config.js         settings + fail-fast validation
│   ├── dojo.js           Dojo Pay-at-Counter client
│   ├── syncro.js         Syncro invoices + payments client
│   ├── charge.js         the state machine (idempotency, recovery)
│   ├── ledger.js         append-only audit trail
│   ├── money.js          integer pence arithmetic
│   ├── http.js           fetch wrapper with useful errors
│   └── server.js         HTTP API + static hosting
├── public/
│   ├── index.html        the till UI
│   └── setup.html        connection check + bookmarklet generator
└── tests/bridge.test.js  full flow against stand-in APIs
```

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Missing required configuration: …` | A placeholder is still unfilled in `.env` |
| Setup page: Dojo *failed* 401 | Wrong `DOJO_API_KEY`, or a sandbox key against the live base URL |
| Setup page: Dojo *failed* with a version error | See verify point 1 — change `DOJO_API_VERSION` |
| Setup page: Syncro *failed* 401 | Wrong `SYNCRO_API_KEY`, or try `SYNCRO_AUTH_SCHEME=` (empty) |
| "No Dojo card machine is reporting as Available" | Machine off or offline; or pin `DOJO_TERMINAL_ID` |
| "Could not find an outstanding balance" | See verify point 2 — set `SYNCRO_BALANCE_FIELD` |
| Syncro rejects the payment | `SYNCRO_PAYMENT_METHOD` does not match a method name in your Syncro |
| Bookmarklet does nothing | Allow pop-ups for your Syncro domain |
| Bookmarklet asks for the invoice number | It could not find one on that page — the POS screen may not show one until the invoice is saved |
