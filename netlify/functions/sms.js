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
  const bodyText = params.get("Body");

  if (!from || !bodyText) {
    return { statusCode: 400, body: "Missing From/Body" };
  }

  // Load whatever's already known about this number - could be a brand new
  // conversation (null), a text thread already in progress, OR a thread seeded by the
  // voice server after a phone call (see index.js's take_message handler).
  const existing = await loadConversation(from);
  const state = existing || { history: [], captured: {}, awaitingVehicleId: false };

  state.history.push({ role: "user", content: bodyText });

  let replyText = "Sorry, something went wrong on our end. Please try again in a bit.";

  try {
    // Loop lets the AI's turn continue after a tool call resolves - a real reply only
    // ever needs one or two rounds, capped at 3 as a safety backstop.
    for (let round = 0; round < 3; round++) {
      const message = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        tools: [TAKE_MESSAGE_TOOL, RECORD_VEHICLE_ID_TOOL, REQUEST_LIVE_AGENT_TOOL],
        messages: state.history,
      });

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
