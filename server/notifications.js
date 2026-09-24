// Owner alerts + the customer follow-up text for Chyne Tire AI answering.
//
// OWNER ALERTS use one "lead card" format: the first alert (NEW) goes out the moment
// the lead is captured so hot leads can be called right away; every time the customer
// later texts in their VIN/plate/photo/address, the owner gets the WHOLE card again
// marked UPDATED - so whichever alert he opens last is the complete lead, and he never
// has to piece fragments together.
//
// Deliberately plain ASCII only (no emoji, no em dashes): a single non-GSM character
// switches the whole text to UCS-2 encoding, which cuts each segment from 160 to 67
// characters and roughly doubles-to-triples the cost of every alert.
//
// Requires these environment variables (Railway AND Netlify, since sms.js uses this too):
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER (the AI's number)
//   OWNER_CELL_NUMBER   (where the owner's alerts go)

const twilio = require("twilio");

async function sendSms(to, body) {
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  await client.messages.create({ from: process.env.TWILIO_PHONE_NUMBER, to, body });
}

function vehicleText(lead) {
  const v = [lead.vehicle_year, lead.vehicle_make, lead.vehicle_model]
    .filter((x) => x && x !== "not given")
    .join(" ");
  return v || "Vehicle not given";
}

// Builds the full lead card from everything known so far.
function formatLeadCard(lead, { phone, updated, header }) {
  const lines = [];
  lines.push(
    `${lead.urgent ? "URGENT - " : ""}${header || (updated ? "UPDATED TIRE LEAD" : "NEW TIRE LEAD")} - ${lead.name || "Unknown"}`
  );
  lines.push(vehicleText(lead));
  lines.push(`Needs: ${lead.reason || "not given"}${lead.quantity ? ` (qty: ${lead.quantity})` : ""}`);
  lines.push(`Tire size: ${lead.tire_size || "unknown"}`);
  lines.push(
    `City: ${lead.service_city || "not given"}${lead.possibly_out_of_area ? " (MAY BE OUTSIDE SERVICE AREA)" : ""}`
  );
  lines.push(`Service address: ${lead.service_address || "pending - asked by text"}`);

  let vehicleId = "pending - asked by text";
  if (lead.vin) vehicleId = `VIN ${lead.vin}`;
  else if (lead.plate) vehicleId = `Plate ${lead.plate}${lead.plate_state ? ` (${lead.plate_state})` : ""}`;
  else if (lead.photo_urls && lead.photo_urls.length) vehicleId = `photo sent:\n${lead.photo_urls.join("\n")}`;
  lines.push(`VIN/plate: ${vehicleId}`);

  lines.push(`Callback: ${lead.best_callback_time || "no preference given"}`);
  if (lead.notes) lines.push(`Notes: ${lead.notes}`);
  lines.push(`Phone: ${phone}`);
  lines.push(`Came in by: ${lead.channel === "text" ? "text" : "call"}`);
  return lines.join("\n");
}

// NEW lead card - sent the moment take_message fires (call or text).
async function notifyMessageTaken({ lead, callerNumber }) {
  try {
    await sendSms(process.env.OWNER_CELL_NUMBER, formatLeadCard(lead, { phone: callerNumber, updated: false }));
    return "sent";
  } catch (err) {
    console.error("Failed to send owner SMS alert:", err.message);
    return `failed: ${err.message}`;
  }
}

// UPDATED lead card - sent whenever the customer texts in VIN/plate/photo/address.
async function notifyLeadUpdated({ lead, callerNumber }) {
  try {
    await sendSms(process.env.OWNER_CELL_NUMBER, formatLeadCard(lead, { phone: callerNumber, updated: true }));
    return "sent";
  } catch (err) {
    console.error("Failed to send updated lead alert:", err.message);
    return `failed: ${err.message}`;
  }
}

// Fallback alert for a call that ended before take_message was ever confirmed
// (dropped call, hang-up, or a live-agent request that never finished). Same lead-card
// format as every other alert - no transcript, since a transcript can run 7+ segments
// per alert and the captured fields are the part the owner actually needs.
async function notifyIncompleteMessage({ callerNumber, requestCount, draft }) {
  const lead = { ...(draft || {}), channel: "call" };
  const card = formatLeadCard(lead, { phone: callerNumber, header: "POSSIBLE MISSED LEAD" }).split("\n");
  const why =
    requestCount > 0
      ? `(asked to speak with you directly ${requestCount}x, then the call ended before details were confirmed)`
      : "(call ended before the details were confirmed)";
  card.splice(1, 0, why);
  // A missed lead never got the follow-up text, so these aren't "asked by text" - just missing.
  const body = card
    .join("\n")
    .replace(/pending - asked by text/g, "not captured")
    .replace(/Came in by: call/, "Came in by: call (no follow-up text sent)");

  try {
    await sendSms(process.env.OWNER_CELL_NUMBER, body);
    return "sent";
  } catch (err) {
    console.error("Failed to send incomplete-message alert:", err.message);
    return `failed: ${err.message}`;
  }
}

// Sent to the CUSTOMER right after a VOICE call's take_message fires - asks for the
// VIN/plate and (unless they already gave it) the service address, and kicks off the
// text thread conversationStore.js keeps alive until they reply. Sent in Spanish if the
// call was in Spanish.
async function sendFollowupRequestText({ toNumber, lead, lang }) {
  const name = lead.name || "";
  const vehicle = vehicleText(lead);
  const needAddress = !lead.service_address;
  const spanish = lang && lang.startsWith("es");

  let body;
  if (spanish) {
    // Proper accents on purpose - unaccented Spanish reads as sloppy to a Spanish
    // speaker. Costs an extra segment or so (UCS-2), only on Spanish-language calls.
    body =
      `Hola ${name}, le escribe Chyne Tire. Para traer las llantas correctas para su ${vehicle}, ` +
      `¿nos puede enviar su número VIN o su placa y estado` +
      (needAddress ? `, y la dirección donde estará el vehículo cuando vayamos?` : `?`);
  } else {
    body =
      `Hi ${name}, this is Chyne Tire! To bring the exact right tires for your ${vehicle}, ` +
      `text us your VIN or license plate and state` +
      (needAddress ? `, plus the address where the vehicle will be when we come out.` : `.`);
  }

  try {
    await sendSms(toNumber, body);
    return { status: "sent", body };
  } catch (err) {
    console.error("Failed to send follow-up request text:", err.message);
    return { status: `failed: ${err.message}`, body };
  }
}

module.exports = {
  formatLeadCard,
  notifyMessageTaken,
  notifyLeadUpdated,
  notifyIncompleteMessage,
  sendFollowupRequestText,
};
