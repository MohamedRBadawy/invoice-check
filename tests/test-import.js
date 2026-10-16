// Checks the CSV importer: run with `node tests/test-import.js` from the invoice-check folder.
// 1. Round trip: an invented batch, written to the three CSV files and read back, must get
//    exactly the same decisions as the batch matched directly.
// 2. Messy files: semicolons, a byte-order mark, comma decimals, day/month dates, other
//    column names, header values only on the first invoice line.
// 3. Broken files: missing columns are reported, not guessed.
const path = require('path');
const E = require(path.join(__dirname, '..', 'engine.js'));
const I = require(path.join(__dirname, '..', 'importer.js'));

let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; console.log('FAIL', msg); } };

// 1. Round trip
let decisions = 0;
for (let seed = 1; seed <= 200; seed++) {
  for (const tol of [0, 2, 5]) {
    const batch = E.generate({ seed: seed, count: 150 });
    const direct = E.match(batch, { priceTolerancePct: tol });
    const files = I.toFiles(batch, 'INVENTED SAMPLE DATA');
    const imp = I.importFiles(files);
    check(imp.data, 'seed ' + seed + ' import failed: ' + JSON.stringify(imp.problems));
    if (!imp.data) continue;
    check(imp.problems.length === 0, 'seed ' + seed + ' unexpected problems: ' + JSON.stringify(imp.problems.slice(0, 2)));
    const viaFiles = E.match(imp.data, { priceTolerancePct: tol });
    check(viaFiles.results.length === direct.results.length, 'seed ' + seed + ' count differs');
    direct.results.forEach((d, i) => {
      const f = viaFiles.results[i];
      decisions++;
      const same = f && f.invoiceNumber === d.invoiceNumber && f.status === d.status && f.reasons.join() === d.reasons.join();
      check(same, 'seed ' + seed + ' tol ' + tol + ' ' + d.invoiceNumber + ': direct ' + d.status + ' ' + d.reasons + ' / files ' + (f && f.status) + ' ' + (f && f.reasons));
    });
  }
}
console.log('Round trip: ' + decisions + ' decisions compared');

// 2. Messy but valid files
const messy = {
  pos: '﻿PO Number;Supplier;Order Date;Item Code;Description;Quantity;Unit Price\n' +
    '4500123;Acme Tools GmbH;31/01/2026;A-1;Hammer;10;12,50\n' +
    '4500123;Acme Tools GmbH;31/01/2026;A-2;Saw;2;"1.040,00"\n' +
    '4500124;Blue River Foods;02/02/2026;;Coffee beans 1kg;5;18\n',
  receipts: 'GRN;PO;Received Date;Item Code;Qty Received\n' +
    'R1;4500123;03/02/2026;A-1;10\nR2;4500123;10/02/2026;A-2;1\nR3;4500124;05/02/2026;;5\n',
  invoices: 'Invoice No;Vendor;Invoice Date;PO;Item Code;Description;Qty;Unit Price;Net;VAT;Total\n' +
    'AC-778;ACME TOOLS GMBH;12/02/2026;PO 4500123;A-1;Hammer;10;12,50;2205,00;418,95;2623,95\n' +
    'AC-778;;;;A-2;Saw;2;"1.040,00";;;\n' +
    'BR-1;Blue River Foods Ltd;06/02/2026;;;Coffee beans 1kg;5;18;90;17,10;107,10\n' +
    'BR 1;Blue River Foods;20/02/2026;;;Coffee beans 1kg;5;18;90;17,10;107,10\n',
};
// The second AC-778 line repeats only the invoice number and leaves the header cells blank.
const m = I.importFiles(messy);
check(m.data, 'messy import failed: ' + JSON.stringify(m.problems));
if (m.data) {
  const r = E.match(m.data, { priceTolerancePct: 2 });
  const byNo = {}; r.results.forEach((x) => { byNo[x.invoiceNumber] = x; });
  check(m.data.invoices.length === 3, 'messy: expected 3 invoices, got ' + m.data.invoices.length);
  check(byNo['AC-778'] && byNo['AC-778'].status === 'exception' && byNo['AC-778'].reasons.join() === 'QTY', 'messy: AC-778 should be billed more than received, got ' + JSON.stringify(byNo['AC-778'] && [byNo['AC-778'].status, byNo['AC-778'].reasons]));
  check(byNo['BR-1'] && byNo['BR-1'].status === 'approved', 'messy: BR-1 should be approved via vendor, date and amount, got ' + JSON.stringify(byNo['BR-1'] && [byNo['BR-1'].status, byNo['BR-1'].reasons]));
  check(byNo['BR 1'] && byNo['BR 1'].status === 'duplicate', 'messy: BR 1 should be a duplicate, got ' + (byNo['BR 1'] && byNo['BR 1'].status));
  check(m.data.pos[0].date === '2026-01-31', 'messy: day-first date read wrong: ' + m.data.pos[0].date);
}

// 3. Broken file
const broken = I.importFiles({ pos: 'po,vendor\n1,x\n', receipts: messy.receipts, invoices: messy.invoices });
check(!broken.data && broken.problems.some((p) => p.level === 'error' && /Missing column/.test(p.msg)), 'broken: missing columns not reported');

console.log(failures ? failures + ' FAILURES' : 'All import checks passed');
process.exit(failures ? 1 : 0);
