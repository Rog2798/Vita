require("dotenv").config();
const express = require("express");
const lark = require("@larksuiteoapi/node-sdk");
const axios = require("axios");
const { Redis } = require("@upstash/redis");

const app = express();
app.use(express.json());

const LARK_APP_ID = process.env.APPID || "";
const LARK_APP_SECRET = process.env.SECRET || "";
const GROQ_KEY = process.env.KEY || "";
const GROQ_MODEL = process.env.MODEL || "llama-3.3-70b-versatile";

const redis = (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  ? Redis.fromEnv() : null;

const client = new lark.Client({
  appId: LARK_APP_ID,
  appSecret: LARK_APP_SECRET,
  domain: lark.Domain.Lark,
});

function logger(tag, param) { console.error(`[${tag}]`, param); }

async function reply(messageId, content) {
  try {
    return await client.im.message.reply({
      path: { message_id: messageId },
      data: { content: JSON.stringify({ text: content }), msg_type: "text" },
    });
  } catch (e) { logger("Lark Reply Error", e); }
}

async function getHistory(sessionId) {
  if (!redis) return [];
  try { return await redis.get(`history:${sessionId}`) || []; }
  catch (e) { return []; }
}

async function buildConversation(sessionId, question) {
  let messages = [];
  const history = await getHistory(sessionId);
  for (const h of history) {
    messages.push({ role: "user", content: h.question });
    messages.push({ role: "assistant", content: h.answer });
  }
  messages.push({ role: "user", content: question });
  return messages;
}

async function saveConversation(sessionId, question, answer) {
  if (!redis) return;
  try {
    let history = await getHistory(sessionId);
    history.push({ question, answer });
    if (history.length > 10) history = history.slice(-10);
    await redis.set(`history:${sessionId}`, JSON.stringify(history));
  } catch (e) {}
}

async function isDuplicateEvent(eventId) {
  if (!redis) return false;
  try {
    const exists = await redis.get(`event:${eventId}`);
    if (exists) return true;
    await redis.set(`event:${eventId}`, "1", { ex: 3600 });
    return false;
  } catch (e) { return false; }
}

async function getGroqReply(messages) {
  try {
    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      { model: GROQ_MODEL.trim(), messages: messages },
      { headers: { Authorization: `Bearer ${GROQ_KEY.trim()}`, "Content-Type": "application/json" }, timeout: 30000 }
    );
    return response.data.choices[0].message.content;
  } catch (e) {
    logger("Groq API Error", e.response ? JSON.stringify(e.response.data) : e.message);
    return "This question is too difficult, you may ask my owner.";
  }
}

async function handleReply(userInput, sessionId, messageId, eventId) {
  const question = userInput.text.replace("@_user_1", "");
  if (question.trim() === "/clear") {
    if (redis) await redis.del(`history:${sessionId}`);
    await reply(messageId, "✅ All history removed");
    return { code: 0 };
  }
  const messages = await buildConversation(sessionId, question);
  const answer = await getGroqReply(messages);
  await saveConversation(sessionId, question, answer);
  await reply(messageId, answer);
  return { code: 0 };
}

app.post("/", async (req, res) => {
  const params = req.body;
  if (params.type === "url_verification") return res.json({ challenge: params.challenge });
  if (params.header && params.header.event_type === "im.message.receive_v1") {
    const { event_id } = params.header;
    const { message_id, chat_id, chat_type, message_type, content } = params.event.message;
    const sender_id = params.event.sender.sender_id.user_id;
    
    if (await isDuplicateEvent(event_id)) return res.json({ code: 1 });
    if ((chat_type === "p2p" || chat_type === "group") && message_type === "text") {
      await handleReply(JSON.parse(content), chat_id + sender_id, message_id, event_id);
    }
  }
  return res.json({ code: 0 });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
