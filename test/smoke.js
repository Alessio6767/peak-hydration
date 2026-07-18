// End-to-end smoke test: signup → billing run → run sheet → deliver →
// next cycle → failed debit → top-up → recovery → pause/cancel.
// Run with: node test/smoke.js  (uses a throwaway data dir + port)

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 4790;
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'peak-test-'));

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ok  ' + msg); }
  else { failed++; console.error('FAIL  ' + msg); }
}

const get = (u) => fetch(BASE + u).then((r) => r.json());
async function post(u, body) {
  const r = await fetch(BASE + u, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : null,
  });
  return { status: r.status, data: await r.json() };
}

const signup = (over = {}) => ({
  name: 'Thabo Mokoena', email: 'thabo@example.com', phone: '0821234567',
  street: '12 Waterberg Street, Eldoraigne', areaId: 'centurion',
  packageId: 'peak', frequency: 'biweekly', deliveryDay: 'friday',
  mandateAccepted: true,
  bank: { bankName: 'FNB', accountHolder: 'T Mokoena', accountNumber: '62012345678', branchCode: '250655', ...(over.bank || {}) },
  ...over,
});

async function main() {
  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT, PEAK_DATA_DIR: DATA_DIR },
    stdio: 'ignore',
  });
  await new Promise((r) => setTimeout(r, 600));

  try {
    // config
    const cfg = await get('/api/config');
    assert(Object.keys(cfg.packages).length === 3, 'config exposes exactly 3 packages');
    assert(cfg.areas.centurion && cfg.areas.centurion.lat < 0, 'Centurion area is geotagged');
    assert(cfg.deliveryDays.monday && cfg.deliveryDays.friday && Object.keys(cfg.deliveryDays).length === 2, 'delivery days are Monday and Friday only');

    // validation
    const bad = await post('/api/subscriptions', signup({ mandateAccepted: false, areaId: 'sandton' }));
    assert(bad.status === 400 && bad.data.errors.length >= 2, 'invalid signup rejected with field errors');

    // signup
    const s1 = await post('/api/subscriptions', signup());
    assert(s1.status === 201, 'valid signup creates subscription');
    const sub = s1.data.subscription;
    assert(sub.geotag.areaId === 'centurion', 'subscription geotagged to Centurion centroid');
    assert(new Date(s1.data.firstDelivery + 'T12:00:00Z').getUTCDay() === 5, 'first delivery lands on a Friday');
    assert(s1.data.firstDebit.amount === 680, 'first debit equals Peak package price (R680)');
    assert(sub.mandate.accountNumberMasked.startsWith('****'), 'account number stored masked');

    // billing run collects the first debit (time-travel to its due date via ?today=)
    const due1 = (await get('/api/billing/debit-orders?status=pending')).debitOrders
      .find((d) => d.subscriptionId === sub.id).dueDate;
    const run1 = (await post('/api/billing/run?today=' + due1)).data;
    assert(run1.collected === 1 && run1.totalCollected === 680, 'billing run collects the first debit order');
    let dels = (await get('/api/deliveries?areaId=centurion')).deliveries;
    assert(dels.length === 1 && dels[0].status === 'scheduled', 'paid delivery appears on Centurion run sheet as scheduled');
    assert(dels[0].contents.length === 2, 'run sheet lists package contents (5L + cases)');

    // deliver → next cycle scheduled 14 days later with a new debit order
    const dl1 = dels[0];
    const done = (await post(`/api/deliveries/${dl1.id}/deliver`)).data;
    assert(done.delivery.status === 'delivered', 'delivery can be marked delivered');
    const expectedNext = new Date(dl1.date + 'T12:00:00Z');
    expectedNext.setUTCDate(expectedNext.getUTCDate() + 14);
    assert(done.nextDeliveryDate === expectedNext.toISOString().slice(0, 10), 'next delivery is exactly 14 days later (biweekly)');
    const pendingDOs = (await get('/api/billing/debit-orders?status=pending')).debitOrders;
    assert(pendingDOs.some((d) => d.subscriptionId === sub.id), 'a new debit order is raised for the next cycle');

    // low-balance signup → failed debit → suspension → top-up → recovery
    const s2 = await post('/api/subscriptions', signup({
      email: 'poor@example.com', name: 'No Funds', frequency: 'monthly', deliveryDay: 'monday',
      areaId: 'midrand', packageId: 'essential', bank: { openingBalance: 10, accountNumber: '1122334455', bankName: 'Capitec', accountHolder: 'N Funds', branchCode: '470010' },
    }));
    assert(new Date(s2.data.firstDelivery + 'T12:00:00Z').getUTCDay() === 1, 'second sub first delivery lands on a Monday');
    const due2 = (await get('/api/billing/debit-orders?status=pending')).debitOrders
      .find((d) => d.subscriptionId === s2.data.subscription.id).dueDate;
    const run2 = (await post('/api/billing/run?today=' + due2)).data;
    assert(run2.failed >= 1, 'debit against low-balance account fails');
    const sub2 = (await get('/api/subscriptions/' + s2.data.subscription.id)).subscription;
    assert(sub2.status === 'suspended', 'failed debit suspends the subscription');
    const accounts = (await get('/api/billing/accounts')).accounts;
    const poorAcc = accounts.find((a) => a.accountHolder === 'N Funds');
    await post(`/api/billing/accounts/${poorAcc.id}/topup`, { amount: 1000 });
    const run3 = (await post('/api/billing/run?today=' + due2)).data;
    assert(run3.collected === 1, 'after top-up the failed debit is collected on retry');
    const sub2b = (await get('/api/subscriptions/' + s2.data.subscription.id)).subscription;
    assert(sub2b.status === 'active', 'successful retry reactivates the subscription');

    // pause / cancel
    await post(`/api/subscriptions/${sub.id}/pause`);
    assert((await get('/api/subscriptions/' + sub.id)).subscription.status === 'paused', 'subscription can be paused');
    await post(`/api/subscriptions/${sub.id}/resume`);
    await post(`/api/subscriptions/${sub.id}/cancel`);
    const cancelled = (await get('/api/subscriptions/' + sub.id)).subscription;
    assert(cancelled.status === 'cancelled' && cancelled.nextDeliveryDate === null, 'cancel voids the subscription and its next delivery');

    // stats
    const stats = await get('/api/stats');
    assert(stats.activeSubscriptions === 1 && stats.totalCollected === 680 + 260, 'stats reflect active count and total collected');

    // static pages + datastore protection
    for (const p of ['/', '/subscribe.html', '/admin.html']) {
      const r = await fetch(BASE + p);
      assert(r.status === 200, `${p} serves`);
    }
    assert((await fetch(BASE + '/data/db.json')).status === 403, 'datastore is not served over HTTP');
  } finally {
    server.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
