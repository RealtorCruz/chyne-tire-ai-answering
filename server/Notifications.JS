// Sends Chyne Tire's owner a text whenever the AI takes a message, and separately sends
// the CUSTOMER a proactive follow-up text asking for their VIN/plate after a VOICE call
// (text conversations ask for this inline, in the same thread - see persona.js).
//
// Requires these environment variables (set in Railway's Variables tab):
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER (the AI's number)
//   OWNER_CELL_NUMBER   (where the owner's text alert goes)

const twilio = require("twilio");

async function notifyMessageTaken({
  name,
  reason,
  vehicle_year,
  vehicle_make,
  vehicle_model,
  tire_size,
  best_callback_time,
  channel,
  callerNumber,
}) {
  const summary = `New ${channel} intake via AI answering:
Name: ${name}
Vehicle: ${vehicle_year} ${vehicle_make} ${vehicle_model}
Tire size: ${tire_size}
Reason: ${reason}
Best time to call back: ${best_callback_time}
Came in from: ${callerNumber}`;

  try {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await client.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to: process.env.OWNER_CELL_NUMBER,
      body: summary,
    });
    return "sent";
  } catch (err) {
    console.error("Failed to send owner SMS alert:", err.message);
    return `failed: ${err.message}`;
  }
}

// Fallback alert for a caller who asked for a live person then hung up before a full
// message was ever confirmed via take_message - same gap-coverage pattern as the
// real-estate build.
async function notifyIncompleteMessage({ callerNumber, requestCount, draft, transcript }) {
  const draftLines = Object.entries(draft || {})
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");
  const summary = `Possible missed intake via AI answering:
${callerNumber} ${requestCount > 0 ? `asked to speak with you directly (${requestCount}x) ` : ""}then the call ended before a full message was confirmed.
Whatever was captured so far:
${draftLines || "  (nothing captured yet)"}
Recent transcript:
${transcript || "(none)"}`;

  try {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await client.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to: process.env.OWNER_CELL_NUMBER,
      body: summary,
    });
    return "sent";
  } catch (err) {
    console.error("Failed to send incomplete-message alert:", err.message);
    return `failed: ${err.message}`;
  }
}

// Sent to the CUSTOMER right after a VOICE call's take_message fires - kicks off the
// text thread that conversationStore.js keeps alive until they reply, possibly hours or
// days later. Not used on text-first conversations, since those ask for the VIN/plate
// inline in the same thread instead of needing a separate outbound message.
async function sendVehicleIdRequestText({ toNumber, name, vehicle_year, vehicle_make, vehicle_model }) {
  const body = `Hi ${name}, this is Chyne Tire! To make sure we bring the exact right tires for your ${vehicle_year} ${vehicle_make} ${vehicle_model}, could you text us back your VIN number or your license plate and state, whenever's easiest? We'll take it from there.`;

  try {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await client.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to: toNumber,
      body,
    });
    return { status: "sent", body };
  } catch (err) {
    console.error("Failed to send vehicle-ID follow-up text:", err.message);
    return { status: `failed: ${err.message}`, body };
  }
}

module.exports = { notifyMessageTaken, notifyIncompleteMessage, sendVehicleIdRequestText };
