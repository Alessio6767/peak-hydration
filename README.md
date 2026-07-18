# Peak Hydration

Brand site + household water delivery subscription system. Zero dependencies —
one Node.js server, a JSON-file datastore, and three HTML pages. Runs anywhere
Node 18+ runs.

## Run it

```bash
node server.js          # serves on http://localhost:4137
node test/smoke.js      # end-to-end test of the whole subscription flow
```

| Page | URL | Who it's for |
|---|---|---|
| Brand site | `/` | Customers |
| Subscription signup | `/subscribe.html` | Customers |
| Delivery Ops dashboard | `/admin.html` | You (staff) |

## How the subscription system works

**Packages** (price per delivery, ZAR — edit in `lib/domain.js`):

| Package | Contents | Price |
|---|---|---|
| Essential | 4 × 5L still | R119 |
| Active | 2 × 5L + case of 24 × 500ml | R349 |
| Peak | 4 × 5L + case of 24 × 500ml | R409 |

**Delivery charge** (added to each debit, by frequency): weekly R199 · every
2 weeks R119 · monthly R89.

**Schedule** — customers pick a frequency (weekly, every 2 weeks or monthly)
and a fixed delivery day (Monday or Wednesday, deliveries between 8AM and 5PM).
The first delivery is the next occurrence of their day at least 3 days out;
each following delivery is exactly 7, 14 or 28 days later, so it always stays
on the same weekday.

**Areas / geotagging** — deliveries are limited to serviced areas (Centurion,
Irene, Midrand, Pretoria East — edit in `lib/domain.js`). Every subscription is
geotagged with its area centroid so the run sheet can be grouped and routed per
area.

**Billing (simulated debit orders)** — signing up accepts a debit order mandate
and opens a *simulated* bank account (opening balance R5,000 of fake money — no
real banking involved). A debit order is raised for each delivery, due 3 days
before delivery day. On the Ops dashboard, **Billing → Run debit orders**
collects everything due: sufficient balance → paid, delivery is confirmed onto
the run sheet; insufficient balance → the debit fails and the subscription is
suspended. Topping the account up re-queues the failed debit, and a successful
retry reactivates the subscription. Swap `lib/api.js`'s bank-account logic for a
real provider (e.g. Netcash / Stitch / Paystack debit orders) when you're ready
to take real money.

**The operating loop**

1. Customer subscribes on `/subscribe.html`.
2. Before a delivery day, open the Ops dashboard and run debit orders.
3. Open **Run sheet**, pick the date (Next Monday / Next Wednesday buttons), filter
   by area — it shows every stop plus the total truck load, and prints cleanly.
4. Mark each stop delivered. That schedules the next delivery and raises the
   next debit order automatically.

## API

All under `/api` (JSON). `?today=YYYY-MM-DD` on any call time-travels the
clock — handy for demos and tests.

- `GET  /api/config` — packages, areas, days, frequencies
- `POST /api/subscriptions` — create (validates everything, incl. mandate)
- `GET  /api/subscriptions?areaId=&status=`
- `POST /api/subscriptions/:id/pause|resume|cancel`
- `GET  /api/deliveries?date=&areaId=&status=` — run sheet
- `POST /api/deliveries/:id/deliver`
- `POST /api/billing/run` — process all due debit orders
- `GET  /api/billing/debit-orders|transactions|accounts`
- `POST /api/billing/accounts/:id/topup`
- `GET  /api/stats`

## Data

Everything lives in `data/db.json` (git-ignored; created on first write; set
`PEAK_DATA_DIR` to relocate). Back it up by copying the file. Bank account
numbers are stored masked — only the last 4 digits are kept.

## Before going live

- Put `/admin.html` and the write APIs behind auth (even basic auth on a
  reverse proxy).
- Replace the simulated bank with a real debit order provider.
- Serve over HTTPS.
