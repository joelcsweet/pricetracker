/**
 * Runs price checks for all active products (called by the daily cron).
 */
import { checkProduct } from './index.js';

export async function runChecks(env) {
  // Prune diagnostic log entries older than 90 days
  try {
    const cutoff = new Date(Date.now() - 90 * 86400 * 1000).toISOString();
    await env.DB.prepare(`DELETE FROM url_check_log WHERE checked_at < ?`).bind(cutoff).run();
  } catch (err) {
    console.error('url_check_log prune failed:', err.message);
  }

  const { results: products } = await env.DB.prepare(
    `SELECT * FROM products WHERE active = 1`
  ).all();

  const results = await Promise.allSettled(
    products.map(p => checkProduct(p, env))
  );

  const summary = results.map((r, i) => ({
    id:     products[i].id,
    name:   products[i].name,
    status: r.status === 'fulfilled' ? r.value.status : 'error',
    price:  r.status === 'fulfilled' ? r.value.price  : null,
  }));

  console.log(`runChecks complete: ${products.length} products checked`);
  return { checked: products.length, results: summary };
}
