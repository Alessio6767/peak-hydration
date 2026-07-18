// Domain catalogue + scheduling rules for Peak Hydration subscriptions.
// Prices are ZAR integers (rands). All dates are YYYY-MM-DD strings.

const PRODUCTS = {
  '5l':     { id: '5l',     name: 'Still 5L Bottle',        unit: '5L bottle' },
  'case24': { id: 'case24', name: 'Case of 24 × 500ml Still', unit: 'case (24 × 500ml)' },
};

const PACKAGES = {
  essential: {
    id: 'essential',
    name: 'Essential',
    tagline: 'The household staple. 20L of still water in easy 5L bottles.',
    items: [{ productId: '5l', qty: 4 }],
    pricePerDelivery: 260,
  },
  active: {
    id: 'active',
    name: 'Active',
    tagline: 'Grab-and-go. 48 bottles of 500ml still, two full cases.',
    items: [{ productId: 'case24', qty: 2 }],
    pricePerDelivery: 480,
  },
  peak: {
    id: 'peak',
    name: 'Peak',
    tagline: 'The full setup — 5L bottles for home plus cases for the road.',
    items: [{ productId: '5l', qty: 4 }, { productId: 'case24', qty: 2 }],
    pricePerDelivery: 680,
    badge: 'Best value',
  },
};

// Serviced delivery areas. Each subscription is geotagged with its
// area's centroid so routes can be grouped per suburb.
const AREAS = {
  'centurion':     { id: 'centurion',     name: 'Centurion',     lat: -25.8603, lng: 28.1894 },
  'irene':         { id: 'irene',         name: 'Irene',         lat: -25.8945, lng: 28.2179 },
  'midrand':       { id: 'midrand',       name: 'Midrand',       lat: -25.9992, lng: 28.1263 },
  'pretoria-east': { id: 'pretoria-east', name: 'Pretoria East', lat: -25.7863, lng: 28.3145 },
};

const FREQUENCIES = {
  biweekly: { id: 'biweekly', name: 'Every 2 weeks', intervalDays: 14 },
  monthly:  { id: 'monthly',  name: 'Monthly',       intervalDays: 28 },
};

// Deliveries run on fixed weekdays only.
const DELIVERY_DAYS = {
  monday: { id: 'monday', name: 'Monday', weekday: 1 },
  friday: { id: 'friday', name: 'Friday', weekday: 5 },
};

// Days between raising a debit order and its delivery, so payment
// clears before the truck is loaded.
const BILLING_LEAD_DAYS = 3;
// Minimum days between signup and first delivery.
const FIRST_DELIVERY_MIN_LEAD_DAYS = 3;

function toDateString(d) {
  return d.toISOString().slice(0, 10);
}

function parseDate(s) {
  // Noon UTC keeps day arithmetic safe across timezones.
  return new Date(s + 'T12:00:00Z');
}

function addDays(dateStr, days) {
  const d = parseDate(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return toDateString(d);
}

function todayString(now = new Date()) {
  return toDateString(now);
}

// Next occurrence of the chosen weekday at least minLeadDays from `fromDate`.
function nextDeliveryDate(deliveryDayId, fromDate, minLeadDays = FIRST_DELIVERY_MIN_LEAD_DAYS) {
  const target = DELIVERY_DAYS[deliveryDayId].weekday;
  let d = addDays(fromDate, minLeadDays);
  while (parseDate(d).getUTCDay() !== target) d = addDays(d, 1);
  return d;
}

function followingDeliveryDate(currentDate, frequencyId) {
  return addDays(currentDate, FREQUENCIES[frequencyId].intervalDays);
}

function debitDueDate(deliveryDate, signupDate) {
  const due = addDays(deliveryDate, -BILLING_LEAD_DAYS);
  // First debit can never be due before signup day.
  return due < signupDate ? signupDate : due;
}

function packageContents(packageId) {
  return PACKAGES[packageId].items.map((i) => ({
    ...i,
    name: PRODUCTS[i.productId].name,
    unit: PRODUCTS[i.productId].unit,
  }));
}

function validateSubscriptionInput(body) {
  const errors = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };

  need(body && typeof body === 'object', 'Missing request body');
  if (!body || typeof body !== 'object') return errors;

  need(typeof body.name === 'string' && body.name.trim().length >= 2, 'Full name is required');
  need(typeof body.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email), 'A valid email is required');
  need(typeof body.phone === 'string' && body.phone.replace(/\D/g, '').length >= 9, 'A valid phone number is required');
  need(typeof body.street === 'string' && body.street.trim().length >= 4, 'Street address is required');
  need(!!AREAS[body.areaId], 'Please choose a serviced delivery area');
  need(!!PACKAGES[body.packageId], 'Please choose a package');
  need(!!FREQUENCIES[body.frequency], 'Please choose a delivery frequency');
  need(!!DELIVERY_DAYS[body.deliveryDay], 'Delivery day must be Monday or Friday');

  const bank = body.bank || {};
  need(typeof bank.bankName === 'string' && bank.bankName.trim().length >= 2, 'Bank name is required');
  need(typeof bank.accountHolder === 'string' && bank.accountHolder.trim().length >= 2, 'Account holder name is required');
  need(/^\d{8,12}$/.test(String(bank.accountNumber || '').replace(/\s/g, '')), 'Account number must be 8–12 digits');
  need(/^\d{6}$/.test(String(bank.branchCode || '').trim()), 'Branch code must be 6 digits');
  need(body.mandateAccepted === true, 'The debit order mandate must be accepted');

  return errors;
}

module.exports = {
  PRODUCTS, PACKAGES, AREAS, FREQUENCIES, DELIVERY_DAYS,
  BILLING_LEAD_DAYS, FIRST_DELIVERY_MIN_LEAD_DAYS,
  todayString, addDays, nextDeliveryDate, followingDeliveryDate,
  debitDueDate, packageContents, validateSubscriptionInput,
};
