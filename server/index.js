require("dotenv").config();
const express = require("express");
const { WebSocketServer } = require("ws");
const http = require("http");
const Anthropic = require("@anthropic-ai/sdk");
const {
  SYSTEM_PROMPT,
  TAKE_MESSAGE_TOOL,
  END_CALL_TOOL,
  REQUEST_LIVE_AGENT_TOOL,
  SAVE_PROGRESS_TOOL,
} = require("./persona");
const { notifyMessageTaken, notifyIncompleteMessage, sendFollowupRequestText } = require("./notifications");
const { logCustomerField } = require("./customerLog");
const { saveConversation } = require("./conversationStore");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---- Prompt caching (cuts Sonnet input cost) ----
// The persona + tool definitions are identical on every turn of every call, so they're
// sent as a cached block: after the first write, Sonnet re-reads them at ~10% of normal
// input price. A second cache breakpoint on the newest turn lets each turn re-read the
// earlier part of the conversation from cache instead of paying full price for it again.
const CACHED_SYSTEM = [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }];

// Returns a copy of the history with a cache breakpoint on the last content block.
// Never mutates the real history, so breakpoints don't pile up turn after turn.
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

const PORT = process.env.PORT || 3000;
// Set this to your deployed Railway URL once you have it, e.g. chyne-tire-ai-answering.up.railway.app
const PUBLIC_HOSTNAME = process.env.PUBLIC_HOSTNAME;

// ---- 1. Voice webhook: Twilio hits this when a call comes in ----
app.post("/voice", (req, res) => {
  const wsUrl = `wss://${PUBLIC_HOSTNAME}/relay`;
  // ElevenLabs voices, picked from Twilio's ConversationRelay voice list. No ElevenLabs
  // account needed - Twilio ConversationRelay provides ElevenLabs voices directly.
  const ENGLISH_VOICE_ID = "UgBBYS2sOqTuMpoF3BR0";
  const SPANISH_VOICE_ID = "6VhI0BBMzbLqzPaeqUCz"; // same Spanish voice as the real estate line
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay
      url="${wsUrl}"
      transcriptionProvider="Deepgram"
      transcriptionLanguage="multi"
      ttsProvider="ElevenLabs"
      dtmfDetection="true"
      welcomeGreeting="Thanks for calling Chyne Tire! We come to you, by appointment. How can I help?"
    >
      <Language code="en-US" ttsProvider="ElevenLabs" voice="${ENGLISH_VOICE_ID}" />
      <Language code="es-US" ttsProvider="ElevenLabs" voice="${SPANISH_VOICE_ID}" />
    </ConversationRelay>
  </Connect>
</Response>`;
  res.type("text/xml").send(twiml);
});

app.get("/", (req, res) => res.send("Chyne Tire AI answering - voice server is running."));

// ---- 2. WebSocket relay: Twilio ConversationRelay connects here per-call ----
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/relay" });

// Pulls plain spoken text out of the raw Claude message history for the missed-escalation
// fallback alert. Caps to the last few turns since only the tail end right before a
// hangup is relevant.
function extractTranscript(history, maxTurns = 10) {
  const lines = [];
  for (const turn of history.slice(-maxTurns)) {
    const speaker = turn.role === "user" ? "Caller" : "AI";
    let text = "";
    if (typeof turn.content === "string") {
      text = turn.content.replace(/^\[System note[^\]]*\]\s*/, "");
    } else if (Array.isArray(turn.content)) {
      text = turn.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join(" ");
    }
    text = text.trim();
    if (text) lines.push(`${speaker}: ${text}`);
  }
  return lines.join("\n");
}

wss.on("connection", (ws) => {
  // Conversation history is per-call, kept only in memory for the life of the call -
  // that's fine for VOICE, since a call is one continuous session with no "hours later"
  // gap. It's the TEXT side (netlify/functions/sms.js) that needs real persistence,
  // since a customer can reply to the vehicle-ID follow-up text days later.
  let history = [];
  let callSid = null;
  let callerNumber = null;

  let callEnding = false;
  let messageTaken = false;

  let liveAgentRequestCount = 0;
  let dtmfBuffer = "";
  let liveAgentEscalationTriggered = false;

  // Running real-time save of whatever intake fields the AI has learned so far (see
  // save_progress tool) - survives a dropped call even if take_message never fires.
  let draftMessage = {};

  // Which of the two configured <Language> voices (see /voice TwiML above) TTS should
  // use right now - defaults to English (matching the English-only greeting).
  let currentTtsLanguage = "en-US";

  const SILENCE_TIMEOUT_MS = 20000;
  let silenceTimer = null;

  function resetSilenceTimer(extraDelayMs = 0) {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      callEnding = true;
      console.log(`Call ${callSid} ended: silence timeout`);
      ws.send(
        JSON.stringify({
          type: "text",
          token: "Looks like we may have gotten disconnected - feel free to call back anytime. Goodbye!",
          last: true,
          lang: currentTtsLanguage,
        })
      );
      ws.send(JSON.stringify({ type: "end" }));
      ws.close();
    }, SILENCE_TIMEOUT_MS + extraDelayMs);
  }

  ws.on("message", async (raw) => {
    if (callEnding) return;

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      console.error("Bad message from Twilio:", raw.toString());
      return;
    }

    if (msg.type === "setup") {
      callSid = msg.callSid;
      callerNumber = msg.from;
      console.log(`Call started: ${callSid} from ${callerNumber}`);
      resetSilenceTimer();
      return;
    }

    if (msg.type === "prompt") {
      resetSilenceTimer();
      if (msg.last) {
        if (msg.lang && msg.lang.startsWith("es")) {
          currentTtsLanguage = "es-US";
        } else if (msg.lang && msg.lang.startsWith("en")) {
          currentTtsLanguage = "en-US";
        }
        console.log(`Call ${callSid}: detected lang=${msg.lang} -> using ${currentTtsLanguage}`);

        // If the last turn is a pending tool_result (a save the AI made while speaking),
        // attach the caller's words to it instead of adding a second back-to-back user turn.
        const lastTurn = history[history.length - 1];
        if (lastTurn && lastTurn.role === "user" && Array.isArray(lastTurn.content)) {
          lastTurn.content.push({ type: "text", text: msg.voicePrompt });
        } else {
          history.push({ role: "user", content: msg.voicePrompt });
        }
        await respond(ws, history, "voice", callerNumber);
      }
      return;
    }

    if (msg.type === "dtmf") {
      resetSilenceTimer();
      dtmfBuffer = (dtmfBuffer + msg.digit).slice(-3);
      if (!liveAgentEscalationTriggered && dtmfBuffer === "000") {
        liveAgentEscalationTriggered = true;
        console.log(`Call ${callSid}: caller pressed 0-0-0, triggering live-agent escalation`);
        const noteText =
            "[System note: caller just pressed 0-0-0 on their keypad, which immediately " +
            "requests a live person regardless of how many times they've asked verbally. " +
            "Begin the escalation script now: acknowledge the request, briefly explain you " +
            "need a few details to set up a callback, then ask for their name and best time " +
            "to call back together in one question. Follow the normal read-back-and-confirm " +
            "flow before recording, and end the call once it's taken.";
        const prevTurn = history[history.length - 1];
        if (prevTurn && prevTurn.role === "user" && Array.isArray(prevTurn.content)) {
          prevTurn.content.push({ type: "text", text: noteText });
        } else {
          history.push({ role: "user", content: noteText });
        }
        await respond(ws, history, "voice", callerNumber);
      }
      return;
    }

    if (msg.type === "interrupt") {
      const last = history[history.length - 1];
      if (last && last.role === "assistant" && typeof last.content === "string") {
        last.content = msg.utteranceUntilInterrupt || last.content;
      }
      return;
    }

    if (msg.type === "error") {
      console.error("ConversationRelay error:", msg.description);
    }
  });

  ws.on("close", () => {
    clearTimeout(silenceTimer);
    console.log(`Call ended: ${callSid}`);
    if (!messageTaken && (Object.keys(draftMessage).length > 0 || liveAgentRequestCount > 0) && callerNumber) {
      notifyIncompleteMessage({
        callerNumber,
        requestCount: liveAgentRequestCount,
        draft: draftMessage,
        transcript: extractTranscript(history),
      }).catch((err) => console.error("Failed to send incomplete-message alert:", err.message));
    }
  });

  async function respond(ws, history, channel, callerNumber) {
    try {
      const stream = anthropic.messages.stream({
        model: "claude-sonnet-5",
        max_tokens: 400,
        system: CACHED_SYSTEM,
        tools: [TAKE_MESSAGE_TOOL, END_CALL_TOOL, REQUEST_LIVE_AGENT_TOOL, SAVE_PROGRESS_TOOL],
        messages: withCacheBreakpoint(history),
      });

      let fullText = "";
      stream.on("text", (textDelta) => {
        fullText += textDelta;
        ws.send(
          JSON.stringify({
            type: "text",
            token: textDelta,
            last: false,
            lang: currentTtsLanguage,
          })
        );
      });

      const finalMessage = await stream.finalMessage();

      // Token/cache usage per turn - check Railway Deploy Logs to confirm caching is working
      // (cache_read should be large and input small after the first turn).
      const u = finalMessage.usage || {};
      console.log(
        `Call ${callSid} tokens: input=${u.input_tokens} cache_write=${u.cache_creation_input_tokens || 0} ` +
          `cache_read=${u.cache_read_input_tokens || 0} output=${u.output_tokens}`
      );

      ws.send(JSON.stringify({ type: "text", token: "", last: true, lang: currentTtsLanguage }));

      const spokenWordCount = fullText.split(/\s+/).filter(Boolean).length;
      const estimatedPlaybackMs = Math.max(1500, spokenWordCount * 400) + 800;
      resetSilenceTimer(estimatedPlaybackMs);

      const cleanContent = finalMessage.content.filter(
        (b) => b.type !== "thinking" && b.type !== "redacted_thinking"
      );
      history.push({ role: "assistant", content: cleanContent });

      const saveProgressToolUse = finalMessage.content.find(
        (b) => b.type === "tool_use" && b.name === "save_progress"
      );
      if (saveProgressToolUse) {
        Object.assign(draftMessage, saveProgressToolUse.input);
        console.log(`Call ${callSid}: progress saved (${Object.keys(saveProgressToolUse.input).join(", ")})`);
        logCustomerField({ phone: callerNumber, source: "AI Call", ...draftMessage });
        history.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: saveProgressToolUse.id, content: "Saved." }],
        });
        // If the AI already spoke in this same turn (the normal Sonnet pattern: talk + save
        // together), DON'T prompt it again - that's what made it repeat itself. Just wait
        // for the caller; their next words get attached to this tool_result turn (see the
        // "prompt" handler). Only re-prompt if the save was silent, so the caller isn't
        // left in dead air.
        if (fullText.trim()) return;
        await respond(ws, history, channel, callerNumber);
        return;
      }

      const liveAgentToolUse = finalMessage.content.find(
        (b) => b.type === "tool_use" && b.name === "log_live_agent_request"
      );
      if (liveAgentToolUse) {
        liveAgentRequestCount += 1;
        const reachedThreshold = liveAgentRequestCount >= 3;
        console.log(`Call ${callSid}: live-agent request logged (count=${liveAgentRequestCount})`);
        history.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: liveAgentToolUse.id,
              content: reachedThreshold
                ? `This is request #${liveAgentRequestCount} - the threshold has been reached. Begin the escalation script now: acknowledge their request, briefly explain you need a few details to set up a callback, then ask for their name and best time to call back together in one question. Follow the normal read-back-and-confirm flow before recording anything, then say goodbye and end the call.`
                : `This is request #${liveAgentRequestCount} of 3 needed before escalating. Keep trying to help them directly and naturally - don't mention any request count or threshold. Only begin the escalation script once told the threshold is reached.`,
            },
          ],
        });
        await respond(ws, history, channel, callerNumber);
        return;
      }

      const toolUse = finalMessage.content.find((b) => b.type === "tool_use" && b.name === "take_message");
      if (toolUse) {
        messageTaken = true;
        // Anything save_progress captured but the final take_message left out still counts.
        const lead = { ...draftMessage, ...toolUse.input, channel: "call" };

        await notifyMessageTaken({ lead, callerNumber });

        logCustomerField({ phone: callerNumber, ...lead, source: "AI Call" });

        // Kick off the follow-up text thread (VIN/plate + service address). The send is
        // fire-and-forget, but seeding conversationStore happens right after so a
        // customer who replies quickly still lands in the right thread.
        sendFollowupRequestText({ toNumber: callerNumber, lead, lang: currentTtsLanguage })
          .then(async (result) => {
            const needAddress = !lead.service_address;
            const still = ["their VIN or license plate + state"];
            if (needAddress) still.push("the full address where the vehicle will be for service");
            // The Messages API requires the FIRST turn to be role "user", so a synthetic
            // system-note user turn goes ahead of the outbound text. It also gives the
            // model exactly the context it needs to address them by name and not re-ask
            // anything once they reply.
            await saveConversation(callerNumber, {
              history: [
                {
                  role: "user",
                  content:
                    `[System note: ${lead.name} just finished a call with Chyne Tire. Captured: ` +
                    `need "${lead.reason}"${lead.quantity ? ` (qty ${lead.quantity})` : ""}, ` +
                    `vehicle ${lead.vehicle_year || ""} ${lead.vehicle_make || ""} ${lead.vehicle_model || ""}, ` +
                    `tire size ${lead.tire_size || "unknown"}, city ${lead.service_city || "not given"}, ` +
                    `${lead.service_address ? `service address ${lead.service_address}, ` : ""}` +
                    `best callback time "${lead.best_callback_time || "no preference given"}". ` +
                    `The call was in ${currentTtsLanguage.startsWith("es") ? "Spanish" : "English"}. ` +
                    `You just texted them asking for ${still.join(" and ")}. ` +
                    `Do not respond to this note itself - it's context for whatever they text next.]`,
                },
                {
                  role: "assistant",
                  content: [{ type: "text", text: result.body }],
                },
              ],
              captured: lead,
              awaitingVehicleId: true,
              awaitingAddress: needAddress,
              followupNudged: false,
            });
          })
          .catch((err) => console.error("Failed to seed conversation state after voice intake:", err.message));

        history.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUse.id,
              content:
                "Lead recorded. Now explain (out loud - don't collect either on this call) that Chyne Tire will text them shortly asking for their VIN or license plate" +
                (lead.service_address ? "" : " and the address where the vehicle will be") +
                ", then say goodbye and end the call.",
            },
          ],
        });

        await respond(ws, history, channel, callerNumber);
        return;
      }

      const endCallToolUse = finalMessage.content.find((b) => b.type === "tool_use" && b.name === "end_call");
      if (endCallToolUse) {
        callEnding = true;
        clearTimeout(silenceTimer);

        let spokenGoodbye = fullText.trim();
        if (!spokenGoodbye) {
          console.log(`Call ${callSid}: end_call fired with no spoken goodbye - using fallback`);
          spokenGoodbye = "Thanks so much for calling - have a great day!";
          ws.send(JSON.stringify({ type: "text", token: spokenGoodbye, last: true, lang: currentTtsLanguage }));
        }

        const wordCount = spokenGoodbye.split(/\s+/).filter(Boolean).length;
        const speakingDelayMs = Math.max(1500, wordCount * 400) + 800;

        console.log(`Call ${callSid} ending: waiting ${speakingDelayMs}ms for goodbye to finish (message_taken=${messageTaken})`);
        setTimeout(() => {
          ws.send(JSON.stringify({ type: "end" }));
          ws.close();
        }, speakingDelayMs);
      }
    } catch (err) {
      console.error("Error generating response:", err);
      ws.send(
        JSON.stringify({
          type: "text",
          token: "Sorry, I'm having trouble right now. Please try calling back in a few minutes.",
          last: true,
          lang: currentTtsLanguage,
        })
      );
    }
  }
});

server.listen(PORT, () => {
  console.log(`Voice server listening on port ${PORT}`);
});
