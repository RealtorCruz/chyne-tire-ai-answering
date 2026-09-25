// Re-hosts customer-sent photos (door-jamb tire stickers) so Chyne Tire's owner can open
// them with a plain link - no Twilio login required.
//
// WHY THIS EXISTS: Twilio's own media URLs (the ones in an inbound MMS's MediaUrl0, etc.)
// require HTTP Basic Auth with the Twilio Account SID/Auth Token to view. That's fine for
// our own server, which already has those credentials - but Mark, the owner, has no way
// to "log in" to Twilio just to see a photo, and handing him Twilio credentials to do so
// would be a real security problem, not a convenience. So instead: our server downloads
// the photo once (using credentials it already has), re-hosts the raw bytes in Netlify
// Blobs under a random, hard-to-guess ID, and gives Mark a plain link to OUR OWN site
// instead. No login, ever, on his end.
//
// STORAGE MODEL: kept deliberately simple per the agreed design - no image compression,
// no access control beyond an unguessable ID. This is a photo of a tire sticker, not
// sensitive data, so a random ID is proportionate protection, not real security.
//
// EXPIRY: 30 days, checked lazily whenever a photo is actually requested (no separate
// cleanup job needed). This is longer than the 15-day conversation-memory window in
// conversationStore.js on purpose - even after the AI has "forgotten" the conversation,
// Mark may still need the photo for a job he hasn't gotten to yet.
//
// Required env vars (same names already used elsewhere in this project):
//   NETLIFY_BLOBS_SITE_ID, NETLIFY_BLOBS_TOKEN  (see conversationStore.js)
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN       (to authenticate the one-time Twilio fetch)
//   PUBLIC_SITE_URL - this Netlify site's own public URL, e.g.
//     https://chyne-tire-ai-answering.netlify.app (no trailing slash). Used to build the
//     link Mark actually receives.

const crypto = require("crypto");
const { getStore } = require("@netlify/blobs");

const PHOTO_TTL_DAYS = 30;
const PHOTO_TTL_MS = PHOTO_TTL_DAYS * 24 * 60 * 60 * 1000;

function getPhotoStore() {
  return getStore({
    name: "chyne-tire-photos",
    siteID: process.env.NETLIFY_BLOBS_SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN,
  });
}

// Downloads one Twilio media item (authenticated) and saves it under a fresh random ID.
// Returns the public URL to give the owner, or null if the fetch/save failed - callers
// should fall back gracefully (e.g. skip that photo) rather than crash the whole text.
async function fetchAndStorePhoto(twilioMediaUrl) {
  try {
    const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString(
      "base64"
    );
    const res = await fetch(twilioMediaUrl, { headers: { Authorization: `Basic ${auth}` } });
    if (!res.ok) {
      console.error(`photoStore: Twilio fetch failed (${res.status}) for ${twilioMediaUrl}`);
      return null;
    }
    const contentType = res.headers.get("content-type") || "image/jpeg";
    const buffer = Buffer.from(await res.arrayBuffer());

    const id = crypto.randomBytes(16).toString("hex"); // 32 hex chars - unguessable
    const store = getPhotoStore();
    await store.set(id, buffer, { metadata: { contentType, storedAt: new Date().toISOString() } });

    const siteUrl = (process.env.PUBLIC_SITE_URL || "").replace(/\/$/, "");
    return `${siteUrl}/.netlify/functions/photo?id=${id}`;
  } catch (err) {
    console.error("photoStore: failed to fetch/store photo:", err.message);
    return null;
  }
}

// Reads a stored photo back out, for the photo-serving function. Returns null if it
// doesn't exist OR if it's past the 30-day limit - in the expired case, this also
// deletes it, so an expired link cleans itself up the next time (if ever) it's visited.
async function getPhoto(id) {
  if (!id) return null;
  try {
    const store = getPhotoStore();
    const entry = await store.getWithMetadata(id, { type: "arrayBuffer" });
    if (!entry) return null;

    const storedAt = entry.metadata && entry.metadata.storedAt;
    if (storedAt) {
      const ageMs = Date.now() - new Date(storedAt).getTime();
      if (ageMs > PHOTO_TTL_MS) {
        console.log(`photoStore: photo ${id} is ${Math.floor(ageMs / 86400000)} days old - expired, deleting`);
        await store.delete(id);
        return null;
      }
    }

    return {
      buffer: Buffer.from(entry.data),
      contentType: (entry.metadata && entry.metadata.contentType) || "image/jpeg",
    };
  } catch (err) {
    console.error(`photoStore: failed to read photo ${id}:`, err.message);
    return null;
  }
}

module.exports = { fetchAndStorePhoto, getPhoto };
