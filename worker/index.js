/**
 * PriceTracker — Cloudflare Worker
 * Handles: REST API, cron daily check, scraping, email alerts.
 *
 * Secrets expected (set via `wrangler secret put`):
 *   RESEND_API_KEY, RESEND_TO_EMAIL, API_SECRET
 *
 * The ScraperAPI key is NOT a secret — it's stored in the `settings` D1 table
 * and editable from the app's Settings screen (falls back to a SCRAPERAPI_KEY
 * secret if no setting has been saved yet, for backward compatibility).
 */

import { extract }     from './extract.js';
import { sendAlert }   from './email.js';
import { runChecks }   from './checker.js';

// ── Entry point ──────────────────────────────────────────────────────────────

export default {
  // HTTP requests from the PWA
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') return cors();

    // Auth: every request must carry `Authorization: Bearer <API_SECRET>`
    if (!authorized(request, env)) {
      return respond({ error: 'Unauthorized' }, 401);
    }

    // ── Route table ──────────────────────────────────────────────────────────
    const path = url.pathname.replace(/\/$/, '');

    // GET  /products
    if (method === 'GET'  && path === '/products')           return getProducts(env);

    // POST /products
    if (method === 'POST' && path === '/products')           return addProduct(request, env);

    // PATCH /products/:id
    const editMatch = path.match(/^\/products\/([^/]+)$/);
    if (method === 'PATCH' && editMatch)                     return editProduct(request, env, editMatch[1]);

    // DELETE /products/:id
    if (method === 'DELETE' && editMatch)                    return deleteProduct(env, editMatch[1]);

    // POST /products/:id/check  — check a single product now
    const checkOneMatch = path.match(/^\/products\/([^/]+)\/check$/);
    if (method === 'POST' && checkOneMatch)                  return checkOne(env, checkOneMatch[1]);

    // GET /products/:id/history  — price history for chart
    const historyMatch = path.match(/^\/products\/([^/]+)\/history$/);
    if (method === 'GET' && historyMatch)                    return getHistory(env, historyMatch[1]);

    // GET /products/:id/url-history  — per-URL diagnostic log
    const urlHistMatch = path.match(/^\/products\/([^/]+)\/url-history$/);
    if (method === 'GET' && urlHistMatch)                    return getUrlHistory(env, urlHistMatch[1]);

    // POST /products/:id/manual-price  — save manual price + record in history
    const manualMatch = path.match(/^\/products\/([^/]+)\/manual-price$/);
    if (method === 'POST' && manualMatch)                    return saveManualPrice(request, env, manualMatch[1]);

    // GET  /settings/scraperapi-key  — whether a key is saved (masked, never the raw value)
    if (method === 'GET'  && path === '/settings/scraperapi-key') return getScraperApiKeyStatus(env);

    // PUT  /settings/scraperapi-key  — save/replace the key
    if (method === 'PUT'  && path === '/settings/scraperapi-key') return setScraperApiKey(request, env);

    // DELETE /settings/scraperapi-key  — clear the saved key
    if (method === 'DELETE' && path === '/settings/scraperapi-key') return clearScraperApiKey(env);

    return respond({ error: 'Not found' }, 404);
  },

  // Cron trigger — runs daily
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runChecks(env));
  },
};

// ── Auth helper ──────────────────────────────────────────────────────────────

function authorized(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token  = header.replace(/^Bearer\s+/i, '');
  return token && token === env.API_SECRET;
}

// ── Route handlers ───────────────────────────────────────────────────────────

async function getProducts(env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM products ORDER BY created_at DESC`
  ).all();
  return respond(results);
}

async function addProduct(request, env) {
  const body = await request.json().catch(() => null);
  if (!body?.name || !body?.url || body?.target_price == null) {
    return respond({ error: 'name, url, and target_price are required' }, 400);
  }

  const id  = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO products (id, name, url, target_price, currency, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`
  ).bind(id, body.name, body.url, Number(body.target_price), body.currency || 'AUD', now).run();

  // Kick off an immediate first check (don't await — return fast)
  const { results } = await env.DB.prepare(
    `SELECT * FROM products WHERE id = ?`
  ).bind(id).all();

  return respond(results[0], 201);
}

async function editProduct(request, env, id) {
  const body = await request.json().catch(() => null);
  if (!body) return respond({ error: 'Invalid JSON' }, 400);

  const fields = [];
  const values = [];

  if (body.name         != null) { fields.push('name = ?');         values.push(body.name); }
  if (body.url          != null) { fields.push('url = ?');          values.push(body.url); }
  if (body.target_price != null) { fields.push('target_price = ?'); values.push(Number(body.target_price)); }
  if (body.last_price   != null) { fields.push('last_price = ?');   values.push(Number(body.last_price)); }
  if (body.status       != null) { fields.push('status = ?');       values.push(body.status); }
  if (body.url_results  != null) { fields.push('url_results = ?');  values.push(body.url_results); }
  if (body.active       != null) { fields.push('active = ?');       values.push(body.active ? 1 : 0); }

  if (fields.length === 0) return respond({ error: 'Nothing to update' }, 400);

  values.push(id);
  await env.DB.prepare(
    `UPDATE products SET ${fields.join(', ')} WHERE id = ?`
  ).bind(...values).run();

  const { results } = await env.DB.prepare(
    `SELECT * FROM products WHERE id = ?`
  ).bind(id).all();

  if (!results.length) return respond({ error: 'Not found' }, 404);
  return respond(results[0]);
}

async function deleteProduct(env, id) {
  await env.DB.prepare(`DELETE FROM products WHERE id = ?`).bind(id).run();
  return respond({ ok: true });
}

async function checkOne(env, id) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM products WHERE id = ?`
  ).bind(id).all();
  if (!results.length) return respond({ error: 'Not found' }, 404);

  const product = results[0];
  const result  = await checkProduct(product, env, { individualCheck: true });
  return respond(result);
}

async function saveManualPrice(request, env, id) {
  const body = await request.json().catch(() => null);
  if (!body?.price || isNaN(body.price)) return respond({ error: 'price required' }, 400);

  const { results } = await env.DB.prepare(`SELECT * FROM products WHERE id = ?`).bind(id).all();
  if (!results.length) return respond({ error: 'Not found' }, 404);

  const product   = results[0];
  const price     = Number(body.price);
  const now       = new Date().toISOString();
  let   newStatus  = price <= product.target_price ? 'target_hit' : 'ok';

  // Stamp each manual entry with today's date so carry-forward can check it
  let urlResults = body.url_results ?? product.url_results;
  try {
    const parsed = JSON.parse(urlResults || '[]');
    const stamped = parsed.map(r => r.method === 'manual' && r.price != null ? { ...r, checked_at: now } : r);
    urlResults = JSON.stringify(stamped);
    // Other URLs still missing a price → keep prompting (target_hit keeps priority)
    if (newStatus === 'ok' && stamped.some(r => r.price == null)) newStatus = 'needs_attention';

    // Diagnostic log for manual entries (mirrors checkProduct's per-URL log)
    const manualRows = stamped.filter(r => r.method === 'manual' && r.price != null);
    if (manualRows.length) {
      await env.DB.batch(manualRows.map(r =>
        env.DB.prepare(
          `INSERT INTO url_check_log (product_id, url, price, method, checked_at) VALUES (?, ?, ?, 'manual', ?)`
        ).bind(id, r.url, r.price, now)
      ));
    }
  } catch { /* leave as-is if malformed */ }

  await env.DB.prepare(
    `INSERT INTO price_history (product_id, price, checked_at) VALUES (?, ?, ?)`
  ).bind(id, price, now).run();

  await env.DB.prepare(
    `UPDATE products SET last_price = ?, last_checked_at = ?, status = ?, url_results = ? WHERE id = ?`
  ).bind(price, now, newStatus, urlResults, id).run();

  return respond({ ok: true, price, status: newStatus });
}

// ── Settings (ScraperAPI key) ────────────────────────────────────────────────

async function getSetting(env, key) {
  const { results } = await env.DB.prepare(
    `SELECT value FROM settings WHERE key = ?`
  ).bind(key).all();
  return results[0]?.value ?? null;
}

async function setSetting(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(key, value).run();
}

// Falls back to the SCRAPERAPI_KEY secret if nothing has been saved via the
// Settings screen yet, so existing deployments keep working unchanged.
async function getScraperApiKey(env) {
  const saved = await getSetting(env, 'scraperapi_key');
  return saved || env.SCRAPERAPI_KEY || null;
}

async function getScraperApiKeyStatus(env) {
  const key = await getScraperApiKey(env);
  return respond({ saved: !!key, last4: key ? key.slice(-4) : null });
}

async function setScraperApiKey(request, env) {
  const body = await request.json().catch(() => null);
  const key  = body?.key?.trim();
  if (!key) return respond({ error: 'key required' }, 400);

  await setSetting(env, 'scraperapi_key', key);
  return respond({ saved: true, last4: key.slice(-4) });
}

async function clearScraperApiKey(env) {
  await env.DB.prepare(`DELETE FROM settings WHERE key = 'scraperapi_key'`).run();
  return respond({ saved: false, last4: null });
}

async function getHistory(env, id) {
  // Fetch the most recent 90 rows (DESC), then reverse to ascending order for
  // the chart. Querying ASC+LIMIT directly would return the OLDEST 90 rows
  // instead once a product passes 90 total checks, permanently freezing the
  // chart at whatever date that cap was first hit.
  const { results } = await env.DB.prepare(
    `SELECT price, checked_at FROM price_history
     WHERE product_id = ?
     ORDER BY checked_at DESC
     LIMIT 90`
  ).bind(id).all();
  return respond(results.reverse());
}

async function getUrlHistory(env, id) {
  const { results } = await env.DB.prepare(
    `SELECT url, price, method, checked_at FROM url_check_log
     WHERE product_id = ?
     ORDER BY checked_at DESC
     LIMIT 100`
  ).bind(id).all();
  return respond(results);
}

// ── Single-product check (used by both checkOne and runChecks) ────────────────

export async function checkProduct(product, env, { individualCheck = false } = {}) {
  const now = new Date().toISOString();

  const existingResults = (() => { try { return JSON.parse(product.url_results || '[]'); } catch { return []; } })();

  let price      = null;
  let method     = null;
  let status     = 'error';
  let urlResults = [];

  try {
    const urls        = product.url.split('\n').map(u => u.trim()).filter(Boolean);
    const scraperApiKey = await getScraperApiKey(env);

    for (const u of urls) {
      const extracted = await extract(u, scraperApiKey);
      let { price: rPrice, method: rMethod } = extracted;

      // Carry forward a manual entry if it's less than 24h old and extraction still fails
      let rCheckedAt = null;
      if (rPrice == null) {
        const prev = existingResults.find(r => r.url === u);
        const isSingleUrlIndividual = urls.length === 1 && individualCheck;
        const manualEntryAgeMs = prev?.checked_at ? Date.parse(now) - Date.parse(prev.checked_at) : Infinity;
        const manualStillFresh = manualEntryAgeMs < 24 * 3600 * 1000;
        if (prev?.method === 'manual' && manualStillFresh && !isSingleUrlIndividual) {
          rPrice  = prev.price;
          rMethod = 'manual';
          // Keep the original entry stamp so the 24h window is measured from
          // when the price was actually entered, not from this check
          rCheckedAt = prev.checked_at;
        }
      }

      urlResults.push({ url: u, price: rPrice, method: rMethod, ...(rCheckedAt ? { checked_at: rCheckedAt } : {}) });
      if (rPrice != null && (price === null || rPrice < price)) {
        price  = rPrice;
        method = rMethod;
      }
    }

    const anyMissing = urlResults.some(r => r.price == null);

    if (price != null) {
      // Determine status
      if (price <= product.target_price) {
        status = 'target_hit';

        // Send alert only if we haven't already sent one for this price level
        const { results: recent } = await env.DB.prepare(
          `SELECT id FROM alerts_sent
           WHERE product_id = ? AND price <= ?
           ORDER BY sent_at DESC LIMIT 1`
        ).bind(product.id, product.target_price).all();

        if (!recent.length) {
          await sendAlert({ product, price }, env);
          await env.DB.prepare(
            `INSERT INTO alerts_sent (product_id, price, sent_at) VALUES (?, ?, ?)`
          ).bind(product.id, price, now).run();
        }
      } else {
        status = 'ok';
      }

      // If any URL is still missing a price, hold off on the history row and
      // flag for manual entry instead — the price found so far might not be
      // the true best price once the missing URL is filled in.
      // (target_hit keeps priority so the alert badge isn't hidden)
      if (anyMissing && status === 'ok') {
        status = 'needs_attention';
      } else {
        // Write history row only once we have a complete picture
        await env.DB.prepare(
          `INSERT INTO price_history (product_id, price, checked_at) VALUES (?, ?, ?)`
        ).bind(product.id, price, now).run();
      }
    } else {
      status = 'needs_attention';
    }
  } catch (err) {
    console.error(`checkProduct error for ${product.id}:`, err.message);
    status = 'error';
  }

  // Diagnostic log: what each URL returned this check (price NULL = failed).
  // Never let a logging failure break the check itself.
  try {
    if (urlResults.length) {
      await env.DB.batch(urlResults.map(r =>
        env.DB.prepare(
          `INSERT INTO url_check_log (product_id, url, price, method, checked_at) VALUES (?, ?, ?, ?, ?)`
        ).bind(product.id, r.url, r.price ?? null, r.method ?? null, now)
      ));
    }
  } catch (err) {
    console.error(`url_check_log insert failed for ${product.id}:`, err.message);
  }

  // Update product row
  await env.DB.prepare(
    `UPDATE products
     SET last_price = ?, last_checked_at = ?, status = ?, extraction_method = ?, url_results = ?
     WHERE id = ?`
  ).bind(price, now, status, method, JSON.stringify(urlResults ?? []), product.id).run();

  return { id: product.id, name: product.name, price, status, method, checked_at: now, url_results: urlResults ?? [] };
}

// ── Utilities ────────────────────────────────────────────────────────────────

function respond(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function cors() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}
