// Writes captured customer/lead fields to Chyne Tire's customer-log Google Sheet (the
// WGM $15/mo add-on - see Code.gs in the customer-log Apps Script project, once deployed
// for this client). This is a DURABLE record: unlike conversationStore.js (which holds
// the live back-and-forth state needed to keep a text thread from restarting), this is
// the owner-facing lead log Chyne Tire actually looks at.
//
// Requires two env vars once the customer-log Sheet/Apps Script is deployed for Chyne Tire:
//   CUSTOMER_LOG_URL    - the Apps Script Web App URL (ends in /exec)
//   CUSTOMER_LOG_SECRET - matches the "WriteSecret" value in that Sheet's Config tab
//
// If either is unset, this silently no-ops - fine for demo/testing before the Sheet
// backend exists yet.
//
// URL hardcoded as a default below (Abel's deployed Code.gs) so this works without
// also having to set CUSTOMER_LOG_URL as an env var - CUSTOMER_LOG_SECRET still needs
// to be set (in Railway's/Netlify's Variables), since that's the value proving this
// server is allowed to write, and it isn't safe to hardcode a secret into source code.
const DEFAULT_CUSTOMER_LOG_URL =
  "https://script.google.com/macros/s/AKfycbyrUXcqblkQn6pfeaRF0EDdBSntAv-2nMw8Fwj_yAjigPXngh1sFuABZr1PydrKgqEMLA/exec";

async function logCustomerField({
  phone,
  name,
  reason,
  vehicle_year,
  vehicle_make,
  vehicle_model,
  tire_size,
  best_callback_time,
  vin,
  plate,
  plate_state,
  source,
}) {
  const url = process.env.CUSTOMER_LOG_URL || DEFAULT_CUSTOMER_LOG_URL;
  const secret = process.env.CUSTOMER_LOG_SECRET;
  if (!url || !secret) return;
  if (!phone) return; // the Sheet upserts by phone number - nothing to key on without it

  try {
    // Deliberately NOT awaited by callers - a slow or failed Sheet write should never
    // add latency to a live phone call or delay a text reply. Errors are swallowed here
    // (logged, not thrown) for the same reason.
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret,
        phone,
        name,
        reason,
        vehicle_year,
        vehicle_make,
        vehicle_model,
        tire_size,
        best_callback_time,
        vin,
        plate,
        plate_state,
        source,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.error) {
      console.error("Customer log write failed:", data.error);
    }
  } catch (err) {
    console.error("Customer log write failed:", err.message);
  }
}

// Looks up an existing customer record by phone number - not currently wired into a UI
// flow for Chyne Tire (kept for parity with the shared customer-log pattern and in case
// caller-recognition is added later, same as the real-estate build).
async function lookupCustomer(phone) {
  const url = process.env.CUSTOMER_LOG_URL || DEFAULT_CUSTOMER_LOG_URL;
  const secret = process.env.CUSTOMER_LOG_SECRET;
  if (!url || !secret || !phone) return null;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret, action: "lookup", phone }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.error) {
      console.error("Customer lookup failed:", data.error);
      return null;
    }
    return data.record || null;
  } catch (err) {
    console.error("Customer lookup failed:", err.message);
    return null;
  }
}

module.exports = { logCustomerField, lookupCustomer };
