import { Actor, Dataset, log } from 'apify';
import { PlaywrightCrawler, sleep } from 'crawlee';

const START_URL = 'https://www.bioladen.de/bio-haendler-suche';

const SEL = {
  inputZip: 'input[placeholder*="Postleitzahl" i], input[aria-label*="Postleitzahl" i], input[name*="plz" i]',
  radiusSelect: 'select, [role="combobox"] select',
  findButton: 'button:has-text("BIO-H"), button:has-text("HÄNDLER FINDEN"), button:has-text("Händler finden")',
  resultsContainer: '[class*="result"], [class*="list"], [data-results], main',
  detailsButton: 'a:has-text("DETAILS"), button:has-text("DETAILS"), a:has-text("Details")',
  toggleBiolaeden: 'text=Bioläden',
  toggleMarktstaende: 'text=Marktstände',
  toggleLieferservice: 'text=Lieferservice'
};

function normalizeSpace(s) { return (s || '').replace(/[\s\u00A0]+/g, ' ').trim(); }

function parseAddress(lines) {
  const ln = lines.map(normalizeSpace).filter(Boolean);
  let street = null, zip = null, city = null, country = 'DE';
  if (ln.length >= 2) {
    street = ln[0];
    const m = ln[1].match(/(\d{5})\s+(.+)/);
    if (m) { zip = m[1]; city = m[2]; }
    else { city = ln[1]; }
  } else if (ln.length === 1) {
    street = ln[0];
  }
  return { street, zip, city, country };
}

function dedupKey(item, mode) {
  if (mode === 'detailUrl') return (item.detailUrl || '').toLowerCase().trim();
  return `${(item.name||'').toLowerCase().trim()}|${(item.street||'').toLowerCase().trim()}|${(item.zip||'').trim()}`;
}

async function ensureOn(page, locatorText) {
  // Try to click the toggle for a category. Robust to various UI widgets.
  const el = page.locator(`text=${locatorText}`);
  if (await el.count() === 0) return;
  // If there's an adjacent switch, click it; otherwise click the label itself.
  const parent = el.first().locator('xpath=ancestor::*[self::label or self::*][1]');
  const candidate = parent.locator('xpath=.//input[@type="checkbox" or @type="radio"]/.. | .//*[contains(@class,"toggle") or contains(@class,"switch") or contains(@role,"switch")]');
  try {
    if (await candidate.count()) await candidate.first().click({ force: true });
    else await el.first().click({ force: true });
    await sleep(300);
  } catch {}
}

async function selectRadius(page, radiusKm) {
  // Prefer native select; otherwise try to open a custom dropdown.
  const sel = page.locator('select');
  if (await sel.count()) {
    const valueTexts = await sel.first().locator('option').allTextContents();
    // find option text with e.g. "25 km"
    let idx = valueTexts.findIndex(t => (t||'').includes(`${radiusKm}`));
    if (idx < 0 && valueTexts.length) idx = 0;
    await sel.first().selectOption({ index: Math.max(0, idx) });
    return;
  }
  // Fallback: click combobox by text then pick option
  const combo = page.locator('[role="combobox"]');
  if (await combo.count()) {
    await combo.first().click();
    const opt = page.locator(`text="${radiusKm} km"`);
    if (await opt.count()) await opt.first().click();
  }
}

async function fillZip(page, postalCode) {
  const input = page.locator(SEL.inputZip).first();
  await input.fill('');
  await input.type(String(postalCode), { delay: 50 });
}

async function triggerSearch(page) {
  const btn = page.locator(SEL.findButton).first();
  await btn.click();
}

async function waitForResults(page) {
  // Wait for any card-like items to appear
  await page.waitForTimeout(1000);
  await page.waitForLoadState('networkidle');
}

async function autoScroll(page, maxSteps = 20) {
  for (let i = 0; i < maxSteps; i++) {
    const before = await page.evaluate(() => document.body.scrollHeight);
    await page.mouse.wheel(0, 1500);
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => document.body.scrollHeight);
    if (after <= before) break;
  }
}

async function extractItems(page) {
  // Heuristic extraction: find repeated blocks with "DETAILS" or distance in (x,x km)
  const items = await page.evaluate(() => {
    const norm = (s) => (s || '').replace(/[\s\u00A0]+/g, ' ').trim();
    const blocks = [];
    const candidates = Array.from(document.querySelectorAll('article, li, .card, .result, .store, .dealer, .entry')).filter(n => {
      const t = n.textContent || '';
      return /DETAILS/i.test(t) || /\(\s*\d+[\.,]\d+\s*km\s*\)/i.test(t) || /Hamburg|Berlin|München|km\)/i.test(t);
    });
    const unique = [...new Set(candidates.map(n => n.closest('article, li, .card, .result, .store, .dealer, .entry') || n))];
    unique.forEach(n => {
      const nameEl = n.querySelector('h3, h2, .title, .name, [class*="title"]');
      const name = norm(nameEl ? nameEl.textContent : '');
      const detA = n.querySelector('a[href*="http"]:not([href*="facebook.com"]):not([href*="instagram.com"])') || n.querySelector('a[href^="/"]');
      const detailUrl = detA ? detA.href : null;
      // find address lines (street, zip/city)
      const addrCand = Array.from(n.querySelectorAll('p, .address, address, .addr')).map(e => norm(e.textContent)).filter(x => x.length >= 6);
      // prefer address blocks that contain a 5-digit zip
      const addr = addrCand.find(x => /\b\d{5}\b/.test(x)) || addrCand[0] || '';
      let street = null, zip = null, city = null;
      const parts = addr.split(/\n|·|\|/).map(norm).filter(Boolean);
      if (parts.length >= 2) {
        street = parts[0];
        const m = parts[1].match(/(\d{5})\s+(.+)/);
        if (m) { zip = m[1]; city = m[2]; } else { city = parts[1]; }
      }
      const phone = (n.textContent.match(/\+?\d[\d\s\-\(\)]{6,}/) || [null])[0];
      const distance = (n.textContent.match(/\((\s*\d+[\.,]\d+)\s*km\)/i) || [null, null])[1];
      const opening = (() => {
        const m = (n.textContent || '').match(/(Mo|Di|Mi|Do|Fr|Sa|So)[^\n]{0,40}\d{1,2}[:\.]\d{2}/i);
        return m ? m[0] : null;
      })();
      blocks.push({
        name, street, zip, city, country: 'DE',
        lat: null, lng: null,
        phone: phone && norm(phone),
        email: null,
        website: null,
        openingHours: opening,
        detailUrl,
        source: 'bioladen.de',
        scrapedAt: new Date().toISOString(),
        distanceKm: distance ? Number(distance.replace(',', '.')) : null,
        category: null
      });
    });
    return blocks.filter(b => b.name || b.street || b.detailUrl);
  });

  // Try to backfill category & website via per-item DOM when possible
  // (We keep it simple here; deep per-item navigation can be added later.)
  return items;
}

await Actor.main(async () => {
  const input = await Actor.getInput() || {};
  const {
    postalCodes = ['20095'],
    radiusKm = 25,
    filters = { biolaeden: true, marktstaende: true, lieferservice: true },
    deduplicateBy = 'detailUrl',
    maxConcurrency = 1
  } = input;

  log.setLevel(log.LEVELS.INFO);
  log.info('Bioladen.de Händlersuche – Run startet…');
  log.info(`Config: radius=${radiusKm}km, filters=${JSON.stringify(filters)}, concurrency=${maxConcurrency}`);

  const seen = new Set();
  const crawler = new PlaywrightCrawler({
    maxConcurrency,
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 180,
    useSessionPool: true,
    headless: true,
    launchContext: {
      launchOptions: {
        args: ['--disable-dev-shm-usage'],
      },
    },
    requestHandler: async ({ page, request }) => {
      const { postalCode } = request.userData;
      log.info(`>> ${postalCode}: öffne Seite…`);
      await page.goto(START_URL, { waitUntil: 'domcontentloaded' });

      // Cookie banner weg
      try {
        const cookieBtn = page.locator('button:has-text("Akzeptieren"), button:has-text("Einverstanden"), [id*="accept"]');
        if (await cookieBtn.count()) await cookieBtn.first().click({ timeout: 2000 });
      } catch {}

      // Eingaben setzen
      await fillZip(page, postalCode);
      await selectRadius(page, radiusKm);

      // Filter togglen (best effort)
      if (filters.biolaeden) await ensureOn(page, 'Bioläden');
      if (filters.marktstaende) await ensureOn(page, 'Marktstände');
      if (filters.lieferservice) await ensureOn(page, 'Lieferservice');

      // Suche auslösen
      await triggerSearch(page);
      await waitForResults(page);
      await autoScroll(page, 20);

      const items = await extractItems(page);
      let kept = 0, dropped = 0;
      for (const it of items) {
        const key = dedupKey(it, deduplicateBy);
        if (key && seen.has(key)) { dropped++; continue; }
        if (key) seen.add(key);
        await Dataset.pushData(it);
        kept++;
      }
      log.info(`<< ${postalCode}: saved=${kept}, dedup_dropped=${dropped}`);
      await page.close();
    }
  });

  const requests = postalCodes.map(pc => ({ url: START_URL, userData: { postalCode: String(pc) } }));
  await crawler.run(requests);

  log.info('Fertig.');
});
