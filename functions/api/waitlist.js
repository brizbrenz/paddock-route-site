/**
 * Paddock Route — Waitlist endpoint
 *
 * Cloudflare Pages Function. Deployed automatically when this file lives at
 * `functions/api/waitlist.js` in the repo Cloudflare Pages builds from.
 * It then becomes available at https://paddockroute.com/api/waitlist
 *
 * Required environment variables (set in Cloudflare Pages → Settings → Environment variables):
 *   BEEHIIV_API_KEY        — your Beehiiv API key (Settings → Integrations → API in Beehiiv)
 *   BEEHIIV_PUBLICATION_ID — looks like "pub_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
 *
 * Optional: create a custom field in Beehiiv called "Signup Type" so we can
 * segment subscribers vs drivers vs growers. If the custom field does not
 * exist, Beehiiv silently discards the value — that is fine, the signup
 * still goes through.
 */

const BEEHIIV_BASE = 'https://api.beehiiv.com/v2';

// Basic email shape check. Server-side belt-and-braces only — the browser
// already enforces type="email".
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function onRequestPost({ request, env }) {
  // Same-origin only — the form lives on paddockroute.com so we don't need CORS.
  // Reject obvious cross-origin POSTs.
  const origin = request.headers.get('Origin') || '';
  if (origin && !/paddockroute\.com$/.test(new URL(origin).hostname)) {
    return json({ error: 'Forbidden' }, 403);
  }

  if (!env.BEEHIIV_API_KEY || !env.BEEHIIV_PUBLICATION_ID) {
    // Don't expose internals to the user
    console.error('Missing BEEHIIV_API_KEY or BEEHIIV_PUBLICATION_ID env var');
    return json({ error: "We're not quite ready — please email hello@paddockroute.com.au." }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request' }, 400);
  }

  const email = String(body.email || '').trim().toLowerCase();
  const type  = String(body.type || 'subscriber').trim();

  if (!EMAIL_RX.test(email)) {
    return json({ error: 'Please enter a valid email address.' }, 400);
  }
  if (!['subscriber', 'driver', 'grower'].includes(type)) {
    return json({ error: 'Invalid signup type.' }, 400);
  }

  // Build custom_fields. Beehiiv requires the field to exist on the publication
  // — any unknown ones are silently dropped, so this is safe even if you
  // haven't created them yet.
  const customFields = [
    { name: 'Signup Type', value: type }
  ];
  if (body.firstName)  customFields.push({ name: 'First Name',      value: String(body.firstName).slice(0, 80) });
  if (body.lastName)   customFields.push({ name: 'Last Name',       value: String(body.lastName).slice(0, 80) });
  if (body.phone)      customFields.push({ name: 'Phone',           value: String(body.phone).slice(0, 40) });
  if (body.region)     customFields.push({ name: 'Delivery Region', value: String(body.region).slice(0, 120) });
  if (body.vehicle)    customFields.push({ name: 'Vehicle',         value: String(body.vehicle).slice(0, 120) });
  if (body.coolStorage !== undefined) {
    customFields.push({ name: 'Cool Storage', value: body.coolStorage ? 'Yes' : 'No' });
  }

  const payload = {
    email,
    reactivate_existing: false,
    send_welcome_email: true,
    utm_source: 'paddockroute.com',
    utm_medium: 'website-form',
    utm_campaign: type === 'driver' ? 'driver-signup' : 'waitlist',
    referring_site: 'https://paddockroute.com',
    custom_fields: customFields
  };

  let beehiivRes;
  try {
    beehiivRes = await fetch(
      `${BEEHIIV_BASE}/publications/${env.BEEHIIV_PUBLICATION_ID}/subscriptions`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.BEEHIIV_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      }
    );
  } catch (err) {
    console.error('Beehiiv fetch failed:', err);
    return json({ error: "Couldn't reach our signup service. Please try again in a moment." }, 502);
  }

  if (beehiivRes.ok) {
    return json({ ok: true });
  }

  // Beehiiv returns 400 for things like already-subscribed.
  // Treat "already subscribed" as a soft success so users don't get a scary error.
  let detail = '';
  try { detail = (await beehiivRes.text()) || ''; } catch {}
  if (beehiivRes.status === 400 && /already|exists|subscribed/i.test(detail)) {
    return json({ ok: true, alreadySubscribed: true });
  }

  console.error('Beehiiv error', beehiivRes.status, detail);
  return json(
    { error: "We couldn't add you just now. Please try again or email hello@paddockroute.com.au." },
    502
  );
}

// Reject anything that isn't POST so the endpoint can't be probed for info.
export async function onRequest({ request }) {
  if (request.method === 'POST') {
    // onRequestPost handles it
    return;
  }
  return new Response('Method Not Allowed', {
    status: 405,
    headers: { 'Allow': 'POST' }
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
