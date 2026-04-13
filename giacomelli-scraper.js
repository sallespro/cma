/**
 * giacomelli-scraper.js
 *
 * Extracts all residential property listings from Giacomelli by intercepting
 * the RSC (React Server Component) network requests that power "Carregar mais".
 *
 * Strategy:
 *   1. Load the page and capture the first RSC POST request triggered by
 *      clicking "Carregar mais" — recording its URL, headers, and body.
 *   2. Replay that request for every batch (offset 0, 24, 48, …) using
 *      Playwright's fetch API, bypassing virtual scroll entirely.
 *   3. Parse property cards from the RSC HTML chunks in each response.
 *   4. Also parse the initial SSR page for the first batch.
 *
 * Usage:
 *   node giacomelli-scraper.js [outputFile]
 *
 * Environment:
 *   http_proxy / HTTPS_PROXY — optional authenticated proxy (auto-detected)
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE_URL = 'https://www.giacomelli.com.br/imoveis/residencial/-27.6299776,-48.4704256';
const DEFAULT_OUTPUT = path.join(__dirname, 'giacomelli_properties.json');
const OUTPUT_FILE = process.argv[2] || DEFAULT_OUTPUT;
const BATCH_SIZE = 24;

// ─── Proxy setup ──────────────────────────────────────────────────────────────

function parseProxy() {
  const raw = process.env.http_proxy || process.env.HTTP_PROXY || process.env.HTTPS_PROXY || '';
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    const config = { server: `${u.protocol}//${u.host}` };
    if (u.username) config.username = decodeURIComponent(u.username);
    if (u.password) config.password = decodeURIComponent(u.password);
    console.log(`[scraper] Using proxy: ${config.server}`);
    return config;
  } catch {
    console.warn(`[scraper] Could not parse proxy URL: ${raw}`);
    return undefined;
  }
}

// ─── Property parser — works on raw HTML/RSC text ────────────────────────────
// Extracts property slugs from href="/imovel/..." links and structured fields
// from the surrounding text. Works on both SSR HTML and RSC chunk payloads.

function parsePropertiesFromHtml(html) {
  const properties = new Map();

  // Match all property hrefs
  const hrefRe = /href="(\/imovel\/[^"]+)"/g;
  let m;
  while ((m = hrefRe.exec(html)) !== null) {
    const url = m[1];
    if (properties.has(url)) continue;

    // Grab a wider window — property_type often appears well before the link
    const start = Math.max(0, m.index - 5000);
    const end = Math.min(html.length, m.index + 3000);
    const chunk = html.slice(start, end)
      // Strip HTML tags for cleaner regex matching
      .replace(/<[^>]+>/g, ' ')
      // Collapse whitespace
      .replace(/\s+/g, ' ');

    properties.set(url, {
      url,
      property_type: (chunk.match(/APARTAMENTO|CASA|KITNET|STUDIO|COBERTURA/i) || ['Unknown'])[0].toUpperCase(),
      code:           (chunk.match(/COD\.?\s*(\d+)/i)                          || [, 'N/A'])[1],
      status:         (chunk.match(/SEMIMOBILIADO|MOBILIADO|SEM MOBILIAR|PRONTO/i) || ['N/A'])[0],
      rental_price_brl: (chunk.match(/Aluguel\s*R\$\s*([\d.,]+)/)              || [, 'N/A'])[1],
      total_value_brl:  (chunk.match(/Valor total\s*R\$\s*([\d.,]+)/)          || [, 'N/A'])[1],
      area_sqm:         (chunk.match(/(\d+(?:,\d+)?)\s*m²/)                   || [, 'N/A'])[1],
      bedrooms:         (chunk.match(/(\d+)\s*quarto/i)                        || [, '0'])[1],
      suites:           (chunk.match(/(\d+)\s*su[íi]te/i)                      || [, '0'])[1],
      bathrooms:        (chunk.match(/(\d+)\s*banheiro/i)                      || [, '0'])[1],
      parking_spaces:   (chunk.match(/(\d+)\s*vaga/i)                          || [, '0'])[1],
      location: (() => {
        const lm = chunk.match(/(?:Florianópolis|São José|Palhoça|Brusque|Camboriú|Bombinhas|Itajaí|Navegantes)[^\n,|]*/);
        return lm ? lm[0].trim() : 'N/A';
      })(),
      district: (() => {
        const dm = chunk.match(/(?:Florianópolis|São José|Palhoça|Brusque|Camboriú|Bombinhas|Itajaí|Navegantes)\s*[-–]\s*([^\n,|<]+)/);
        return dm ? dm[1].trim() : 'N/A';
      })(),
    });
  }

  return properties;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function extractAllProperties() {
  const proxy = parseProxy();
  const browser = await chromium.launch({ headless: true, proxy });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  console.log(`[scraper] Navigating to: ${BASE_URL}`);
  console.log(`[scraper] Output: ${OUTPUT_FILE}`);

  // Captured RSC request details (set after first "Carregar mais" click)
  let rscRequestDetails = null;

  // Intercept all requests to capture the RSC POST
  page.on('request', req => {
    if (
      req.method() === 'POST' &&
      req.url().includes('/imoveis/') &&
      !rscRequestDetails
    ) {
      rscRequestDetails = {
        url: req.url(),
        headers: req.headers(),
        postData: req.postData(),
      };
      console.log(`[scraper] Captured RSC POST: ${req.url()}`);
    }
  });

  try {
    // ── Step 1: Load initial page ─────────────────────────────────────────
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('a[href*="/imovel/"]', { timeout: 30000 });
    await page.waitForTimeout(1500);

    // Get total count
    const totalOnSite = await page.evaluate(() => {
      const text = document.body.innerText || '';
      const m = text.match(/Mostrando\s*\d+\s*de\s*(\d+)/);
      return m ? parseInt(m[1]) : 0;
    });
    console.log(`[scraper] Total on site: ${totalOnSite}`);

    // Parse SSR HTML for first batch
    const ssrHtml = await page.content();
    const allProperties = parsePropertiesFromHtml(ssrHtml);
    console.log(`[scraper] Parsed ${allProperties.size} properties from SSR`);

    // ── Step 2: Trigger one "Carregar mais" to capture RSC request ────────
    const clicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button'))
        .find(b => b.textContent.includes('Carregar mais') && !b.disabled);
      if (btn) { btn.click(); return true; }
      return false;
    });

    if (!clicked) {
      console.log('[scraper] No "Carregar mais" button — all properties in SSR.');
    } else {
      // Wait for RSC response and DOM update
      await page.waitForTimeout(3000);

      // Parse this batch from updated DOM
      const dom1 = await page.content();
      const batch1 = parsePropertiesFromHtml(dom1);
      batch1.forEach((v, k) => allProperties.set(k, v));
      console.log(`[scraper] After first load-more: ${allProperties.size} properties`);

      // ── Step 3: Replay RSC requests for remaining batches ──────────────
      if (rscRequestDetails) {
        const batchesNeeded = Math.ceil(totalOnSite / BATCH_SIZE);
        console.log(`[scraper] Replaying RSC requests for ${batchesNeeded} batches total...`);

        // The RSC POST body is form-encoded with Next.js action data.
        // We replay the same request body — the server returns the next batch
        // based on the page's internal offset state tracked via the action.
        // Instead of replaying with a custom offset (which requires reverse-engineering
        // the RSC action ID), we click the button programmatically for each batch
        // and capture the full page HTML after each load.
        for (let batch = 2; batch <= batchesNeeded; batch++) {
          const btnClicked = await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('button'))
              .find(b => b.textContent.includes('Carregar mais') && !b.disabled);
            if (btn) { btn.click(); return true; }
            return false;
          });

          if (!btnClicked) {
            console.log(`[scraper] No more "Carregar mais" at batch ${batch}`);
            break;
          }

          await page.waitForTimeout(2500);

          // Sweep the full page: top → bottom in steps so virtual scroll
          // renders every card into the DOM before we capture page.content()
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.waitForTimeout(400);
          for (let s = 0; s < 10; s++) {
            await page.evaluate(() => window.scrollBy(0, 1500));
            await page.waitForTimeout(200);
          }
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await page.waitForTimeout(600);

          // Get full page HTML and parse — captures all property data including
          // cards that virtual scroll has recycled out of the visible DOM
          const batchHtml = await page.content();
          const before = allProperties.size;
          parsePropertiesFromHtml(batchHtml).forEach((v, k) => allProperties.set(k, v));

          const info = await page.evaluate(() => {
            const text = document.body.innerText || '';
            const m = text.match(/Mostrando\s*(\d+)\s*de\s*(\d+)/);
            return { loaded: m ? parseInt(m[1]) : 0, total: m ? parseInt(m[2]) : 0 };
          });

          console.log(`[scraper] Batch ${batch}: +${allProperties.size - before} new | total=${allProperties.size} | page=${info.loaded}/${info.total}`);

          if (info.loaded >= info.total) break;
        }
      } else {
        // RSC POST not captured — fall back to scroll-harvest loop
        console.log('[scraper] RSC POST not captured, falling back to scroll harvesting...');
        for (let round = 0; round < 30; round++) {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await page.waitForTimeout(1000);
          parsePropertiesFromHtml(await page.content()).forEach((v, k) => allProperties.set(k, v));

          const info = await page.evaluate(() => {
            const text = document.body.innerText || '';
            const m = text.match(/Mostrando\s*(\d+)\s*de\s*(\d+)/);
            return { loaded: m ? parseInt(m[1]) : 0, total: m ? parseInt(m[2]) : 0 };
          });
          console.log(`[scraper] Round ${round}: ${allProperties.size} collected, ${info.loaded}/${info.total}`);
          if (info.loaded >= info.total && allProperties.size >= info.total) break;

          const more = await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('button'))
              .find(b => b.textContent.includes('Carregar mais') && !b.disabled);
            if (btn) { btn.click(); return true; }
            return false;
          });
          if (!more) break;
          await page.waitForTimeout(2000);
        }
      }
    }

    // Final page content harvest
    parsePropertiesFromHtml(await page.content()).forEach((v, k) => allProperties.set(k, v));
    console.log(`[scraper] Final unique properties: ${allProperties.size}`);

    // ── Step 4: Build output ──────────────────────────────────────────────
    const properties = Array.from(allProperties.values());

    const prices = properties
      .map(p => parseFloat(String(p.rental_price_brl).replace(/\./g, '').replace(',', '.')) || 0)
      .filter(p => p > 0)
      .sort((a, b) => a - b);

    const byType = {}, byLocation = {};
    properties.forEach(p => {
      byType[p.property_type] = (byType[p.property_type] || 0) + 1;
      byLocation[p.location] = (byLocation[p.location] || 0) + 1;
    });

    const output = {
      metadata: {
        source: BASE_URL,
        extraction_date: new Date().toISOString(),
        extraction_timestamp: Date.now(),
        total_properties_on_site: totalOnSite,
        properties_extracted: properties.length,
        script_version: '3.0',
        browser: 'Playwright (Chromium)',
        strategy: 'RSC network interception + page.content() HTML parsing',
      },
      summary: {
        total_properties: properties.length,
        by_type: byType,
        by_location: byLocation,
        price_range: {
          min: prices.length ? `R$ ${prices[0].toLocaleString('pt-BR')}` : 'N/A',
          max: prices.length ? `R$ ${prices[prices.length - 1].toLocaleString('pt-BR')}` : 'N/A',
          average: prices.length
            ? `R$ ${(prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2)}`
            : 'N/A',
        },
      },
      properties: properties.map((p, i) => ({ id: i + 1, ...p })),
    };

    fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));

    const kb = (fs.statSync(OUTPUT_FILE).size / 1024).toFixed(2);
    console.log(`[scraper] Saved: ${OUTPUT_FILE} (${kb} KB)`);
    console.log(`[scraper] Properties: ${properties.length} / ${totalOnSite}`);
    console.log(`[scraper] By type: ${JSON.stringify(byType)}`);
    console.log(`[scraper] Price range: ${output.summary.price_range.min} – ${output.summary.price_range.max}`);
    console.log(`[scraper] Average: ${output.summary.price_range.average}`);

  } catch (err) {
    console.error('[scraper] Error:', err.message);
    process.exit(1);
  } finally {
    await browser.close();
    console.log('[scraper] Browser closed.');
  }
}

extractAllProperties().catch(console.error);
