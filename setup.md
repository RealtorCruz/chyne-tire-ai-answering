# Chyne Tire AI Call/Text Answering — Setup

Persona: Chyne Tire, mobile tire service, appointment-only, Volusia/Seminole County FL
(service area carried over from earlier notes — confirm/correct this in `server/persona.js`
before going live if it's wrong).

This is two separate pieces, same as the real-estate build:
1. **Voice** — a small always-on Node server (deployed to Railway) handling calls via
   Twilio ConversationRelay. Lives in `/server`.
2. **Text** — a Netlify Function handling inbound SMS. Lives in `/netlify/functions`.

They share the same "brain" (`server/persona.js`) and, unlike the real-estate build,
also share the same **persistent conversation store** (`server/conversationStore.js`,
backed by Netlify Blobs) — this is what lets a text thread survive a customer taking
hours or days to reply with their VIN/plate, instead of the AI losing context and
re-introducing itself.

---

## Part 1 — Accounts you need open before starting

- [ ] Anthropic API key — console.anthropic.com
- [ ] Railway account — railway.app (sign in with GitHub)
- [ ] Twilio Account SID + Auth Token — Twilio Console dashboard
- [ ] A Netlify Personal Access Token — Netlify: User settings → Applications →
      "New access token" (needed so the Railway-hosted voice server can write to the
      same Netlify Blobs store the Netlify-hosted text function reads from)

None of these get pasted into chat — they go into Railway's/Netlify's environment
variable settings below.

---

## Part 2 — Deploy the voice server to Railway

1. Railway: New Project → Deploy from GitHub repo → select this repo → set the root
   directory to `/server`.
2. In Railway's **Variables** tab, add every variable from `server/.env.example` with
   real values — except `PUBLIC_HOSTNAME`, which you don't know yet.
3. For `NETLIFY_BLOBS_SITE_ID`: Netlify site → Site settings → General → Site details.
4. For `NETLIFY_BLOBS_TOKEN`: the personal access token from Part 1.
5. Deploy. Railway gives you a public URL like `chyne-tire-ai-answering-production.up.railway.app`.
6. Set `PUBLIC_HOSTNAME` to that URL (no `https://`, no trailing slash). Redeploy.
7. Point the Twilio number's "A call comes in" webhook at `https://<that-url>/voice`.

---

## Part 3 — Deploy the text function to Netlify

1. Connect this repo to Netlify (or add it alongside your other WGM sites).
2. In Netlify's environment variables, set: `ANTHROPIC_API_KEY`, `TWILIO_ACCOUNT_SID`,
   `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `OWNER_CELL_NUMBER`,
   `NETLIFY_BLOBS_SITE_ID`, `NETLIFY_BLOBS_TOKEN` — same values as the Railway side for
   the shared ones (the Blobs credentials specifically **must** match, or the two sides
   will be writing to different stores and the persistence won't actually connect them).
3. Deploy. Point the Twilio number's "A message comes in" webhook at
   `https://<your-netlify-site>.netlify.app/.netlify/functions/sms`.

---

## Part 4 — Required manual step: Spanish voice

Bilingual English/Spanish is built in (standing requirement across all WGM voice
builds), matching the real-estate line's setup. `server/index.js` currently has a
placeholder `SPANISH_VOICE_ID` near the top of the `/voice` route — replace it with a
real ElevenLabs voice ID or Spanish calls will fail to connect. See
https://www.twilio.com/docs/voice/conversationrelay/voice-configuration to preview and
pick a voice, then paste its ID in. English intentionally has no voice override (uses
ConversationRelay/ElevenLabs' default, which the real-estate line already confirmed
sounds fine).

---

## How the VIN/plate follow-up actually works end to end

1. Customer calls or texts. The AI captures name, what they need, vehicle year/make/
   model, tire size (or "don't know," which is fine), and best callback time.
2. Once confirmed, `take_message` fires — this alerts you by text and logs the intake
   (to the customer-log Sheet, once that's connected — see below).
3. **If it was a call:** the AI explains on the call that a follow-up text is coming,
   says goodbye, and the server immediately sends that text: *"Hi [Name], this is Chyne
   Tire! To make sure we bring the exact right tires for your [vehicle], could you text
   us back your VIN number or your license plate and state, whenever's easiest?"* That
   thread's state is saved right away — the AI now "knows" this customer even before
   they've replied.
   **If it was a text:** no separate outbound message is needed — the AI just asks for
   the VIN/plate directly, in the same thread, as its next message.
4. Whenever the customer replies — could be minutes or days later — the text function
   loads the saved state first. The AI already has their name and vehicle on file, so it
   picks the conversation back up naturally instead of asking again or reintroducing
   itself.
5. Once they send a VIN or plate, `record_vehicle_id` fires, logging it and closing out
   that follow-up.

**Not built yet, flagged on purpose:** actually decoding the VIN or plate into
year/make/model/tire specs (e.g. via the free NHTSA VIN API, or a paid plate-lookup
service for plates) isn't wired in — right now the VIN/plate is just captured and
logged for a human to use. Adding automatic decoding is a separate, straightforward next
step once you want it.

---

## Customer-log Sheet integration

`server/Code.gs` is the Apps Script backend `customerLog.js` writes to. To connect it:

1. Create a new Google Sheet, then Extensions → Apps Script, and paste in `Code.gs`.
2. Run `setupSheets_` once from the editor's function dropdown (this creates the
   `Customers` and `Config` tabs with seeded rows) — ignore any `getUi()`-related error,
   that's expected when running directly from the editor rather than from the Sheet.
3. In the `Config` tab, fill in `WriteSecret` (any random string you make up — this is
   what proves the AI server is allowed to write, separate from the client-facing PIN)
   and `AdminEmail` (your own Google account, so only you can ever regenerate the PIN).
4. Deploy → New deployment → Web app → Execute as "Me," Who has access "Anyone" → copy
   the `/exec` URL.
5. Set `CUSTOMER_LOG_URL` (that URL) and `CUSTOMER_LOG_SECRET` (the same `WriteSecret`
   value) in both Railway's and Netlify's environment variables.
6. From the Sheet's own menu (not the editor), run **WGM Admin → Regenerate Access PIN**
   once to generate the first real PIN — it's shown to you exactly once, never stored in
   plaintext.

Until these are set, every `logCustomerField` write silently no-ops — the demo still
works fully on the owner text alerts alone.

**Not built yet:** the actual PIN-gated viewer webpage (the thing a human opens to browse
this log) — `Code.gs` already exposes `verifyPin`/`updateRecord`/`deleteRecord` for one,
matching the real-estate build's pattern, but the page itself isn't made for Chyne yet.
Say the word if you want that built next.

---

## What's carried over from the real-estate build vs. what's new

- **Carried over as-is:** the ConversationRelay voice architecture, the bilingual
  language-matching approach, the live-agent escalation (3 verbal asks or pressing 0-0-0
  on the keypad), the silence-timeout safety net, and the overall shape of
  `persona.js`/`index.js`/`notifications.js`/`customerLog.js`.
- **New for Chyne:** appointment-only framing (no hours to quote), the specific intake
  fields (vehicle year/make/model, tire size instead of a generic "reason"), the
  vehicle-ID follow-up flow and its `record_vehicle_id` tool, and — the one real
  architecture change — swapping the real-estate build's in-memory (cold-start-losing)
  text history for a genuinely persistent store (`conversationStore.js`, Netlify Blobs)
  shared between both the voice and text sides.
- If the live-agent escalation piece isn't actually wanted for Chyne (it wasn't
  explicitly asked for), it's easy to strip out — say the word.
