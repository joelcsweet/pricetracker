/**
 * Runs price checks for all products (called by cron and /check-all).
 */
import { checkProduct } from './index.js';

export async function runChecks(env) {
  const { results: products } = await env.DB.prepare(
    `SELECT * FROM products`
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
