/**
 * Sends a target-hit alert via Resend, styled to match the app's GeoCities look.
 * Env secrets: RESEND_API_KEY, RESEND_TO_EMAIL
 *
 * Email clients strip SVG, web fonts and most CSS, so this is old-school on
 * purpose: nested tables, inline styles, solid colours, system fonts only.
 */

const APP_URL = 'https://joelcsweet.github.io/pricetracker/';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = v => '$' + Number(v).toFixed(2);

const IMPACT = "Impact,'Arial Black',Arial,sans-serif";
const COMIC  = "'Comic Sans MS','Comic Neue',Verdana,sans-serif";
const BEVEL  = 'border:3px solid;border-color:#ffffff #808080 #808080 #ffffff;';

function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; }
}

export function buildAlertHtml({ product, price, urlResults = [] }) {
  const urls = String(product.url).split('\n').map(u => u.trim()).filter(Boolean);

  // Store rows: use this check's results when we have them, otherwise just the URLs
  const rows = urls.map(u => ({ url: u, price: urlResults.find(r => r.url === u)?.price ?? null }));
  const priced = rows.filter(r => r.price != null);
  const best   = priced.length ? priced.reduce((a, b) => (b.price < a.price ? b : a)) : null;
  const buyUrl = best?.url || urls[0] || APP_URL;
  const under  = Number(product.target_price) - Number(price);

  const storeRows = rows.map(r => {
    const isBest = best && r.url === best.url && priced.length > 1;
    return `
      <tr>
        <td style="padding:6px 8px;background:${isBest ? '#ffff99' : '#ccffff'};border-bottom:2px solid #000000;font-family:${COMIC};font-size:15px">
          <a href="${esc(r.url)}" style="color:#0000ee;text-decoration:underline">${esc(hostOf(r.url))}</a>${isBest ? ' <span style="color:#ff0000">cheapest!</span>' : ''}
        </td>
        <td align="right" style="padding:6px 8px;background:${isBest ? '#ffff99' : '#ccffff'};border-bottom:2px solid #000000;font-family:${COMIC};font-size:16px;color:#000000">
          ${r.price != null ? money(r.price) : '&mdash;'}
        </td>
      </tr>`;
  }).join('');

  const rainbow = ['#ff0000', '#ff8800', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff']
    .map(c => `<td height="6" style="background:${c};font-size:0;line-height:0">&nbsp;</td>`).join('');

  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0a0a3c">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a3c">
 <tr><td align="center" style="padding:20px 10px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">

   <tr><td align="center" style="background:#ff0000;border:4px solid;border-color:#ff9999 #880000 #880000 #ff9999;padding:12px 8px">
     <div style="font-family:${IMPACT};font-size:30px;line-height:1.1;color:#ffff00">&#9733; Target hit! &#9733;</div>
     <div style="font-family:${COMIC};font-size:13px;color:#ffffff;margin-top:2px">Your Price Tracker has big news</div>
   </td></tr>
   <tr><td>
     <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${rainbow}</tr></table>
   </td></tr>

   <tr><td style="padding-top:12px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;${BEVEL}border-width:4px">
     <tr><td style="padding:14px 16px 6px">
       <div style="font-family:${COMIC};font-size:19px;color:#0000ee;text-decoration:underline">${esc(product.name)}</div>
       <div style="font-family:${IMPACT};font-size:64px;line-height:1.05;color:#ff0000;margin-top:6px">${money(price)}</div>
       <div style="font-family:${COMIC};font-size:15px;color:#008000">${
         under > 0.004
           ? `That is ${money(under)} under your ${money(product.target_price)} target!!`
           : `Right on your ${money(product.target_price)} target!!`
       }</div>
     </td></tr>
     <tr><td style="padding:10px 16px 6px">
       <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:2px solid #000000">${storeRows}</table>
     </td></tr>
     <tr><td align="center" style="padding:12px 16px 18px">
       <a href="${esc(buyUrl)}" style="display:inline-block;background:#c0c0c0;${BEVEL}padding:6px 18px;font-family:${COMIC};font-size:17px;color:#000000;text-decoration:none">View product &rarr;</a>
     </td></tr>
    </table>
   </td></tr>

   <tr><td align="center" style="padding:14px 8px 0;font-family:${COMIC};font-size:13px;color:#ffffff">
     <a href="${APP_URL}" style="color:#99ccff;text-decoration:underline">Open my Price Tracker</a>
     <div style="color:#c0c0c0;margin-top:6px">Sent by Price Tracker. You only get one of these per price drop.</div>
   </td></tr>

  </table>
 </td></tr>
</table>
</body>
</html>`;
}

export async function sendAlert({ product, price, urlResults = [] }, env) {
  const subject = `Target hit! ${product.name} is now ${money(price)}`;
  const html    = buildAlertHtml({ product, price, urlResults });

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      from:    'PriceTracker <onboarding@resend.dev>',
      to:      [env.RESEND_TO_EMAIL],
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend error ${res.status}: ${body}`);
  }
}
