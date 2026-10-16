/*
 * Invoice Check importer: turns three CSV exports (purchase orders, receipts, invoices)
 * into the shape engine.js matches, and lists every problem it finds in the files.
 *
 * Nothing is uploaded anywhere. In the browser the files are read locally with FileReader.
 * Works in the browser (window.InvoiceImporter) and in Node (require('./importer.js')).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.InvoiceImporter = factory(root.InvoiceEngine);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  // Column names people actually use, mapped to one name each. Matching ignores case,
  // spaces, underscores and punctuation, so "PO Number", "po_number" and "PO#" all work.
  const COLUMNS = {
    pos: {
      po: ['po', 'ponumber', 'pono', 'purchaseorder', 'purchaseordernumber', 'order', 'ordernumber'],
      vendor: ['vendor', 'vendorname', 'supplier', 'suppliername'],
      date: ['date', 'podate', 'orderdate'],
      sku: ['sku', 'item', 'itemcode', 'itemnumber', 'productcode', 'partnumber', 'code'],
      desc: ['description', 'desc', 'itemdescription', 'itemname', 'product'],
      qty: ['qty', 'quantity', 'qtyordered', 'quantityordered'],
      price: ['unitprice', 'price', 'rate', 'unitcost'],
    },
    receipts: {
      receipt: ['receipt', 'receiptnumber', 'grn', 'grnnumber', 'goodsreceipt', 'deliverynote', 'deliverynumber'],
      po: ['po', 'ponumber', 'pono', 'purchaseorder', 'purchaseordernumber', 'order', 'ordernumber'],
      date: ['date', 'receiptdate', 'receiveddate', 'deliverydate'],
      sku: ['sku', 'item', 'itemcode', 'itemnumber', 'productcode', 'partnumber', 'code'],
      desc: ['description', 'desc', 'itemdescription', 'itemname', 'product'],
      qty: ['qtyreceived', 'quantityreceived', 'qty', 'quantity', 'received'],
    },
    invoices: {
      invoice: ['invoice', 'invoicenumber', 'invoiceno', 'invno', 'bill', 'billnumber'],
      vendor: ['vendor', 'vendorname', 'vendoraswritten', 'supplier', 'suppliername'],
      date: ['date', 'invoicedate', 'billdate'],
      po: ['poref', 'po', 'ponumber', 'pono', 'purchaseorder', 'purchaseordernumber', 'orderref'],
      sku: ['sku', 'item', 'itemcode', 'itemnumber', 'productcode', 'partnumber', 'code'],
      desc: ['description', 'desc', 'itemdescription', 'itemname', 'product'],
      qty: ['qty', 'quantity', 'qtybilled', 'quantitybilled'],
      price: ['unitprice', 'price', 'rate', 'unitcost'],
      subtotal: ['subtotal', 'invoicesubtotal', 'net', 'netamount'],
      tax: ['tax', 'vat', 'taxamount', 'vatamount', 'invoicetax'],
      total: ['total', 'invoicetotal', 'gross', 'grossamount', 'amountdue'],
    },
  };
  const REQUIRED = {
    pos: ['po', 'vendor', 'date', 'qty', 'price'],
    receipts: ['po', 'qty'],
    invoices: ['invoice', 'vendor', 'date', 'qty', 'price', 'total'],
  };
  const LABEL = { pos: 'Purchase orders', receipts: 'Receipts', invoices: 'Invoices' };

  // ---------- CSV parsing (quotes, BOM, comma or semicolon, comment lines) ----------
  function parseCsv(text) {
    text = String(text).replace(/^﻿/, '');
    const firstLine = text.split(/\r?\n/).find((l) => l.trim() && l.trim()[0] !== '#') || '';
    const delim = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';'
      : (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? '\t' : ',';
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') q = false;
        else cell += c;
      } else if (c === '"' && cell === '') q = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((x) => x.trim() !== '') && String(r[0]).trim()[0] !== '#');
  }

  const key = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

  function mapHeader(header, kind) {
    const map = {}; const spec = COLUMNS[kind];
    const keys = header.map(key);
    Object.keys(spec).forEach((field) => {
      for (const alias of spec[field]) {
        const i = keys.indexOf(alias);
        if (i >= 0 && !Object.values(map).includes(i)) { map[field] = i; break; }
      }
    });
    return map;
  }

  // "1,234.50", "1.234,50", "€ 12", "(15.00)" and "12,5" are all read as numbers.
  function num(v) {
    let s = String(v == null ? '' : v).trim();
    if (!s) return null;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    s = s.replace(/[^0-9.,\-]/g, '');
    if (s.indexOf(',') >= 0 && s.indexOf('.') >= 0) {
      s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    } else if (s.indexOf(',') >= 0) {
      s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
    }
    const n = parseFloat(s);
    if (isNaN(n)) return null;
    return neg ? -n : n;
  }

  // Dates: 2026-01-31, 31/01/2026, 31.01.2026, 01/31/2026 (day/month order is detected per file).
  function makeDateReader(values) {
    let dayFirst = true;
    values.forEach((v) => {
      const m = String(v).trim().match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
      if (m && parseInt(m[2], 10) > 12) dayFirst = false;
    });
    return function (v) {
      const s = String(v == null ? '' : v).trim();
      let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
      m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
      if (m) {
        const d = dayFirst ? m[1] : m[2], mo = dayFirst ? m[2] : m[1];
        if (parseInt(mo, 10) > 12) return null;
        return m[3] + '-' + mo.padStart(2, '0') + '-' + d.padStart(2, '0');
      }
      return null;
    };
  }

  // Lines are compared by item code; when a file has no code, the description is used.
  const itemKey = (sku, desc) => (String(sku || '').trim() ? String(sku).trim().toUpperCase() : 'DESC:' + key(desc || ''));

  function readTable(text, kind, problems) {
    const rows = parseCsv(text);
    if (!rows.length) { problems.push({ level: 'error', file: LABEL[kind], msg: 'The file is empty.' }); return null; }
    const header = rows[0];
    const map = mapHeader(header, kind);
    const missing = REQUIRED[kind].filter((f) => map[f] == null);
    if (map.sku == null && map.desc == null) missing.push('sku or description');
    if (missing.length) {
      problems.push({ level: 'error', file: LABEL[kind], msg: 'Missing column(s): ' + missing.join(', ') + '. Found: ' + header.join(', ') + '.' });
      return null;
    }
    const body = rows.slice(1).map((r, i) => {
      const o = { _row: i + 2 };
      Object.keys(map).forEach((f) => { o[f] = (r[map[f]] == null ? '' : r[map[f]]).trim(); });
      return o;
    });
    return body;
  }

  function importFiles(texts, settings) {
    const problems = [];
    const t = { pos: readTable(texts.pos || '', 'pos', problems), receipts: readTable(texts.receipts || '', 'receipts', problems), invoices: readTable(texts.invoices || '', 'invoices', problems) };
    if (!t.pos || !t.receipts || !t.invoices) return { data: null, problems: problems };

    const warn = (file, row, msg) => problems.push({ level: 'warning', file: LABEL[file], row: row, msg: msg });
    // Order numbers are compared the way the engine reads them on invoices ("PO 1001", "po-1001" and "1001" are one order).
    const normPoNo = (s) => E._normPo(s) || String(s || '').trim().toUpperCase();
    const rawPo = {};

    // Purchase orders, one row per line.
    const poDate = makeDateReader(t.pos.map((r) => r.date));
    const vendors = {}; const poBy = {};
    t.pos.forEach((r) => {
      const qty = num(r.qty), price = num(r.price), date = poDate(r.date);
      if (!r.po) return warn('pos', r._row, 'No order number. Line skipped.');
      if (qty == null || price == null) return warn('pos', r._row, 'Quantity or price is not a number. Line skipped.');
      if (!date) warn('pos', r._row, 'Date "' + r.date + '" not understood. Amount matching for this order is turned off.');
      const id = E.normName(r.vendor);
      if (!vendors[id]) vendors[id] = { id: id, name: r.vendor };
      const k = normPoNo(r.po);
      if (rawPo[k] && rawPo[k] !== r.po.trim()) warn('pos', r._row, 'Order numbers "' + rawPo[k] + '" and "' + r.po.trim() + '" look the same once letters and punctuation are removed. They are treated as one order.');
      rawPo[k] = rawPo[k] || r.po.trim();
      const po = poBy[k] || (poBy[k] = { poNumber: k, vendorId: id, vendorName: r.vendor, date: date || '1900-01-01', lines: [] });
      if (po.vendorId !== id) warn('pos', r._row, 'Order ' + k + ' has more than one vendor name. The first one is used.');
      const sku = itemKey(r.sku, r.desc);
      const existing = po.lines.find((l) => l.sku === sku);
      if (existing) existing.qty += qty;
      else po.lines.push({ sku: sku, desc: r.desc || r.sku, qty: qty, unitPrice: price });
    });
    const pos = Object.values(poBy);
    pos.forEach((p) => { p.total = E.round2(p.lines.reduce((s, l) => s + l.qty * l.unitPrice, 0)); });

    // Receipts. Several deliveries against one order are added together.
    const recDate = makeDateReader(t.receipts.map((r) => r.date));
    const recBy = {};
    t.receipts.forEach((r) => {
      const qty = num(r.qty);
      if (qty == null) return warn('receipts', r._row, 'Quantity received is not a number. Line skipped.');
      const k = normPoNo(r.po);
      if (!poBy[k]) warn('receipts', r._row, 'Order ' + (r.po || '(blank)') + ' is not in the purchase order file.');
      const g = recBy[(r.receipt || 'R') + '|' + k] || (recBy[(r.receipt || 'R') + '|' + k] = { grnNumber: r.receipt || '(no number)', poNumber: k, date: recDate(r.date) || '', lines: [] });
      let sku = itemKey(r.sku, r.desc);
      if (sku === 'DESC:') {
        // No item code or description: only safe when the order has a single line.
        if (poBy[k] && poBy[k].lines.length === 1) sku = poBy[k].lines[0].sku;
        else warn('receipts', r._row, 'No item code or description, and order ' + (r.po || '(blank)') + ' has several lines. Line skipped.');
      }
      if (sku !== 'DESC:') g.lines.push({ sku: sku, qtyReceived: qty });
    });
    const receipts = Object.values(recBy);

    // Invoices, one row per line; header values may repeat on every line or only on the first.
    const invDate = makeDateReader(t.invoices.map((r) => r.date));
    const order = [];
    t.invoices.forEach((r) => {
      if (!r.invoice) return warn('invoices', r._row, 'No invoice number. Line skipped.');
      const qty = num(r.qty), price = num(r.price);
      if (qty == null || price == null) return warn('invoices', r._row, 'Quantity or price is not a number. Line skipped.');
      // Lines of one invoice sit together in the file. A line continues the invoice just above it
      // when the number matches and the vendor and date are the same or left blank. The same
      // number appearing again further down is a second copy, which the duplicate rule must see.
      const last = order[order.length - 1];
      const d = invDate(r.date);
      let inv = last && last.invoiceNumber === r.invoice && (!r.vendor || r.vendor === last.vendorName) && (!d || d === last.date) ? last : null;
      if (!inv) {
        inv = { invoiceNumber: r.invoice, vendorName: r.vendor, poRef: r.po || '', date: invDate(r.date) || '', lines: [], subtotal: null, tax: null, total: null, _row: r._row };
        order.push(inv);
        if (!inv.date) warn('invoices', r._row, 'Date "' + r.date + '" not understood for invoice ' + r.invoice + '.');
      }
      if (!inv.poRef && r.po) inv.poRef = r.po;
      ['subtotal', 'tax', 'total'].forEach((f) => {
        const v = num(r[f]);
        if (v == null) return;
        if (inv[f] == null) inv[f] = v;
        else if (Math.abs(inv[f] - v) > 0.005) warn('invoices', r._row, 'Invoice ' + r.invoice + ' has two different ' + f + ' values.');
      });
      inv.lines.push({ sku: itemKey(r.sku, r.desc), desc: r.desc || r.sku, qty: qty, unitPrice: price });
    });
    const invoices = order.filter((inv) => {
      if (inv.total == null) { warn('invoices', inv._row, 'Invoice ' + inv.invoiceNumber + ' has no total. Skipped.'); return false; }
      return true;
    });
    invoices.forEach((inv) => {
      inv.lines.forEach((l) => { l.amount = E.round2(l.qty * l.unitPrice); });
      delete inv._row;
    });
    if (!invoices.length) problems.push({ level: 'error', file: LABEL.invoices, msg: 'No usable invoices found.' });
    if (!pos.length) problems.push({ level: 'error', file: LABEL.pos, msg: 'No usable purchase orders found.' });

    const hasError = problems.some((p) => p.level === 'error');
    return { data: hasError ? null : { vendors: Object.values(vendors), pos: pos, receipts: receipts, invoices: invoices, source: 'files' }, problems: problems };
  }

  // Turns an invented batch from engine.generate() into the three CSV files, in the template layout.
  function toFiles(batch, note) {
    const head = note ? '# ' + note + '\n' : '';
    const pos = batch.pos.flatMap((p) => p.lines.map((l) => ({ po_number: p.poNumber, vendor: p.vendorName, po_date: p.date, sku: l.sku, description: l.desc, qty: l.qty, unit_price: l.unitPrice })));
    const receipts = batch.receipts.flatMap((g) => g.lines.map((l) => ({ receipt_number: g.grnNumber, po_number: g.poNumber, receipt_date: g.date, sku: l.sku, qty_received: l.qtyReceived })));
    const invoices = batch.invoices.flatMap((v) => v.lines.map((l) => ({ invoice_number: v.invoiceNumber, vendor: v.vendorName, invoice_date: v.date, po_ref: v.poRef, sku: l.sku, description: l.desc, qty: l.qty, unit_price: l.unitPrice, subtotal: v.subtotal, tax: v.tax, total: v.total })));
    return { pos: head + E.toCsv(pos), receipts: head + E.toCsv(receipts), invoices: head + E.toCsv(invoices) };
  }

  const TEMPLATES = {
    pos: 'po_number,vendor,po_date,sku,description,qty,unit_price',
    receipts: 'receipt_number,po_number,receipt_date,sku,qty_received',
    invoices: 'invoice_number,vendor,invoice_date,po_ref,sku,description,qty,unit_price,subtotal,tax,total',
  };

  return { importFiles: importFiles, parseCsv: parseCsv, toFiles: toFiles, TEMPLATES: TEMPLATES, _num: num };
});
