/**
 * PriceTracker — Cloudflare Worker
 * Handles: REST API, cron daily check, scraping, email alerts.
 *
 * Secrets expected (set via `wrangler secret put`):
 *   SCRAPERAPI_KEY, RESEND_API_KEY, RESEND_TO_EMAIL, API_SECRET
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

    // POST /products/:id/manual-price  — save manual price + record in history
    const manualMatch = path.match(/^\/products\/([^/]+)\/manual-price$/);
    if (method === 'POST' && manualMatch)                    return saveManualPrice(request, env, manualMatch[1]);

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
  } catch { /* leave as-is if malformed */ }

  await env.DB.prepare(
    `INSERT INTO price_history (product_id, price, checked_at) VALUES (?, ?, ?)`
  ).bind(id, price, now).run();

  await env.DB.prepare(
    `UPDATE products SET last_price = ?, last_checked_at = ?, status = ?, url_results = ? WHERE id = ?`
  ).bind(price, now, newStatus, urlResults, id).run();

  return respond({ ok: true, price, status: newStatus });
}

async function getHistory(env, id) {
  const { results } = await env.DB.prepare(
    `SELECT price, checked_at FROM price_history
     WHERE product_id = ?
     ORDER BY checked_at ASC
     LIMIT 90`
  ).bind(id).all();
  return respond(results);
}

// ── Single-product check (used by both checkOne and runChecks) ────────────────

export async function checkProduct(product, env, { individualCheck = false } = {}) {
  const now   = new Date().toISOString();
  const today = now.slice(0, 10);

  const existingResults  = (() => { try { return JSON.parse(product.url_results || '[]'); } catch { return []; } })();
  const wasCheckedToday  = product.last_checked_at?.slice(0, 10) === today;

  let price      = null;
  let method     = null;
  let status     = 'error';
  let urlResults = [];

  try {
    const urls = product.url.split('\n').map(u => u.trim()).filter(Boolean);

    for (const u of urls) {
      const extracted = await extract(u, env.SCRAPERAPI_KEY);
      let { price: rPrice, method: rMethod } = extracted;

      // Carry forward today's manual entry if extraction still fails
      let rCheckedAt = null;
      if (rPrice == null) {
        const prev = existingResults.find(r => r.url === u);
        const isSingleUrlIndividual = urls.length === 1 && individualCheck;
        const manualEnteredToday = prev?.checked_at?.slice(0, 10) === today;
        if (prev?.method === 'manual' && manualEnteredToday && !isSingleUrlIndividual) {
          rPrice  = prev.price;
          rMethod = 'manual';
          // Keep the original entry stamp so later checks today still carry it forward
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
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}
