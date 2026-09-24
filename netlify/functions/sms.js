// Netlify Function: handles inbound SMS to the Chyne Tire AI answering number.
// Point the Twilio phone number's "A message comes in" webhook at:
//   https://<your-netlify-site>.netlify.app/.netlify/functions/sms
//
// Required environment variables (Netlify Site Settings > Environment Variables):
//   ANTHROPIC_API_KEY
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
//   OWNER_CELL_NUMBER
//   NETLIFY_BLOBS_SITE_ID, NETLIFY_BLOBS_TOKEN  (see conversationStore.js)
//
// UNLIKE the real-estate reference build, conversation state here is NOT kept in an
// in-memory Map (that resets on every cold start, which would make the thread silently
// "start over" if a customer takes hours to text back their VIN/plate - exactly what
// isn't allowed). State is loaded from and saved back to conversationStore.js
// (Netlify Blobs) on every single request instead.

const Anthropic = require("@anthropic-ai/sdk");
const twilio = require("twilio");
const {
  SYSTEM_PROMPT,
  TAKE_MESSAGE_TOOL,
  RECORD_FOLLOWUP_INFO_TOOL,
  REQUEST_LIVE_AGENT_TOOL,
} = require("../../server/persona");
const { logCustomerField } = require("../../server/customerLog");
const { notifyMessageTaken, notifyLeadUpdated } = require("../../server/notifications");
const { loadConversation, saveConversation } = require("../../server/conversationStore");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---- Prompt caching (cuts Sonnet input cost) ----
// Persona + tools are identical on every request, so they're sent as a cached block
// (re-read at ~10% of normal input price after the first write). A second breakpoint on
// the newest turn lets the earlier part of the thread be re-read from cache too.
const CACHED_SYSTEM = [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }];

// Returns a copy of the history with a cache breakpoint on the last content block.
// Never mutates the saved history, so breakpoints never get stored in Netlify Blobs.
function withCacheBreakpoint(history) {
  if (history.length === 0) return history;
  const copy = history.slice(0, -1);
  const last = history[history.length - 1];
  const blocks =
    typeof last.content === "string"
      ? [{ type: "text", text: last.content }]
      : last.content.map((b) => ({ ...b }));
  if (blocks.length > 0) {
    blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: "ephemeral" } };
  }
  copy.push({ role: last.role, content: blocks });
  return copy;
}

// What's still outstanding from the follow-up text, and what the AI should say about it.
// Each missing piece gets asked for ONCE - after that the owner gets it on the callback.
function followupStatus(state) {
  const missing = [];
  if (state.awaitingTireSizePhoto) missing.push("a photo of the door-jamb tire size sticker");
  if (state.awaitingAddress) missing.push("the full address where the vehicle will be for service");
  if (missing.length === 0) {
    return "Everything's in. Thank them by name and let them know Chyne Tire has what it needs and will reach out to get them scheduled.";
  }
  if (!state.followupNudged) {
    state.followupNudged = true;
    return `Recorded. Still missing: ${missing.join(" and ")}. Thank them by name and ask for it once, briefly.`;
  }
  return `Recorded. Still missing: ${missing.join(" and ")}, but you've already asked once - do NOT ask again. Thank them by name and let them know Chyne Tire will confirm anything else when they call.`;
}

exports.handler = async (event) => {
  const params = new URLSearchParams(event.body);
  const from = params.get("From");
  const bodyText = (params.get("Body") || "").trim();

  // Photo texts (MMS): customers will often send a picture of their registration card or
  // VIN sticker instead of typing it. The AI doesn't read the photo - Chyne Tire does -
  // so we just forward the photo link(s) to the owner and have the AI thank them.
  const numMedia = parseInt(params.get("NumMedia") || "0", 10);
  const mediaUrls = [];
  for (let i = 0; i < numMedia; i++) {
    const url = params.get(`MediaUrl${i}`);
    if (url) mediaUrls.push(url);
  }

  if (!from || (!bodyText && mediaUrls.length === 0)) {
    return { statusCode: 400, body: "Missing From/Body" };
  }

  // Load whatever's already known about this number - could be a brand new
  // conversation (null), a text thread already in progress, OR a thread seeded by the
  // voice server after a phone call (see index.js's take_message handler).
  const existing = await loadConversation(from);
  const state = existing || { history: [], captured: {}, awaitingTireSizePhoto: false, awaitingAddress: false };

  if (mediaUrls.length > 0) {
    state.captured = state.captured || {};
    state.captured.photo_urls = [...(state.captured.photo_urls || []), ...mediaUrls];
    if (bodyText) {
      state.captured.notes = [state.captured.notes, `Texted with photo: ${bodyText}`].filter(Boolean).join("; ");
    }
    state.awaitingTireSizePhoto = false; // the door-jamb photo is in - the owner reads the size himself
    await notifyLeadUpdated({ lead: state.captured, callerNumber: from });

    const note =
      `[System note: the customer just sent ${mediaUrls.length === 1 ? "a photo" : mediaUrls.length + " photos"}, ` +
      `most likely of the door-jamb tire size sticker you asked for. It has ALREADY been forwarded to Chyne ` +
      `Tire - treat the tire size as received and do NOT ask them to type it out. If their message includes ` +
      `the service address, call record_followup_info with service_address (and photo: true). Otherwise call ` +
      `record_followup_info with just photo: true. ${followupStatus(state)}]`;
    state.history.push({ role: "user", content: bodyText ? `${note}\n\n${bodyText}` : note });
  } else {
    state.history.push({ role: "user", content: bodyText });
  }

  let replyText = "Sorry, something went wrong on our end. Please try again in a bit.";

  try {
    // Loop lets the AI's turn continue after a tool call resolves - a real reply only
    // ever needs one or two rounds, capped at 3 as a safety backstop.
    for (let round = 0; round < 3; round++) {
      const message = await anthropic.messages.create({
        model: "claude-sonnet-5",
        max_tokens: 300,
        system: CACHED_SYSTEM,
        tools: [TAKE_MESSAGE_TOOL, RECORD_FOLLOWUP_INFO_TOOL, REQUEST_LIVE_AGENT_TOOL],
        messages: withCacheBreakpoint(state.history),
      });

      // Token/cache usage - check Netlify Function logs to confirm caching is working.
      const u = message.usage || {};
      console.log(
        `SMS ${from} tokens: input=${u.input_tokens} cache_write=${u.cache_creation_input_tokens || 0} ` +
          `cache_read=${u.cache_read_input_tokens || 0} output=${u.output_tokens}`
      );

      const cleanContent = message.content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
      state.history.push({ role: "assistant", content: cleanContent });

      const textBlock = message.content.find((b) => b.type === "text");
      if (textBlock) replyText = textBlock.text;

      const liveAgentToolUse = message.content.find((b) => b.type === "tool_use" && b.name === "log_live_agent_request");
      if (liveAgentToolUse) {
        state.liveAgentRequestCount = (state.liveAgentRequestCount || 0) + 1;
        const reachedThreshold = state.liveAgentRequestCount >= 3;
        state.history.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: liveAgentToolUse.id,
              content: reachedThreshold
                ? `This is request #${state.liveAgentRequestCount} - the threshold has been reached. Begin the escalation script now: acknowledge their request, briefly explain you need a few details to set up a callback, then ask for their name and best time to call back together in one message. Follow the normal read-back-and-confirm flow before recording anything with take_message.`
                : `This is request #${state.liveAgentRequestCount} of 3 needed before escalating. Keep trying to help them directly and naturally - don't mention any request count or threshold. Only begin the escalation script once told the threshold is reached.`,
            },
          ],
        });
        continue;
      }

      const takeMessageToolUse = message.content.find((b) => b.type === "tool_use" && b.name === "take_message");
      if (takeMessageToolUse) {
        const lead = { ...(state.captured || {}), ...takeMessageToolUse.input, channel: "text" };
        await notifyMessageTaken({ lead, callerNumber: from });
        logCustomerField({ phone: from, ...lead, source: "AI Text" });

        state.captured = lead;
        // Always requested unless a photo already came in on this thread - not conditional
        // on whether a tire size was given, since a stated size can still be wrong.
        state.awaitingTireSizePhoto = !(lead.photo_urls && lead.photo_urls.length);
        state.awaitingAddress = !lead.service_address;
        state.followupNudged = true; // this next message IS the one ask

        const ask = [];
        if (state.awaitingTireSizePhoto) ask.push("a photo of the door-jamb tire size sticker");
        if (state.awaitingAddress) ask.push("the address where the vehicle will be when Chyne Tire comes out");

        state.history.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: takeMessageToolUse.id,
              content: ask.length
                ? `Lead recorded. In your next reply, thank them by name and directly ask for ${ask.join(" plus ")}, per the FOLLOW-UP TEXT instructions.`
                : "Lead recorded. Thank them by name and let them know Chyne Tire will reach out to get them scheduled.",
            },
          ],
        });
        continue;
      }

      const followupToolUse = message.content.find((b) => b.type === "tool_use" && b.name === "record_followup_info");
      if (followupToolUse) {
        const { service_address } = followupToolUse.input;
        state.captured = state.captured || {};
        // photo: true is informational only - the photo-receipt branch above already
        // recorded photo_urls, flipped awaitingTireSizePhoto, and sent the owner an
        // UPDATED card for it. Sending another alert here for the same photo would
        // double-charge for one event, so only alert again if there's something NEW
        // (the address) to report.
        const addressIsNew = service_address && service_address !== state.captured.service_address;
        if (service_address) state.captured.service_address = service_address;

        const c = state.captured;
        state.awaitingTireSizePhoto = !(c.photo_urls && c.photo_urls.length);
        state.awaitingAddress = !c.service_address;

        if (addressIsNew) await notifyLeadUpdated({ lead: c, callerNumber: from });
        logCustomerField({ phone: from, ...c, source: "AI Text" });

        state.history.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: followupToolUse.id, content: followupStatus(state) }],
        });
        continue;
      }

      break; // no tool call this round - replyText already holds the AI's actual reply
    }
  } catch (err) {
    console.error("Error generating SMS reply:", err);
  }

  await saveConversation(from, state);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response><Message>${escapeXml(replyText)}</Message></Response>`;

  return {
    statusCode: 200,
    headers: { "Content-Type": "text/xml" },
    body: twiml,
  };
};

function escapeXml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
