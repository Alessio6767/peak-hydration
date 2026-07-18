// JSON API for subscriptions, deliveries and mock debit-order billing.

const store = require('./store');
const D = require('./domain');

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function maskAccount(num) {
  const s = String(num).replace(/\s/g, '');
  return '****' + s.slice(-4);
}

function publicSubscription(sub) {
  const area = D.AREAS[sub.areaId];
  const pkg = D.PACKAGES[sub.packageId];
  return {
    ...sub,
    areaName: area.name,
    packageName: pkg.name,
    pricePerDelivery: pkg.pricePerDelivery,
    contents: D.packageContents(sub.packageId),
    frequencyName: D.FREQUENCIES[sub.frequency].name,
    deliveryDayName: D.DELIVERY_DAYS[sub.deliveryDay].name,
  };
}

function openDelivery(db, subId) {
  return db.deliveries.find(
    (dl) => dl.subscriptionId === subId && (dl.status === 'pending_payment' || dl.status === 'scheduled')
  );
}

// Create the next delivery + its debit order for a subscription.
function scheduleCycle(db, sub, deliveryDate, today) {
  const delivery = {
    id: store.nextId('del'),
    subscriptionId: sub.id,
    date: deliveryDate,
    status: 'pending_payment',
    deliveredAt: null,
  };
  const debit = {
    id: store.nextId('do'),
    subscriptionId: sub.id,
    deliveryId: delivery.id,
    amount: D.PACKAGES[sub.packageId].pricePerDelivery,
    dueDate: D.debitDueDate(deliveryDate, today),
    status: 'pending',
    attempts: 0,
    processedAt: null,
  };
  delivery.debitOrderId = debit.id;
  db.deliveries.push(delivery);
  db.debitOrders.push(debit);
  sub.nextDeliveryDate = deliveryDate;
  return { delivery, debit };
}

function createSubscription(body, today) {
  const errors = D.validateSubscriptionInput(body);
  if (errors.length) return { code: 400, out: { errors } };

  const db = store.load();
  const area = D.AREAS[body.areaId];
  const accountNumber = String(body.bank.accountNumber).replace(/\s/g, '');

  // Mock bank: every mandate opens a simulated account the debit
  // orders are collected against. Opening balance is fake money.
  const account = {
    id: store.nextId('acc'),
    bankName: body.bank.bankName.trim(),
    accountHolder: body.bank.accountHolder.trim(),
    accountNumberMasked: maskAccount(accountNumber),
    branchCode: String(body.bank.branchCode).trim(),
    balance: Number.isFinite(body.bank.openingBalance)
      ? Math.max(0, Math.min(100000, body.bank.openingBalance))
      : 5000,
  };

  const sub = {
    id: store.nextId('sub'),
    createdAt: today,
    status: 'active',
    name: body.name.trim(),
    email: body.email.trim().toLowerCase(),
    phone: body.phone.trim(),
    street: body.street.trim(),
    areaId: body.areaId,
    geotag: { areaId: area.id, lat: area.lat, lng: area.lng },
    packageId: body.packageId,
    frequency: body.frequency,
    deliveryDay: body.deliveryDay,
    bankAccountId: account.id,
    mandate: {
      accepted: true,
      acceptedAt: today,
      bankName: account.bankName,
      accountHolder: account.accountHolder,
      accountNumberMasked: account.accountNumberMasked,
      branchCode: account.branchCode,
    },
    nextDeliveryDate: null,
  };

  db.bankAccounts.push(account);
  db.subscriptions.push(sub);
  const firstDate = D.nextDeliveryDate(sub.deliveryDay, today);
  const { debit } = scheduleCycle(db, sub, firstDate, today);
  store.save();

  return {
    code: 201,
    out: {
      subscription: publicSubscription(sub),
      firstDelivery: firstDate,
      firstDebit: { amount: debit.amount, dueDate: debit.dueDate },
    },
  };
}

function runBilling(asOf) {
  const db = store.load();
  const results = [];
  for (const debit of db.debitOrders) {
    if (debit.status !== 'pending' || debit.dueDate > asOf) continue;
    const sub = db.subscriptions.find((s) => s.id === debit.subscriptionId);
    if (!sub || sub.status === 'cancelled' || sub.status === 'paused') continue;

    const account = db.bankAccounts.find((a) => a.id === sub.bankAccountId);
    const delivery = db.deliveries.find((dl) => dl.id === debit.deliveryId);
    debit.attempts += 1;
    debit.processedAt = asOf;
    const ok = account && account.balance >= debit.amount;
    if (ok) {
      account.balance -= debit.amount;
      debit.status = 'paid';
      if (delivery) delivery.status = 'scheduled';
      if (sub.status === 'suspended') sub.status = 'active';
    } else {
      debit.status = 'failed';
      sub.status = 'suspended';
    }
    db.transactions.push({
      id: store.nextId('txn'),
      date: asOf,
      debitOrderId: debit.id,
      subscriptionId: sub.id,
      customer: sub.name,
      amount: debit.amount,
      status: ok ? 'success' : 'failed',
      reason: ok ? 'Debit order collected' : 'Insufficient funds',
    });
    results.push({ debitOrderId: debit.id, subscriptionId: sub.id, amount: debit.amount, status: debit.status });
  }
  store.save();
  const collected = results.filter((r) => r.status === 'paid');
  return {
    processed: results.length,
    collected: collected.length,
    failed: results.length - collected.length,
    totalCollected: collected.reduce((t, r) => t + r.amount, 0),
    results,
  };
}

function stats(today) {
  const db = store.load();
  const active = db.subscriptions.filter((s) => s.status === 'active');
  const byArea = {};
  for (const a of Object.values(D.AREAS)) byArea[a.id] = { name: a.name, active: 0 };
  for (const s of active) byArea[s.areaId].active += 1;
  const monthlyRevenue = active.reduce((t, s) => {
    const per = D.PACKAGES[s.packageId].pricePerDelivery;
    return t + per * (s.frequency === 'biweekly' ? 2 : 1);
  }, 0);
  const horizon = D.addDays(today, 7);
  return {
    activeSubscriptions: active.length,
    suspended: db.subscriptions.filter((s) => s.status === 'suspended').length,
    paused: db.subscriptions.filter((s) => s.status === 'paused').length,
    cancelled: db.subscriptions.filter((s) => s.status === 'cancelled').length,
    estimatedMonthlyRevenue: monthlyRevenue,
    totalCollected: db.transactions.filter((t) => t.status === 'success').reduce((t, x) => t + x.amount, 0),
    pendingDebitOrders: db.debitOrders.filter((d) => d.status === 'pending').length,
    failedDebitOrders: db.debitOrders.filter((d) => d.status === 'failed').length,
    deliveriesNext7Days: db.deliveries.filter(
      (dl) => dl.status !== 'delivered' && dl.status !== 'cancelled' && dl.date >= today && dl.date <= horizon
    ).length,
    byArea,
  };
}

// ---- router -------------------------------------------------------------

function handle(req, res, pathname, query, body) {
  const db = store.load();
  const today = query.today || D.todayString(); // ?today= lets demos time-travel
  const seg = pathname.split('/').filter(Boolean); // ['api', ...]

  try {
    if (req.method === 'GET' && pathname === '/api/config') {
      return json(res, 200, {
        products: D.PRODUCTS,
        packages: D.PACKAGES,
        areas: D.AREAS,
        frequencies: D.FREQUENCIES,
        deliveryDays: D.DELIVERY_DAYS,
        billingLeadDays: D.BILLING_LEAD_DAYS,
      });
    }

    if (pathname === '/api/subscriptions' && req.method === 'POST') {
      const { code, out } = createSubscription(body, today);
      return json(res, code, out);
    }

    if (pathname === '/api/subscriptions' && req.method === 'GET') {
      let subs = db.subscriptions;
      if (query.areaId) subs = subs.filter((s) => s.areaId === query.areaId);
      if (query.status) subs = subs.filter((s) => s.status === query.status);
      return json(res, 200, { subscriptions: subs.map(publicSubscription) });
    }

    if (seg[0] === 'api' && seg[1] === 'subscriptions' && seg[2]) {
      const sub = db.subscriptions.find((s) => s.id === seg[2]);
      if (!sub) return json(res, 404, { error: 'Subscription not found' });

      if (req.method === 'GET' && !seg[3]) return json(res, 200, { subscription: publicSubscription(sub) });

      if (req.method === 'POST' && seg[3] === 'pause') {
        if (sub.status !== 'active') return json(res, 409, { error: `Cannot pause a ${sub.status} subscription` });
        sub.status = 'paused';
        store.save();
        return json(res, 200, { subscription: publicSubscription(sub) });
      }

      if (req.method === 'POST' && seg[3] === 'resume') {
        if (sub.status !== 'paused' && sub.status !== 'suspended')
          return json(res, 409, { error: `Cannot resume a ${sub.status} subscription` });
        sub.status = 'active';
        // Reschedule any open cycle that drifted into the past.
        const open = openDelivery(db, sub.id);
        if (open && open.date < today) {
          open.date = D.nextDeliveryDate(sub.deliveryDay, today);
          sub.nextDeliveryDate = open.date;
          const debit = db.debitOrders.find((d) => d.id === open.debitOrderId);
          if (debit && debit.status !== 'paid') {
            debit.status = 'pending';
            debit.dueDate = D.debitDueDate(open.date, today);
          }
        }
        store.save();
        return json(res, 200, { subscription: publicSubscription(sub) });
      }

      if (req.method === 'POST' && seg[3] === 'cancel') {
        sub.status = 'cancelled';
        for (const dl of db.deliveries) {
          if (dl.subscriptionId === sub.id && (dl.status === 'pending_payment' || dl.status === 'scheduled')) {
            dl.status = 'cancelled';
            const debit = db.debitOrders.find((d) => d.id === dl.debitOrderId);
            if (debit && debit.status === 'pending') debit.status = 'cancelled';
          }
        }
        sub.nextDeliveryDate = null;
        store.save();
        return json(res, 200, { subscription: publicSubscription(sub) });
      }
    }

    if (pathname === '/api/deliveries' && req.method === 'GET') {
      let list = db.deliveries;
      if (query.date) list = list.filter((dl) => dl.date === query.date);
      if (query.status) list = list.filter((dl) => dl.status === query.status);
      const out = list
        .map((dl) => {
          const sub = db.subscriptions.find((s) => s.id === dl.subscriptionId);
          if (query.areaId && sub.areaId !== query.areaId) return null;
          return {
            ...dl,
            customer: sub.name,
            phone: sub.phone,
            street: sub.street,
            areaId: sub.areaId,
            areaName: D.AREAS[sub.areaId].name,
            geotag: sub.geotag,
            packageName: D.PACKAGES[sub.packageId].name,
            contents: D.packageContents(sub.packageId),
            deliveryDayName: D.DELIVERY_DAYS[sub.deliveryDay].name,
            subscriptionStatus: sub.status,
          };
        })
        .filter(Boolean)
        .sort((a, b) => (a.date + a.areaId).localeCompare(b.date + b.areaId));
      return json(res, 200, { deliveries: out });
    }

    if (seg[0] === 'api' && seg[1] === 'deliveries' && seg[2] && seg[3] === 'deliver' && req.method === 'POST') {
      const dl = db.deliveries.find((x) => x.id === seg[2]);
      if (!dl) return json(res, 404, { error: 'Delivery not found' });
      if (dl.status !== 'scheduled')
        return json(res, 409, { error: `Only paid (scheduled) deliveries can be completed — this one is ${dl.status}` });
      dl.status = 'delivered';
      dl.deliveredAt = today;
      const sub = db.subscriptions.find((s) => s.id === dl.subscriptionId);
      if (sub && sub.status === 'active') {
        let next = D.followingDeliveryDate(dl.date, sub.frequency);
        if (next <= today) next = D.nextDeliveryDate(sub.deliveryDay, today);
        scheduleCycle(db, sub, next, today);
      }
      store.save();
      return json(res, 200, { delivery: dl, nextDeliveryDate: sub ? sub.nextDeliveryDate : null });
    }

    if (pathname === '/api/billing/run' && req.method === 'POST') {
      return json(res, 200, runBilling(today));
    }

    if (pathname === '/api/billing/debit-orders' && req.method === 'GET') {
      let list = db.debitOrders;
      if (query.status) list = list.filter((d) => d.status === query.status);
      const out = list.map((d) => {
        const sub = db.subscriptions.find((s) => s.id === d.subscriptionId);
        return { ...d, customer: sub ? sub.name : '?', areaName: sub ? D.AREAS[sub.areaId].name : '?' };
      });
      return json(res, 200, { debitOrders: out });
    }

    if (pathname === '/api/billing/transactions' && req.method === 'GET') {
      return json(res, 200, { transactions: [...db.transactions].reverse() });
    }

    if (pathname === '/api/billing/accounts' && req.method === 'GET') {
      return json(res, 200, { accounts: db.bankAccounts });
    }

    if (seg[0] === 'api' && seg[1] === 'billing' && seg[2] === 'accounts' && seg[3] && seg[4] === 'topup' && req.method === 'POST') {
      const acc = db.bankAccounts.find((a) => a.id === seg[3]);
      if (!acc) return json(res, 404, { error: 'Account not found' });
      const amount = Number(body && body.amount);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 100000)
        return json(res, 400, { error: 'Top-up amount must be between R1 and R100 000' });
      acc.balance += Math.round(amount);
      // A failed debit order becomes collectable again after a top-up.
      for (const d of db.debitOrders) {
        const sub = db.subscriptions.find((s) => s.id === d.subscriptionId);
        if (d.status === 'failed' && sub && sub.bankAccountId === acc.id) d.status = 'pending';
      }
      store.save();
      return json(res, 200, { account: acc });
    }

    if (pathname === '/api/stats' && req.method === 'GET') {
      return json(res, 200, stats(today));
    }

    return json(res, 404, { error: 'Unknown API route' });
  } catch (err) {
    console.error(err);
    return json(res, 500, { error: 'Internal server error' });
  }
}

module.exports = { handle };
