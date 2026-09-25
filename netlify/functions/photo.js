// Serves a re-hosted customer photo by its random ID - this is the link Mark actually
// clicks. Plain image response, no authentication required (see photoStore.js for why).
//
// URL shape: https://<this-site>.netlify.app/.netlify/functions/photo?id=<32-hex-chars>

const { getPhoto } = require("../../server/photoStore");

exports.handler = async (event) => {
  const id = event.queryStringParameters && event.queryStringParameters.id;
  if (!id) {
    return { statusCode: 400, body: "Missing id" };
  }

  const photo = await getPhoto(id);
  if (!photo) {
    // Covers "never existed", "wrong id", and "existed but is past the 30-day limit" -
    // all three should look the same to whoever's clicking the link, no need to
    // distinguish "expired" from "invalid" for Mark.
    return { statusCode: 404, body: "Photo not found or expired." };
  }

  return {
    statusCode: 200,
    headers: {
      "Content-Type": photo.contentType,
      "Cache-Control": "private, max-age=3600",
    },
    body: photo.buffer.toString("base64"),
    isBase64Encoded: true,
  };
};
