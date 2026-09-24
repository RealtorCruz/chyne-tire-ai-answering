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
  RECORD_VEHICLE_ID_TOOL,
  REQUEST_LIVE_AGENT_TOOL,
} = require("../../server/persona");
const { logCustomerField } = require("../../server/customerLog");
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

async function notifyOwner(summary) {
  try {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await client.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to: process.env.OWNER_CELL_NUMBER,
      body: summary,
    });
  } catch (err) {
    console.error("Owner SMS alert failed:", err.message);
  }
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
  const state = existing || { history: [], captured: {}, awaitingVehicleId: false };

  if (mediaUrls.length > 0) {
    const c = state.captured || {};
    await notifyOwner(`Photo received via AI text for ${c.name || "a customer"} (likely VIN or registration):
${mediaUrls.join("\n")}
Vehicle on file: ${c.vehicle_year || ""} ${c.vehicle_make || ""} ${c.vehicle_model || ""}${bodyText ? `\nTheir message: ${bodyText}` : ""}
From: ${from}`);
    state.awaitingVehicleId = false;

    const note =
      `[System note: the customer just sent ${mediaUrls.length === 1 ? "a photo" : mediaUrls.length + " photos"}, ` +
      `most likely of their VIN or registration. It has ALREADY been forwarded to Chyne Tire - treat the ` +
      `vehicle ID as received. Do NOT call record_vehicle_id for it and do NOT ask them to type it. ` +
      `Thank them by name and let them know Chyne Tire has what's needed to get the right tires ready. ` +
      `If they also wrote a message, respond to that naturally too.]`;
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
        tools: [TAKE_MESSAGE_TOOL, RECORD_VEHICLE_ID_TOOL, REQUEST_LIVE_AGENT_TOOL],
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
        const {
          name,
          reason,
          vehicle_year,
          vehicle_make,
          vehicle_model,
          tire_size,
          best_callback_time,
        } = takeMessageToolUse.input;

        await notifyOwner(`New text intake via AI answering:
Name: ${name}
Vehicle: ${vehicle_year} ${vehicle_make} ${vehicle_model}
Tire size: ${tire_size}
Reason: ${reason}
Best time to call back: ${best_callback_time}
Came in from: ${from}`);

        logCustomerField({
          phone: from,
          name,
          reason,
          vehicle_year,
          vehicle_make,
          vehicle_model,
          tire_size,
          best_callback_time,
          source: "AI Text",
        });

        state.captured = { name, reason, vehicle_year, vehicle_make, vehicle_model, tire_size, best_callback_time };
        state.awaitingVehicleId = true;

        state.history.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: takeMessageToolUse.id,
              content: "Message recorded. Now, in your next reply, thank them by name and directly ask for their VIN or license plate + state, per the VEHICLE-ID FOLLOW-UP instructions.",
            },
          ],
        });
        continue;
      }

      const vehicleIdToolUse = message.content.find((b) => b.type === "tool_use" && b.name === "record_vehicle_id");
      if (vehicleIdToolUse) {
        const { vin, plate, plate_state } = vehicleIdToolUse.input;

        await notifyOwner(`Vehicle ID received via AI text for ${state.captured.name || "a customer"}:
${vin ? `VIN: ${vin}` : `Plate: ${plate}${plate_state ? ` (${plate_state})` : ""}`}
Vehicle on file: ${state.captured.vehicle_year || ""} ${state.captured.vehicle_make || ""} ${state.captured.vehicle_model || ""}
From: ${from}`);

        logCustomerField({
          phone: from,
          ...state.captured,
          vin,
          plate,
          plate_state,
          source: "AI Text",
        });

        state.awaitingVehicleId = false;

        state.history.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: vehicleIdToolUse.id,
              content: "Vehicle ID recorded. Thank them by name and let them know Chyne Tire has what's needed to get the right tires ready.",
            },
          ],
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
