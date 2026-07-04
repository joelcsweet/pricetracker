/**
 * Sends a target-hit alert via Resend.
 * Env secrets: RESEND_API_KEY, RESEND_TO_EMAIL
 */

export async function sendAlert({ product, price }, env) {
  const subject = `Price alert: ${product.name} is now $${price.toFixed(2)}`;

  const html = `
    <div style="font-family:sans-serif;max-width:520px;margin:auto;color:#222">
      <h2 style="color:#16a34a">&#128722; Price target hit!</h2>
      <p><strong>${product.name}</strong> has dropped to
         <strong style="color:#16a34a">$${price.toFixed(2)} ${product.currency}</strong>.</p>
      <p>Your target was <strong>$${product.target_price.toFixed(2)} ${product.currency}</strong>.</p>
      <p style="margin-top:24px">
        <a href="${product.url}"
           style="background:#16a34a;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">
          View product &rarr;
        </a>
      </p>
      <hr style="margin:32px 0;border:none;border-top:1px solid #eee"/>
      <p style="font-size:12px;color:#888">
        Sent by PriceTracker &mdash;
        <a href="${product.url}" style="color:#888">${product.url}</a>
      </p>
    </div>
  `;

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
