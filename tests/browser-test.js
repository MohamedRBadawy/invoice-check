// Browser check of index.html. Run: NODE_PATH=$(npm root -g) node tests/browser-test.js
const path = require('path');
const { chromium } = require('playwright');
(async () => {
  const dir = path.join(__dirname, '..');
  const b = await chromium.launch();
  const errors = [], log = [];
  const p = await b.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await p.goto('file://' + dir + '/index.html');
  const kpi = async () => (await p.$$eval('#kpis .kpi .n', (els) => els.map((e) => e.textContent))).join(' | ');
  log.push('Sample on load: ' + await kpi());
  await p.click('#tabs button[data-tab=key]');
  log.push('Answer key: ' + (await p.textContent('#tab-key .kpi .n')));
  await p.screenshot({ path: dir + '/screenshots/sample-desktop.png', fullPage: true });

  // Load the sample CSV files as if they were the user's own files.
  await p.setInputFiles('#fPos', dir + '/sample/purchase-orders.csv');
  await p.setInputFiles('#fRec', dir + '/sample/receipts.csv');
  await p.setInputFiles('#fInv', dir + '/sample/invoices.csv');
  await p.click('#useFiles');
  await p.waitForTimeout(300);
  log.push('Same data loaded as files: ' + await kpi());
  log.push('Banner: ' + (await p.textContent('#banner')));
  log.push('Answer key tab hidden for files: ' + await p.$eval('#keyTab', (e) => e.hidden));
  await p.click('#tabs button[data-tab=ex]');
  await p.click('#tab-ex tbody tr');
  log.push('Detail opened: ' + (await p.textContent('#detailTitle')));
  await p.screenshot({ path: dir + '/screenshots/files-detail.png', fullPage: false });
  await p.click('#tabs button[data-tab=data]');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('[data-dl=exceptions]')]);
  const txt = require('fs').readFileSync(await dl.path(), 'utf8');
  log.push('Exceptions CSV: ' + (txt.trim().split('\n').length - 1) + ' rows, header: ' + txt.split('\n')[0]);

  // A broken file must be reported, not guessed.
  const tmp = path.join(require('os').tmpdir(), 'broken-pos.csv');
  require('fs').writeFileSync(tmp, 'order,who\n1,x\n');
  await p.setInputFiles('#fPos', tmp);
  await p.click('#useFiles');
  await p.waitForTimeout(300);
  log.push('Broken file message: ' + (await p.textContent('#problems')).slice(0, 140));
  log.push('Results hidden after broken file: ' + await p.$eval('#results', (e) => e.hidden));

  await p.setViewportSize({ width: 390, height: 844 });
  await p.click('#useSample');
  const sw = await p.evaluate(() => document.documentElement.scrollWidth);
  log.push('Phone width 390: page scroll width ' + sw);
  await p.screenshot({ path: dir + '/screenshots/sample-phone.png', fullPage: false });
  log.push('Errors: ' + (errors.length ? errors.join('; ') : 'none'));
  console.log(log.join('\n'));
  await b.close();
})();
