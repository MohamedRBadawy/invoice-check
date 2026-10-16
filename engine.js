/*
 * Invoice Check engine: three-way matching of invoices against purchase orders and receipts.
 * generate() makes an INVENTED sample batch (nothing comes from a real company).
 * match() works on invented batches and on real files loaded through importer.js.
 *
 * Works in the browser (window.InvoiceEngine) and in Node (require('./engine.js')).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.InvoiceEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- Seeded random numbers, so a seed always gives the same data ----------
  function makeRandom(seed) {
    let a = (seed >>> 0) || 1;
    const next = function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
      next: next,
      int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
      pick: (arr) => arr[Math.floor(next() * arr.length)],
      between: (lo, hi) => lo + next() * (hi - lo),
    };
  }

  const round2 = (n) => Math.round(n * 100) / 100;
  const TAX_RATE = 0.1; // demo tax rate, invented

  // Invented vendor names. Each has spelling variants a real inbox would show.
  const VENDORS = [
    { id: 'V01', name: 'Harbor Lane Packaging', variants: ['HARBOUR LANE PACKAGING', 'Harbor Lane Packaging Ltd.', 'Harbor-Lane Packaging'] },
    { id: 'V02', name: 'Quillmoor Office Supply', variants: ['Quillmoor Office Supplies', 'QUILLMOOR OFFICE SUPPLY LLC', 'Quill Moor Office Supply'] },
    { id: 'V03', name: 'Brightfen Lab Materials', variants: ['Brightfen Lab Materials Co', 'BRIGHTFEN LAB MATERIAL', 'Bright Fen Lab Materials'] },
    { id: 'V04', name: 'Corvane Logistics', variants: ['Corvane Logistics Inc.', 'CORVANE LOGISTIC', 'Corvane Logistics Ltd'] },
    { id: 'V05', name: 'Tallowick Print Works', variants: ['Tallowick Printworks', 'TALLOWICK PRINT WORKS LTD', 'Tallowick Print-Works'] },
    { id: 'V06', name: 'Mirrowell Cleaning Services', variants: ['Mirrowell Cleaning Service', 'MIRROWELL CLEANING SERVICES CO.', 'Mirrowell Cleaning'] },
    { id: 'V07', name: 'Ostberry Electrical Parts', variants: ['Ostberry Electrical', 'OSTBERRY ELECTRICAL PARTS LLC', 'Ostberry Elec. Parts'] },
    { id: 'V08', name: 'Pellingham Safety Gear', variants: ['Pellingham Safety Gear Ltd', 'PELLINGHAM SAFETY', 'Pellingham Safety-Gear'] },
    { id: 'V09', name: 'Ravensholt IT Hardware', variants: ['Ravensholt IT', 'RAVENSHOLT IT HARDWARE INC', 'Ravensholt I.T. Hardware'] },
    { id: 'V10', name: 'Sundermere Catering', variants: ['Sundermere Catering Co.', 'SUNDERMERE CATERING LTD', 'Sunder Mere Catering'] },
  ];
  const UNKNOWN_VENDORS = ['Velkrane Trading', 'Ashgrove Imports', 'Nollbury Freight'];

  const ITEMS = [
    ['BOX-S', 'Shipping box, small', 0.8, 3.5], ['BOX-L', 'Shipping box, large', 1.5, 6],
    ['TAPE', 'Packing tape roll', 1.2, 4], ['PAPER', 'Copy paper, 5 reams', 18, 32],
    ['TONER', 'Printer toner', 45, 120], ['GLOVE', 'Nitrile gloves, box', 6, 14],
    ['MASK', 'Dust masks, pack', 9, 22], ['CABLE', 'Network cable, 5 m', 4, 11],
    ['MOUSE', 'USB mouse', 8, 25], ['LAMP', 'LED lamp', 12, 40],
    ['CLEAN', 'Cleaning visit', 60, 180], ['MEAL', 'Team lunch, per head', 7, 16],
    ['PALLET', 'Pallet delivery', 35, 90], ['LABEL', 'Label roll', 3, 9],
    ['HELMET', 'Safety helmet', 14, 35], ['FUSE', 'Fuse set', 5, 18],
  ];

  // How often each situation appears in the invented batch.
  const SCENARIOS = [
    ['clean', 52], ['price_small', 8], ['price_big', 7], ['qty_over', 6],
    ['duplicate', 5], ['missing_po', 6], ['po_typo', 4], ['vendor_variant', 6],
    ['no_po', 2], ['math_error', 2], ['extra_item', 2],
  ];

  function pickScenario(rnd) {
    const total = SCENARIOS.reduce((s, x) => s + x[1], 0);
    let r = rnd.next() * total;
    for (const [name, w] of SCENARIOS) { if ((r -= w) < 0) return name; }
    return 'clean';
  }

  function isoDate(base, addDays) {
    const d = new Date(base.getTime() + addDays * 86400000);
    return d.toISOString().slice(0, 10);
  }

  // ---------- Generate an invented batch ----------
  function generate(opts) {
    const seed = opts && opts.seed != null ? opts.seed : Date.now() % 1000000;
    const count = Math.max(10, Math.min(1000, (opts && opts.count) || 120));
    const rnd = makeRandom(seed);
    const base = new Date(Date.UTC(2026, 0, 5));

    const pos = [], receipts = [], invoices = [];
    const vendorTotals = {}; // keep PO totals for one vendor apart, so amount fallback is fair
    let poSeq = 1001, invSeq = 5001, grnSeq = 7001;

    const makeInvoiceFromPo = (po, vendorName, received) => {
      const lines = po.lines.map((l) => ({ sku: l.sku, desc: l.desc, qty: received[l.sku], unitPrice: l.unitPrice }));
      return {
        invoiceNumber: 'INV-' + invSeq++, vendorName: vendorName, poRef: po.poNumber,
        date: isoDate(new Date(po.date), rnd.int(3, 20)), lines: lines,
      };
    };

    const finalizeTotals = (inv) => {
      inv.lines.forEach((l) => { l.amount = round2(l.qty * l.unitPrice); });
      inv.subtotal = round2(inv.lines.reduce((s, l) => s + l.amount, 0));
      inv.tax = round2(inv.subtotal * TAX_RATE);
      inv.total = round2(inv.subtotal + inv.tax);
    };

    let made = 0;
    while (made < count) {
      const scenario = pickScenario(rnd);
      if (scenario === 'duplicate' && invoices.length === 0) continue;

      if (scenario === 'duplicate') {
        // Same invoice sent twice, with the number written differently.
        const src = invoices[rnd.int(0, invoices.length - 1)];
        if (src._truth.scenario === 'duplicate' || src._truth.scenario === 'no_po') continue;
        const digits = src.invoiceNumber.replace(/\D/g, '');
        const copy = JSON.parse(JSON.stringify(src));
        copy.invoiceNumber = rnd.pick(['inv ' + digits, 'INV' + digits, 'Invoice #' + digits, digits]);
        copy.date = isoDate(new Date(src.date), rnd.int(2, 15));
        copy._truth = { scenario: 'duplicate', duplicateOf: src.invoiceNumber };
        invoices.push(copy);
        made++;
        continue;
      }

      if (scenario === 'no_po') {
        // A vendor we have never ordered from.
        const lines = [];
        const n = rnd.int(1, 3);
        for (let i = 0; i < n; i++) {
          const it = rnd.pick(ITEMS);
          lines.push({ sku: it[0], desc: it[1], qty: rnd.int(1, 20), unitPrice: round2(rnd.between(it[2], it[3])) });
        }
        const inv = { invoiceNumber: 'INV-' + invSeq++, vendorName: rnd.pick(UNKNOWN_VENDORS), poRef: '', date: isoDate(base, rnd.int(10, 310)), lines: lines };
        finalizeTotals(inv);
        inv._truth = { scenario: 'no_po' };
        invoices.push(inv);
        made++;
        continue;
      }

      // Every other situation starts from a real (invented) purchase order.
      // Orders from one vendor placed close together get clearly different totals,
      // so "same vendor and same amount" stays a fair fallback.
      const vendor = rnd.pick(VENDORS);
      const others = vendorTotals[vendor.id] || (vendorTotals[vendor.id] = []);
      let poLines = null, poTotal = 0, poDay = 0, used = null;
      for (let attempt = 0; attempt < 30 && !poLines; attempt++) {
        const n = rnd.int(1, 4);
        const u = new Set(), lines = [];
        while (lines.length < n) {
          const it = rnd.pick(ITEMS);
          if (u.has(it[0])) continue;
          u.add(it[0]);
          lines.push({ sku: it[0], desc: it[1], qty: rnd.int(2, 40), unitPrice: round2(rnd.between(it[2], it[3])) });
        }
        const total = round2(lines.reduce((s, l) => s + l.qty * l.unitPrice, 0));
        const day = rnd.int(0, 300);
        if (others.some((o) => Math.abs(o.day - day) <= 60 && Math.abs(o.total - total) / Math.max(o.total, total) < 0.01)) continue;
        poLines = lines; poTotal = total; poDay = day; used = u;
      }
      if (!poLines) continue;
      others.push({ day: poDay, total: poTotal });

      const po = { poNumber: 'PO-' + poSeq++, vendorId: vendor.id, vendorName: vendor.name, date: isoDate(base, poDay), lines: poLines, total: poTotal };
      pos.push(po);

      // Goods receipt: what actually arrived.
      const received = {};
      poLines.forEach((l) => { received[l.sku] = l.qty; });
      if (scenario === 'qty_over') {
        const l = rnd.pick(poLines);
        received[l.sku] = Math.max(1, l.qty - rnd.int(1, Math.max(1, Math.floor(l.qty / 2))));
      }
      receipts.push({
        grnNumber: 'GRN-' + grnSeq++, poNumber: po.poNumber, date: isoDate(new Date(po.date), rnd.int(1, 10)),
        lines: poLines.map((l) => ({ sku: l.sku, qtyReceived: received[l.sku] })),
      });

      // The invoice the vendor sends.
      const billed = Object.assign({}, received);
      if (scenario === 'qty_over') poLines.forEach((l) => { billed[l.sku] = l.qty; }); // billed full order
      const inv = makeInvoiceFromPo(po, vendor.name, billed);
      const truth = { scenario: scenario, poNumber: po.poNumber };

      if (scenario === 'price_small' || scenario === 'price_big') {
        const l = rnd.pick(inv.lines);
        const pct = scenario === 'price_small' ? rnd.between(0.4, 1.8) : rnd.between(4, 12);
        const newPrice = round2(l.unitPrice * (1 + pct / 100));
        truth.variancePct = ((newPrice - l.unitPrice) / l.unitPrice) * 100;
        l.unitPrice = newPrice;
        if (newPrice === po.lines.find((p) => p.sku === l.sku).unitPrice) continue; // too small to show
      }
      if (scenario === 'missing_po') inv.poRef = '';
      if (scenario === 'po_typo') {
        const d = po.poNumber.replace('PO-', '');
        inv.poRef = rnd.pick(['PO#' + d.slice(0, 3), 'PO-' + d + '0', 'PO-' + d.slice(1)]);
      }
      if (scenario === 'vendor_variant') inv.vendorName = rnd.pick(vendor.variants);
      if (scenario === 'extra_item') {
        let it = rnd.pick(ITEMS);
        while (used.has(it[0])) it = rnd.pick(ITEMS);
        inv.lines.push({ sku: it[0], desc: it[1], qty: rnd.int(1, 5), unitPrice: round2(rnd.between(it[2], it[3])) });
      }

      finalizeTotals(inv);
      if (scenario === 'math_error') inv.total = round2(inv.total + rnd.pick([10, 25, 90, -15]));
      inv._truth = truth;
      invoices.push(inv);
      made++;
    }

    invoices.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return { seed: seed, generatedAt: new Date().toISOString(), vendors: VENDORS.map((v) => ({ id: v.id, name: v.name })), pos: pos, receipts: receipts, invoices: invoices };
  }

  // ---------- Matching ----------
  const SUFFIXES = /\b(ltd|llc|inc|co|company|limited)\b/g;
  function normName(s) {
    return String(s).toLowerCase().replace(/harbour/g, 'harbor').replace(/[^a-z0-9 ]/g, ' ')
      .replace(SUFFIXES, ' ').replace(/\s+/g, '').replace(/s\b/g, '');
  }
  function bigrams(s) { const out = []; for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2)); return out; }
  function similarity(a, b) {
    const na = normName(a), nb = normName(b);
    if (na.length >= 8 && nb.length >= 8 && (na.indexOf(nb) === 0 || nb.indexOf(na) === 0)) return 0.9;
    const x = bigrams(na), y = bigrams(nb);
    if (!x.length || !y.length) return 0;
    const counts = {};
    x.forEach((g) => { counts[g] = (counts[g] || 0) + 1; });
    let hit = 0;
    y.forEach((g) => { if (counts[g] > 0) { hit++; counts[g]--; } });
    return (2 * hit) / (x.length + y.length);
  }
  const normInvNo = (s) => { const d = String(s).replace(/\D/g, ''); return d || String(s).toLowerCase().replace(/[^a-z0-9]/g, ''); };
  const normPo = (s) => {
    const rest = String(s).toUpperCase().trim().replace(/^P[O0]\W*/, '').replace(/O/g, '0');
    const d = rest.replace(/\D/g, '');
    return d ? 'PO-' + d : '';
  };

  const REASONS = {
    DUPLICATE: { label: 'Duplicate invoice', action: 'Block payment. It was already received under another number.' },
    MATH: { label: 'Totals do not add up', action: 'Ask the vendor for a corrected invoice.' },
    NO_PO: { label: 'No matching purchase order', action: 'Ask who ordered this. Do not pay until someone approves it.' },
    AMBIGUOUS: { label: 'More than one possible order', action: 'A person picks the right order.' },
    ITEM: { label: 'Item not on the order', action: 'Check with the requester whether the extra item was agreed.' },
    QTY: { label: 'Billed more than received', action: 'Pay for what arrived, or wait for the rest of the delivery.' },
    PRICE: { label: 'Price above the agreed price', action: 'Ask the vendor to bill the order price, or get approval for the increase.' },
  };

  function match(data, settings) {
    const tol = settings && settings.priceTolerancePct != null ? settings.priceTolerancePct : 2;
    const vendorCut = 0.75;
    const taxRate = settings && settings.taxRate != null ? settings.taxRate : TAX_RATE;
    const mathTol = settings && settings.roundingTolerance != null ? settings.roundingTolerance : 0.01;
    const poByNumber = {}; data.pos.forEach((p) => { poByNumber[p.poNumber] = p; });
    const received = {}; // poNumber -> sku -> qty
    data.receipts.forEach((r) => {
      const m = received[r.poNumber] || (received[r.poNumber] = {});
      r.lines.forEach((l) => { m[l.sku] = (m[l.sku] || 0) + l.qtyReceived; });
    });
    const seen = {}; // duplicate keys
    const usedPo = {};

    const results = data.invoices.map((inv) => {
      const res = { invoiceNumber: inv.invoiceNumber, vendorWritten: inv.vendorName, date: inv.date, total: inv.total, reasons: [], notes: [], lineChecks: [], poNumber: null, vendorId: null };

      // Rule 1: recognise the vendor even when the name is written differently.
      let best = null, bestScore = 0;
      data.vendors.forEach((v) => { const s = similarity(inv.vendorName, v.name); if (s > bestScore) { bestScore = s; best = v; } });
      if (best && bestScore >= vendorCut) {
        res.vendorId = best.id; res.vendorName = best.name;
        if (inv.vendorName !== best.name) res.notes.push('Vendor name "' + inv.vendorName + '" read as ' + best.name + ' (' + Math.round(bestScore * 100) + '% similar).');
      }

      // Rule 2: the same invoice must not be paid twice.
      const key = (res.vendorId || normName(inv.vendorName)) + '|' + normInvNo(inv.invoiceNumber);
      const key2 = (res.vendorId || normName(inv.vendorName)) + '|' + inv.total.toFixed(2) + '|' + (inv.poRef ? normPo(inv.poRef) : '');
      if (seen[key] || seen[key2]) {
        res.reasons.push('DUPLICATE');
        res.duplicateOf = seen[key] || seen[key2];
        res.status = 'duplicate';
        return res;
      }
      seen[key] = inv.invoiceNumber; seen[key2] = inv.invoiceNumber;

      // Rule 3: the invoice must add up. Real files carry their own tax amount;
      // when they do not, the configured tax rate is used.
      const lineSum = round2(inv.lines.reduce((s, l) => s + round2(l.qty * l.unitPrice), 0));
      const tax = inv.tax != null ? inv.tax : round2(lineSum * taxRate);
      const expectTotal = round2(lineSum + tax);
      const subtotalOff = inv.subtotal != null && Math.abs(lineSum - inv.subtotal) > mathTol;
      if (subtotalOff || Math.abs(expectTotal - inv.total) > mathTol) res.reasons.push('MATH');

      // Rule 4: find the purchase order.
      let po = null;
      const ref = normPo(inv.poRef);
      if (ref && poByNumber[ref] && poByNumber[ref].vendorId === res.vendorId) {
        po = poByNumber[ref];
      } else if (res.vendorId) {
        // Same vendor, order placed up to 45 days before the invoice, total within 0.5%.
        const invDay = Date.parse(inv.date) / 86400000;
        const near = data.pos.filter((p) => {
          const age = invDay - Date.parse(p.date) / 86400000;
          return p.vendorId === res.vendorId && !usedPo[p.poNumber] && age >= 0 && age <= 45 &&
            Math.abs(p.total - (inv.subtotal != null ? inv.subtotal : lineSum)) / p.total <= 0.005;
        });
        if (near.length === 1) {
          po = near[0];
          res.notes.push(inv.poRef ? 'Order number "' + inv.poRef + '" not found. Matched to ' + po.poNumber + ' by vendor, date and amount.'
            : 'No order number on the invoice. Matched to ' + po.poNumber + ' by vendor, date and amount.');
        } else if (near.length > 1) {
          res.reasons.push('AMBIGUOUS');
        }
      }
      if (!po && res.reasons.indexOf('AMBIGUOUS') < 0) res.reasons.push('NO_PO');

      // Rule 5: compare every line with the order and the delivery.
      let withinTol = false;
      if (po) {
        res.poNumber = po.poNumber; usedPo[po.poNumber] = true;
        const rec = received[po.poNumber] || {};
        inv.lines.forEach((l) => {
          const pl = po.lines.find((x) => x.sku === l.sku);
          const chk = { sku: l.sku, desc: l.desc, qtyBilled: l.qty, priceBilled: l.unitPrice, qtyOrdered: pl ? pl.qty : 0, priceOrdered: pl ? pl.unitPrice : null, qtyReceived: rec[l.sku] || 0, flags: [] };
          if (!pl) { chk.flags.push('ITEM'); }
          else {
            if (l.qty > (rec[l.sku] || 0)) chk.flags.push('QTY');
            const diff = ((l.unitPrice - pl.unitPrice) / pl.unitPrice) * 100;
            chk.priceDiffPct = round2(diff);
            if (diff > tol + 1e-9) chk.flags.push('PRICE');
            else if (diff > 0.0001) { chk.flags.push('PRICE_OK'); withinTol = true; }
          }
          chk.flags.forEach((f) => { if (f !== 'PRICE_OK' && res.reasons.indexOf(f) < 0) res.reasons.push(f); });
          res.lineChecks.push(chk);
        });
      }

      if (res.reasons.length) res.status = 'exception';
      else if (withinTol) { res.status = 'tolerance'; res.notes.push('Price slightly above the order, inside the ' + tol + '% tolerance.'); }
      else res.status = 'approved';
      return res;
    });

    return { results: results, summary: summarize(data, results), tolerance: tol };
  }

  function summarize(data, results) {
    const s = { invoices: results.length, approved: 0, tolerance: 0, exception: 0, duplicate: 0, valueOnHold: 0, valueTotal: 0, byReason: {} };
    results.forEach((r) => {
      s[r.status]++;
      s.valueTotal += r.total;
      if (r.status === 'exception' || r.status === 'duplicate') s.valueOnHold += r.total;
      r.reasons.forEach((k) => { s.byReason[k] = (s.byReason[k] || 0) + 1; });
    });
    s.valueOnHold = round2(s.valueOnHold); s.valueTotal = round2(s.valueTotal);
    s.noTouchRate = s.invoices ? (s.approved + s.tolerance) / s.invoices : 0;
    return s;
  }

  // ---------- Answer key: what the generator meant each invoice to be ----------
  function expectedFor(inv, tol) {
    const t = inv._truth;
    switch (t.scenario) {
      case 'clean': case 'missing_po': case 'po_typo': case 'vendor_variant': return { status: 'approved', reason: null };
      case 'price_small': case 'price_big': return t.variancePct > tol + 1e-9 ? { status: 'exception', reason: 'PRICE' } : { status: 'tolerance', reason: null };
      case 'qty_over': return { status: 'exception', reason: 'QTY' };
      case 'duplicate': return { status: 'duplicate', reason: 'DUPLICATE' };
      case 'no_po': return { status: 'exception', reason: 'NO_PO' };
      case 'math_error': return { status: 'exception', reason: 'MATH' };
      case 'extra_item': return { status: 'exception', reason: 'ITEM' };
      default: return { status: '?', reason: null };
    }
  }

  function checkAgainstKey(data, matched) {
    const misses = [];
    data.invoices.forEach((inv, i) => {
      const exp = expectedFor(inv, matched.tolerance);
      const got = matched.results[i];
      const ok = got.status === exp.status && (!exp.reason || got.reasons.indexOf(exp.reason) >= 0);
      if (!ok) misses.push({ invoiceNumber: inv.invoiceNumber, scenario: inv._truth.scenario, expected: exp, got: { status: got.status, reasons: got.reasons } });
    });
    return { total: data.invoices.length, agree: data.invoices.length - misses.length, misses: misses };
  }

  // ---------- CSV export ----------
  function toCsv(rows) {
    if (!rows.length) return '';
    const cols = Object.keys(rows[0]);
    const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    return [cols.join(',')].concat(rows.map((r) => cols.map((c) => esc(r[c])).join(','))).join('\n');
  }

  return { generate: generate, match: match, normName: normName, round2: round2, checkAgainstKey: checkAgainstKey, toCsv: toCsv, REASONS: REASONS, TAX_RATE: TAX_RATE, _similarity: similarity, _normPo: normPo };
});
