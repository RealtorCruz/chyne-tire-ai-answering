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

async function sendSms(to, body, mediaUrl) {
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  const params = { from: process.env.TWILIO_PHONE_NUMBER, to, body };
  if (mediaUrl) params.mediaUrl = [mediaUrl];
  await client.messages.create(params);
}

// Public URL of the door-jamb reference photo, served as a static file from this same
// Netlify site (see /assets/doorjamb-sticker.jpg in the repo). ~86KB -> costs about
// $0.04 per send (Twilio MMS: $0.02 base + $0.02/100KB), only sent when tire size is
// unknown. Update DOORJAMB_PHOTO_HOST if the Netlify site name ever changes.
const DOORJAMB_PHOTO_HOST = process.env.DOORJAMB_PHOTO_HOST || "https://chyne-tire-ai-answering.netlify.app";
const DOORJAMB_PHOTO_URL = `${DOORJAMB_PHOTO_HOST}/assets/doorjamb-sticker.jpg`;

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

  // Always shown - the confirmation photo is now always requested, whether or not a
  // tire size was given, since a stated size isn't always the one actually on the car.
  let photoStatus = "pending - asked by text";
  if (lead.photo_urls && lead.photo_urls.length) photoStatus = `door-jamb sticker sent:\n${lead.photo_urls.join("\n")}`;
  lines.push(`Confirmation photo: ${photoStatus}`);

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
  const needAddress = !lead.service_address;
  // Always requested unless a photo has already come in on this thread - not conditional
  // on whether a tire size was given, since a stated size can still be wrong for the car.
  const needPhoto = !(lead.photo_urls && lead.photo_urls.length);
  const spanish = lang && lang.startsWith("es");

  // Framed as "so we get you the right tires" rather than a task to complete - the
  // attached photo (see DOORJAMB_PHOTO_URL) is what "shows how simple it is" refers to.
  let body;
  if (needPhoto && needAddress) {
    body = spanish
      ? `Hola ${name}, le escribe Chyne Tire. Para asegurarnos de conseguirle las llantas correctas, le compartimos una foto que muestra lo fácil que es encontrar el tamaño exacto de sus llantas. ¿Nos puede enviar también la dirección donde estará el vehículo cuando vayamos?`
      : `Hi ${name}, this is Chyne Tire! So we make sure we get you the tires that are right for you, here's a picture showing how simple it is to find your exact tire size. Can you also send over the address where the vehicle will be when we come out?`;
  } else if (needPhoto) {
    body = spanish
      ? `Hola ${name}, le escribe Chyne Tire. Para asegurarnos de conseguirle las llantas correctas, le compartimos una foto que muestra lo fácil que es encontrar el tamaño exacto de sus llantas.`
      : `Hi ${name}, this is Chyne Tire! So we make sure we get you the tires that are right for you, here's a picture showing how simple it is to find your exact tire size.`;
  } else if (needAddress) {
    body = spanish
      ? `Hola ${name}, le escribe Chyne Tire. ¿Nos puede enviar la dirección donde estará el vehículo cuando vayamos?`
      : `Hi ${name}, this is Chyne Tire! Can you send over the address where the vehicle will be when we come out?`;
  } else {
    // Shouldn't normally happen (both already known), but keep a safe fallback.
    body = spanish
      ? `Gracias ${name}, ¡ya tenemos todo lo que necesitamos! Chyne Tire se pondrá en contacto pronto.`
      : `Thanks ${name}, we've got everything we need! Chyne Tire will be in touch soon.`;
  }

  // Attach the reference photo only when a door-jamb photo is actually being asked for -
  // the address-only message needs no picture.
  const mediaUrl = needPhoto ? DOORJAMB_PHOTO_URL : undefined;

  try {
    await sendSms(toNumber, body, mediaUrl);
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
