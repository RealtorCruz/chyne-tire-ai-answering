// Persistent, per-phone-number conversation state for TEXT threads.
//
// WHY THIS EXISTS: the real-estate reference build (sms.js) kept conversation history in
// a plain in-memory JS Map inside the Netlify Function - which that file's own comment
// admits resets on cold start. That's fine for quick personal testing, but wrong for
// Chyne Tire's actual requirement: a customer might not text back their VIN/plate for
// hours, and by then the function has almost certainly cold-started and forgotten
// everything - the conversation would silently "start over" and re-introduce itself,
// which is exactly what was ruled out.
//
// FIX: store state in Netlify Blobs (Netlify's built-in key/value store), keyed by phone
// number. This survives cold starts and redeploys, needs no separate database, and - via
// "API access" mode (explicit siteID/token instead of relying on Netlify's
// auto-injected function context) - can ALSO be read/written from the voice server on
// Railway, not just from the Netlify Function. That's what lets a voice call's
// take_message flow seed the exact same store that a LATER, separate text reply reads
// from days afterward.
//
// Required env vars (same names needed on both Railway and Netlify):
//   NETLIFY_BLOBS_SITE_ID  - the Netlify site ID (Site settings > General > Site details)
//   NETLIFY_BLOBS_TOKEN    - a Netlify Personal Access Token (User settings > Applications)

const { getStore } = require("@netlify/blobs");

// A conversation older than this is treated as gone, not loaded - the customer gets a
// fresh start instead of the AI silently mixing an old job into a new one. Chyne Tire's
// customers often come back every 4-6 months for a rotation, so without this, texting
// the same number months later could resurface a long-finished conversation (wrong
// vehicle, wrong tire size, an old "did I get that right?" context) instead of starting
// clean. 15 days is comfortably longer than any real reply to a follow-up text should
// take, while being nowhere near that repeat-customer window.
const CONVERSATION_TTL_DAYS = 15;
const CONVERSATION_TTL_MS = CONVERSATION_TTL_DAYS * 24 * 60 * 60 * 1000;

function getConversationStore() {
  return getStore({
    name: "chyne-tire-conversations",
    siteID: process.env.NETLIFY_BLOBS_SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN,
  });
}

// State shape per phone number:
// {
//   history: [...raw Anthropic Messages API turns, same shape as in-call history...],
//   captured: { name, reason, vehicle_year, vehicle_make, vehicle_model, tire_size, best_callback_time },
//   awaitingTireSizePhoto: true/false,  // set once take_message fires, cleared once a photo comes in
//   awaitingAddress: true/false,        // set once take_message fires, cleared once an address comes in
//   lastUpdated: <ISO timestamp>,
// }

async function loadConversation(phone) {
  if (!phone) return null;
  try {
    const store = getConversationStore();
    const state = await store.get(phone, { type: "json" });
    if (!state) return null;

    if (state.lastUpdated) {
      const ageMs = Date.now() - new Date(state.lastUpdated).getTime();
      if (ageMs > CONVERSATION_TTL_MS) {
        console.log(
          `conversationStore: conversation for ${phone} is ${Math.floor(ageMs / 86400000)} days old ` +
            `(> ${CONVERSATION_TTL_DAYS}-day limit) - treating as expired, starting fresh`
        );
        return null;
      }
    }

    return state;
  } catch (err) {
    console.error(`conversationStore: failed to load state for ${phone}:`, err.message);
    return null;
  }
}

async function saveConversation(phone, state) {
  if (!phone) return;
  try {
    const store = getConversationStore();
    await store.setJSON(phone, { ...state, lastUpdated: new Date().toISOString() });
  } catch (err) {
    console.error(`conversationStore: failed to save state for ${phone}:`, err.message);
  }
}

module.exports = { loadConversation, saveConversation };
