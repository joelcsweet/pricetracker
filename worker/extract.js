/**
 * Price extraction cascade.
 * Returns { price: number|null, method: string|null }
 *
 * Order:
 *  1. Direct fetch (free) → JSON-LD → microdata → meta tags → heuristic
 *  2. ScraperAPI fetch (costs credits) → same pipeline, only if direct fetch
 *     returned no usable HTML or all extraction methods failed
 *  3. null → caller sets status = needs_attention
 */

const SCRAPERAPI_BASE = 'https://api.scraperapi.com';

export async function extract(url, apiKey) {
  // ── Pass 1: free direct fetch ────────────────────────────────────────────
  const directHtml = await fetchDirect(url);
  if (directHtml) {
    const result = runCascade(directHtml, /* viaScraper= */ false, url);
    if (result.price != null) return result;
  }

  // ── Pass 2: ScraperAPI with JS rendering (fallback) ──────────────────────
  if (!apiKey) return { price: null, method: null };

  console.log(`Direct fetch failed or no price found for ${url} — trying ScraperAPI`);
  const scraperHtml = await fetchWithScraper(url, apiKey);
  if (scraperHtml) {
    const result = runCascade(scraperHtml, /* viaScraper= */ true, url);
    if (result.price != null) return result;
  }

  return { price: null, method: null };
}

// ── Fetch helpers ────────────────────────────────────────────────────────────

async function fetchDirect(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept':     'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'en-AU,en;q=0.9',
      },
      redirect: 'follow',
      cf: { cacheTtl: 0 },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function fetchWithScraper(url, apiKey) {
  const scraperUrl = `${SCRAPERAPI_BASE}?api_key=${apiKey}&url=${encodeURIComponent(url)}&render=true`;
  try {
    const res = await fetch(scraperUrl, { cf: { cacheTtl: 0 } });
    if (!res.ok) {
      console.error(`ScraperAPI returned ${res.status} for ${url}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.error(`ScraperAPI fetch failed: ${err.message}`);
    return null;
  }
}

// ── Extraction pipeline (run on whatever HTML we have) ───────────────────────

function runCascade(html, viaScraper = false, url = '') {
  const prefix   = viaScraper ? 'scraperapi-' : '';
  const isAmazon = /^https?:\/\/(?:www\.)?amazon\./i.test(url);

  // Amazon pages: the buy box carries the canonical displayed price — use it
  // before the generic methods, which are noisy on Amazon's cluttered pages
  if (isAmazon) {
    const price = tryAmazonBuyBox(html);
    if (price != null) return { price, method: `${prefix}amazon-buybox` };
  }

  let price = tryJsonLd(html);
  if (price != null) return { price, method: `${prefix}json-ld` };

  price = tryMicrodata(html);
  if (price != null) return { price, method: `${prefix}microdata` };

  price = tryMetaTags(html);
  if (price != null) return { price, method: `${prefix}meta-tags` };

  // Amazon + generic heuristic is a bad combination: if the buy box wasn't
  // found, the HTML is likely a bot-check/altered page (Amazon blocking the
  // fetch), and the heuristic will grab an unrelated price from whatever
  // content is on that page. On the direct-fetch pass, bail out here so the
  // caller escalates to ScraperAPI (JS-rendered, far less likely to be
  // blocked) instead of trusting a low-confidence guess. Only allow the
  // heuristic as a last resort once we're already on the rendered HTML.
  if (isAmazon && !viaScraper) return { price: null, method: null };

  price = tryHeuristic(html);
  if (price != null) return { price, method: `${prefix}heuristic` };

  return { price: null, method: null };
}

// ── Extraction methods ───────────────────────────────────────────────────────

function tryAmazonBuyBox(html) {
  // Anchor on the buy-box price container (desktop and mobile ids)
  const anchor = html.search(/id="(?:corePrice[^"]*|apex_desktop|apex_mobile)"/i);
  if (anchor === -1) return null;
  const section = html.slice(anchor, anchor + 20000);

  // Canonical machine-readable price: <span class="a-offscreen">$215.00</span>
  const off = section.match(/class="a-offscreen"[^>]*>\s*(?:A?\$|AUD\s*)([\d,]+(?:\.\d{1,2})?)/i);
  if (off) return parsePrice(off[1]);

  // Fallback: visible split price (a-price-whole + a-price-fraction)
  const whole    = section.match(/a-price-whole[^>]*>\s*([\d,]+)/i);
  const fraction = section.match(/a-price-fraction[^>]*>\s*(\d{1,2})/i);
  if (whole) return parsePrice(`${whole[1]}.${fraction ? fraction[1] : '00'}`);

  return null;
}

function tryJsonLd(html) {
  const scriptRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRe.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      const price = extractFromSchema(Array.isArray(data) ? data : [data]);
      if (price != null) return price;
    } catch {
      // malformed JSON — skip
    }
  }
  return null;
}

function extractFromSchema(nodes) {
  for (const node of nodes) {
    if (!node) continue;
    const type = node['@type'];
    if (type === 'Product' || type === 'IndividualProduct') {
      const offers = node.offers;
      if (offers) {
        const offerList = Array.isArray(offers) ? offers : [offers];
        for (const offer of offerList) {
          const p = parsePrice(offer.price ?? offer.lowPrice);
          if (p != null) return p;
        }
      }
    }
    if (node['@graph']) {
      const found = extractFromSchema(node['@graph']);
      if (found != null) return found;
    }
  }
  return null;
}

function tryMicrodata(html) {
  const re = /itemprop=["']price["'][^>]*(?:content=["']([^"']+)["']|>([^<]+)<)/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const raw = match[1] || match[2];
    const p   = parsePrice(raw);
    if (p != null) return p;
  }
  return null;
}

function tryMetaTags(html) {
  const patterns = [
    /property=["'](?:og:price:amount|product:price:amount)["'][^>]*content=["']([^"']+)["']/i,
    /content=["']([^"']+)["'][^>]*property=["'](?:og:price:amount|product:price:amount)["']/i,
    /name=["']twitter:data1["'][^>]*content=["']([^"']+)["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      const p = parsePrice(m[1]);
      if (p != null) return p;
    }
  }
  return null;
}

function tryHeuristic(html) {
  const text = html
    // Drop attribute-value text (e.g. aria-hidden="RRP: $36.95")
    .replace(/\s(?:aria-hidden|aria-label|alt|title)="[^"]*"/gi, '')
    // Drop whole elements that are visually hidden but present for screen readers
    // (e.g. Amazon's <span class="a-offscreen">RRP: $36.95</span>), so their
    // text doesn't get scanned as if it were a visible price on the page
    .replace(/<(span|div)\b[^>]*class="[^"]*(?:a-offscreen|sr-only|screen-reader|visually-hidden)[^"]*"[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

  // Match AUD-style prices: $X, A$X, AUDX
  const priceRe = /(?:A\$|\$|AUD\s*)(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)/gi;
  const contextRe = /price|now|was|sale|rrp|save|buy|add to cart/i;

  const candidates = [];
  let match;
  while ((match = priceRe.exec(text)) !== null) {
    const start   = Math.max(0, match.index - 120);
    const end     = Math.min(text.length, match.index + 120);
    const context = text.slice(start, end);
    if (contextRe.test(context)) {
      const p = parsePrice(match[1]);
      if (p != null && p > 0 && p < 1_000_000) candidates.push(p);
    }
  }

  if (!candidates.length) return null;
  return mode(candidates);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parsePrice(raw) {
  if (raw == null) return null;
  const cleaned = String(raw).replace(/[^0-9.]/g, '');
  const num     = parseFloat(cleaned);
  return isNaN(num) || num <= 0 ? null : num;
}

function mode(arr) {
  const freq = {};
  let best = arr[0], top = 0;
  for (const v of arr) {
    freq[v] = (freq[v] || 0) + 1;
    if (freq[v] > top) { top = freq[v]; best = v; }
  }
  return best;
}
