require("dotenv").config();
const express = require("express");
const lark = require("@larksuiteoapi/node-sdk");
const axios = require("axios");
const { Redis } = require("@upstash/redis");

const app = express();
app.use(express.json());

// Variables de entorno
const LARK_APP_ID = process.env.APPID || "";
const LARK_APP_SECRET = process.env.SECRET || "";
const GROQ_KEY = process.env.KEY || "";
const GROQ_MODEL = process.env.MODEL || "llama-3.1-8b-instant";

// Configuración de Redis
const redis = (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  ? Redis.fromEnv()
  : null;

// Cliente de Lark
const client = new lark.Client({
  appId: LARK_APP_ID,
  appSecret: LARK_APP_SECRET,
  disableTokenCache: false,
  domain: lark.Domain.Lark,
});

function logger(tag, param) {
  console.error(`[${tag}]`, param);
}

// Métodos de respuesta para Lark
async function reply(messageId, content) {
  try {
    return await client.im.message.reply({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify({ text: content }),
        msg_type: "text",
      },
    });
  } catch (e) {
    logger("send message to Lark error", e);
  }
}

// Gestión del Historial
async function getHistory(sessionId) {
  if (!redis) return [];
  try {
    const history = await redis.get(`history:${sessionId}`);
    return history || [];
  } catch (e) {
    logger("Redis Get Error", e);
    return [];
  }
}

async function buildConversation(sessionId, question) {
  let messages = [];
  const historyMsgs = await getHistory(sessionId);

  for (const conversation of historyMsgs) {
    messages.push({ role: "user", content: conversation.question });
    messages.push({ role: "assistant", content: conversation.answer });
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
  } catch (e) {
    logger("Redis Save Error", e);
  }
}

async function clearConversation(sessionId) {
  if (!redis) return;
  try {
    await redis.del(`history:${sessionId}`);
  } catch (e) {
    logger("Redis Clear Error", e);
  }
}

async function isDuplicateEvent(eventId) {
  if (!redis) return false;
  try {
    const exists = await redis.get(`event:${eventId}`);
    if (exists) return true;
    await redis.set(`event:${eventId}`, "1", { ex: 3600 });
    return false;
  } catch (e) {
    logger("Redis Event Error", e);
    return false;
  }
}

// Comandos
async function cmdProcess(cmdParams) {
  switch (cmdParams && cmdParams.action) {
    case "/help":
      await cmdHelp(cmdParams.messageId);
      break;
    case "/clear":
      await cmdClear(cmdParams.sessionId, cmdParams.messageId);
      break;
    default:
      await cmdHelp(cmdParams.messageId);
      break;
  }
  return { code: 0 };
}

async function cmdHelp(messageId) {
  const helpText = `Lark Bot (Powered by Groq / Llama 3)

Usage:
    /clear    remove conversation history.
    /help     get help message`;
  await reply(messageId, helpText);
}

async function cmdClear(sessionId, messageId) {
  await clearConversation(sessionId);
  await reply(messageId, "✅ All history removed");
}

// Integración con Groq API
async function getGroqReply(messages) {
  const config = {
    method: "post",
    url: "https://api.groq.com/openai/v1/chat/completions",
    headers: {
      Authorization: `Bearer ${GROQ_KEY.trim()}`,
      "Content-Type": "application/json",
    },
    data: {
      model: GROQ_MODEL.trim(),
      messages: messages,
    },
    timeout: 30000,
  };

  try {
    const response = await axios(config);
    return response.data.choices[0].message.content;
  } catch (e) {
    logger("Groq API Error", e.response ? JSON.stringify(e.response.data) : e.message);
    return "This question is too difficult, you may ask my owner.";
  }
}

// Doctor
function doctor() {
  if (LARK_APP_ID === "" || !LARK_APP_ID.startsWith("cli_")) {
    return { code: 1, message: "Lark APP ID faltante o inválido." };
  }
  if (GROQ_KEY === "") {
    return { code: 1, message: "Groq Key faltante." };
  }
  return {
    code: 0,
    message: "✅ Configuración correcta con Groq.",
    meta: { LARK_APP_ID, GROQ_MODEL },
  };
}

// Procesador Principal
async function handleReply(userInput, sessionId, messageId, eventId) {
  const question = userInput.text.replace("@_user_1", "");
  logger("LOG", "Question: " + question);

  const action = question.trim();
  if (action.startsWith("/")) {
    return await cmdProcess({ action, sessionId, messageId });
  }

  const messages = await buildConversation(sessionId, question);
  const groqResponse = await getGroqReply(messages);

  await saveConversation(sessionId, question, groqResponse);
  await reply(messageId, groqResponse);

  return { code: 0 };
}

// Endpoint de Express
app.post("/", async (req, res) => {
  const params = req.body;

  if (params.encrypt) {
    return res.json({ code: 1, message: { en_US: "You have open Encrypt Key Feature, please close it." } });
  }

  if (params.type === "url_verification") {
    return res.json({ challenge: params.challenge });
  }

  if (!params.hasOwnProperty("header")) {
    return res.json(doctor());
  }

  if (params.header && params.header.event_type === "im.message.receive_v1") {
    const eventId = params.header.event_id;
    const messageId = params.event.message.message_id;
    const chatId = params.event.message.chat_id;
    const senderId = params.event.sender.sender_id.user_id;
    const sessionId = chatId + senderId;

    if (await isDuplicateEvent(eventId)) {
      return res.json({ code: 1 });
    }

    const chatType = params.event.message.chat_type;
    if (chatType === "p2p" || chatType === "group") {
      if (params.event.message.message_type !== "text") {
        await reply(messageId, "Not support other format question, only text.");
        return res.json({ code: 0 });
      }

      const userInput = JSON.parse(params.event.message.content);
      const result = await handleReply(userInput, sessionId, messageId, eventId);
      return res.json(result);
    }
  }

  return res.json({ code: 2 });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor activo corriendo en el puerto ${PORT}`);
});
