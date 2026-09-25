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
      partialPrompts="true"
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

wss.on("connection", (ws) => {
  // Conversation history is per-call, kept only in memory for the life of the call -
  // that's fine for VOICE, since a call is one continuous session with no "hours later"
  // gap. It's the TEXT side (netlify/functions/sms.js) that needs real persistence,
  // since a customer can reply to the follow-up text (photo/address) days later.
  let history = [];
  let callSid = null;
  let callerNumber = null;

  let callEnding = false;
  let messageTaken = false;

  // Guards against two responses generating at once. Twilio can deliver two separate
  // "prompt" events in quick succession (the caller spoke twice, or one utterance got
  // split into two). Without this, a second respond() could start - and push the
  // caller's new words into `history` - before the first respond() finishes appending
  // its assistant turn, breaking the required user/assistant/user/... alternation. That
  // corruption is what caused the AI to repeat itself with two slightly different
  // answers to the same thing. While `responding` is true, new caller speech is held in
  // `pendingCallerText` (NOT yet pushed to history) and only added, in order, once the
  // in-flight response has safely landed its assistant turn.
  let responding = false;
  let pendingCallerText = [];

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
      const goodbye = currentTtsLanguage.startsWith("es")
        ? "Parece que se cortó la llamada. Puede llamarnos de nuevo cuando guste. ¡Hasta luego!"
        : "Looks like we may have gotten disconnected - feel free to call back anytime. Goodbye!";
      console.log(`Call ${callSid} ended: silence timeout`);
      ws.send(JSON.stringify({ type: "text", token: goodbye, last: true, lang: currentTtsLanguage }));
      // Wait for the goodbye to actually be spoken before hanging up - ending immediately
      // (the old behavior) cut it off, so the caller just heard a click.
      const words = goodbye.split(/\s+/).filter(Boolean).length;
      setTimeout(() => {
        ws.send(JSON.stringify({ type: "end" }));
        ws.close();
      }, Math.max(1500, words * 400) + 800);
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
        console.log(`Call ${callSid} CALLER: ${msg.voicePrompt}`);

        if (responding) {
          // A response is already being generated for what the caller said a moment ago.
          // Hold this new bit of speech - do NOT touch history yet - and it'll be added
          // right after the in-flight turn finishes, in the correct order.
          console.log(`Call ${callSid}: caller spoke again mid-response, queueing: "${msg.voicePrompt}"`);
          pendingCallerText.push(msg.voicePrompt);
          return;
        }

        // If the last turn is a pending tool_result (a save the AI made while speaking),
        // attach the caller's words to it instead of adding a second back-to-back user turn.
        const lastTurn = history[history.length - 1];
        if (lastTurn && lastTurn.role === "user" && Array.isArray(lastTurn.content)) {
          lastTurn.content.push({ type: "text", text: msg.voicePrompt });
        } else {
          history.push({ role: "user", content: msg.voicePrompt });
        }
        await runResponse();
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
        if (responding) {
          // Same race as the prompt handler - hold it rather than risk corrupting history
          // while a response is already in flight.
          pendingCallerText.push(noteText);
        } else {
          const prevTurn = history[history.length - 1];
          if (prevTurn && prevTurn.role === "user" && Array.isArray(prevTurn.content)) {
            prevTurn.content.push({ type: "text", text: noteText });
          } else {
            history.push({ role: "user", content: noteText });
          }
          await runResponse();
        }
      }
      return;
    }

    if (msg.type === "interrupt") {
      resetSilenceTimer(); // caller talked over the AI - they're clearly still there
      console.log(`Call ${callSid}: caller interrupted AI after: "${msg.utteranceUntilInterrupt || ""}"`);
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
      }).catch((err) => console.error("Failed to send incomplete-message alert:", err.message));
    }
  });

  // Wraps respond() with the concurrency lock: sets `responding` for the duration of one
  // full turn (through the assistant reply landing in history), then flushes anything the
  // caller said in the meantime as a new, properly-ordered turn - never dropped, never
  // interleaved mid-turn.
  async function runResponse() {
    responding = true;
    try {
      await respond(ws, history, "voice", callerNumber);
    } finally {
      responding = false;
    }
    if (pendingCallerText.length > 0) {
      const combined = pendingCallerText.join(" ");
      pendingCallerText = [];
      console.log(`Call ${callSid}: flushing queued caller speech: "${combined}"`);
      const lastTurn = history[history.length - 1];
      if (lastTurn && lastTurn.role === "user" && Array.isArray(lastTurn.content)) {
        lastTurn.content.push({ type: "text", text: combined });
      } else {
        history.push({ role: "user", content: combined });
      }
      await runResponse();
    }
  }

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
      console.log(`Call ${callSid} AI: ${fullText.trim() || "(no spoken text this turn)"}`);

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

      // CRITICAL: Sonnet can return MORE THAN ONE tool_use block in a single turn (e.g.
      // saving a detail AND logging a live-agent request in the same reply). The API
      // requires every tool_use in a turn to get a matching tool_result in the very next
      // message - so ALL tool calls in this turn must be collected and answered together
      // in ONE combined user turn, never handled one-at-a-time with an early return. A
      // dangling, unanswered tool_use is exactly what silently broke the rest of a real
      // call tonight: every subsequent turn failed with the same 400 error once one
      // tool_use was left without its result.
      const toolUses = finalMessage.content.filter((b) => b.type === "tool_use");
      const toolResults = [];
      let mustContinue = false; // some tool result requires an immediate follow-up turn
      let savedSilently = false; // save_progress fired with nothing spoken this turn
      let endCallRequested = false;

      for (const tu of toolUses) {
        if (tu.name === "save_progress") {
          Object.assign(draftMessage, tu.input);
          console.log(`Call ${callSid}: progress saved (${Object.keys(tu.input).join(", ")})`);
          toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: "Saved." });
          if (!fullText.trim()) savedSilently = true;
        } else if (tu.name === "log_live_agent_request") {
          liveAgentRequestCount += 1;
          const reachedThreshold = liveAgentRequestCount >= 3;
          console.log(`Call ${callSid}: live-agent request logged (count=${liveAgentRequestCount})`);
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: reachedThreshold
              ? `This is request #${liveAgentRequestCount} - the threshold has been reached. Begin the escalation script now: acknowledge their request, briefly explain you need a few details to set up a callback, then ask for their name and best time to call back together in one question. Follow the normal read-back-and-confirm flow before recording anything, then say goodbye and end the call.`
              : `This is request #${liveAgentRequestCount} of 3 needed before escalating. Keep trying to help them directly and naturally - don't mention any request count or threshold. Only begin the escalation script once told the threshold is reached.`,
          });
          mustContinue = true;
        } else if (tu.name === "take_message") {
          messageTaken = true;
          // Anything save_progress captured but the final take_message left out still counts.
          const lead = { ...draftMessage, ...tu.input, channel: "call" };

          await notifyMessageTaken({ lead, callerNumber });


          // Kick off the follow-up text thread (service address, and a confirmation photo -
          // always requested, not just when tire size is unknown, since a stated size can
          // still be wrong for the car). The send is fire-and-forget, but seeding
          // conversationStore happens right after so a customer who replies quickly still
          // lands in the right thread.
          const needAddress = !lead.service_address;
          const needPhoto = true; // no photo could exist yet at voice intake time
          sendFollowupRequestText({ toNumber: callerNumber, lead, lang: currentTtsLanguage })
            .then(async (result) => {
              const still = [];
              if (needPhoto) still.push("a photo of the driver's-side door-jamb sticker (to double-check the tire size)");
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
                      (still.length
                        ? `You just texted them asking for ${still.join(" and ")}. `
                        : `You already have everything needed, no follow-up ask was sent. `) +
                      `Do not respond to this note itself - it's context for whatever they text next.]`,
                  },
                  {
                    role: "assistant",
                    content: [{ type: "text", text: result.body }],
                  },
                ],
                captured: lead,
                awaitingTireSizePhoto: needPhoto,
                awaitingAddress: needAddress,
                followupNudged: false,
              });
            })
            .catch((err) => console.error("Failed to seed conversation state after voice intake:", err.message));

          const explainParts = [];
          if (needPhoto) explainParts.push("a quick photo of the driver's-side door-jamb sticker to double-check the tire size");
          if (needAddress) explainParts.push("the address where the vehicle will be");
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: explainParts.length
              ? `Lead recorded. Now explain (out loud - don't collect this on the call) that Chyne Tire will text them shortly asking for ${explainParts.join(" and ")}, then say goodbye and end the call.`
              : "Lead recorded. Now let them know Chyne Tire has everything needed and will be in touch, then say goodbye and end the call.",
          });
          mustContinue = true;
        } else if (tu.name === "end_call") {
          endCallRequested = true;
          // Still needs a tool_result even though the call is ending - if end_call somehow
          // fired alongside another tool this turn (against instructions, but defensively
          // handled), every tool_use still needs an answer or the NEXT call's first turn
          // would inherit this same corruption.
          toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: "Call ending." });
        }
      }

      // ALL tool results from this turn go into ONE combined user turn - never split
      // across multiple pushes, which is what let a tool_use get left unanswered before.
      if (toolResults.length > 0) {
        history.push({ role: "user", content: toolResults });
      }

      if (endCallRequested) {
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
        return;
      }

      if (mustContinue) {
        await respond(ws, history, channel, callerNumber);
        return;
      }

      if (savedSilently) {
        // A save_progress fired with nothing spoken this turn and nothing else requiring
        // continuation - re-prompt so the caller isn't left in dead air.
        await respond(ws, history, channel, callerNumber);
        return;
      }
      // Otherwise: either nothing happened but plain speech, or save_progress fired
      // alongside actual spoken text - wait for the caller, per the original fix for the
      // repeat-itself bug (their next words attach to this turn via the "prompt" handler).
    } catch (err) {
      console.error("Error generating response:", err);
      const errorMessage = currentTtsLanguage.startsWith("es")
        ? "Lo siento, estoy teniendo problemas en este momento. Por favor intente llamar de nuevo en unos minutos."
        : "Sorry, I'm having trouble right now. Please try calling back in a few minutes.";
      ws.send(
        JSON.stringify({
          type: "text",
          token: errorMessage,
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
