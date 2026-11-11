# TM Till

A fast scan-and-sell till for Technical Merritt, backed by Syncro.

Scan a barcode at any time and it lands in the sale. Type to search for items
without a barcode. Pay by card or cash. Works on a PC, an iPad or a phone, with
any barcode scanner that acts as a keyboard.

## Run it

Needs Node 22 or newer. No dependencies to install.

    cp .env.example .env    # then fill in SYNCRO_TOKEN
    npm start

Open http://localhost:8787.

The Syncro API token stays on the server. The browser never sees it.

## Modes

- `SALES_MODE=dry` (default): practice mode. Products and prices are real, but
  completing a sale sends nothing to Syncro.
- `SALES_MODE=live`: sales create an invoice and a payment in Syncro. The server
  refuses to start in live mode without `TILL_PIN`.

## What has been checked against the real account

Checked:
- Barcode lookup, including barcodes stored with stray spaces or missing a
  leading zero.
- Product search and the local catalogue copy (refreshed every 6 hours; each
  scanned item's price is re-checked against Syncro straight away).
- Reading payment methods.
- Creating an invoice.

Not yet checked. Stay in practice mode until these are:
- Adding line items with a product link, and whether stock moves.
- Recording a payment, and whether it shows in the register's daily totals.
- Printing a receipt through Syncro's print queue.

## Not built yet

- Sending the amount to the Dojo card machine. For now the cashier takes the
  payment on the terminal and confirms it on the till.
- Refunds, parked sales, attaching a named customer, end-of-day cash-up.

## Token permissions

Make a Custom Permissions token for the till only: products (list, view),
invoices (list, view, create, edit), payments (list, create), payment methods.
Nothing under RMM, scripts, assets or tickets.
