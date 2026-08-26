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
const OPENAI_KEY = process.env.KEY || "";
const OPENAI_MODEL = process.env.MODEL || "gpt-3.5-turbo";
const OPENAI_MAX_TOKEN = parseInt(process.env.MAX_TOKEN || "1024", 10);

// Configuración de Redis para reemplazar aircode.db
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

// --- Métodos de respuesta y comunicación con Lark ---
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

// --- Gestión del Historial (Reemplazo de MsgTable de AirCode) ---
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
  let prompt = [];
  const historyMsgs = await getHistory(sessionId);

  for (const conversation of historyMsgs) {
    prompt.push({ role: "user", content: conversation.question });
    prompt.push({ role: "assistant", content: conversation.answer });
  }

  prompt.push({ role: "user", content: question });
  return prompt;
}

async function saveConversation(sessionId, question, answer) {
  if (!redis) return;
  try {
    let history = await getHistory(sessionId);
    history.push({ question, answer });

    // Control de límite de tokens / mensajes guardados (mantiene los últimos 10)
    if (history.length > 10) {
      history = history.slice(-10);
    }

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

// Control de duplicados de eventos (Reemplazo de EventDB)
async function isDuplicateEvent(eventId) {
  if (!redis) return false;
  try {
    const exists = await redis.get(`event:${eventId}`);
    if (exists) return true;
    
    // Guardar evento por 1 hora (3600 segundos) para evitar procesarlo 2 veces
    await redis.set(`event:${eventId}`, "1", { ex: 3600 });
    return false;
  } catch (e) {
    logger("Redis Event Error", e);
    return false;
  }
}

// --- Comandos ---
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
  const helpText = `Lark GPT manpages

Usage:
    /clear    remove conversation history for get a new, clean, bot context.
    /help     get more help message`;
  await reply(messageId, helpText);
}

async function cmdClear(sessionId, messageId) {
  await clearConversation(sessionId);
  await reply(messageId, "✅ All history removed");
}

// --- Integración con OpenAI ---
async function getOpenAIReply(prompt) {
  const data = JSON.stringify({
    model: OPENAI_MODEL,
    messages: prompt,
  });

  const config = {
    method: "post",
    maxBodyLength: Infinity,
    url: "https://api.openai.com/v1/chat/completions",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    data: data,
    timeout: 50000,
  };

  try {
    const response = await axios(config);
    if (response.status === 429) {
      return "Too many questions, can you wait and re-ask later?";
    }
    return response.data.choices[0].message.content.replace("\n\n", "");
  } catch (e) {
    logger("OpenAI API Error", e.response ? e.response.data : e.message);
    return "This question is too difficult, you may ask my owner.";
  }
}

// --- Autochequeo / Doctor ---
function doctor() {
  if (LARK_APP_ID === "" || !LARK_APP_ID.startsWith("cli_")) {
    return { code: 1, message: "Lark APP ID faltante o inválido (debe empezar con cli_)." };
  }
  if (LARK_APP_SECRET === "") {
    return { code: 1, message: "Lark APP Secret faltante." };
  }
  if (OPENAI_KEY === "" || !OPENAI_KEY.startsWith("sk-")) {
    return { code: 1, message: "OpenAI Key faltante o inválida (debe empezar con sk-)." };
  }
  return {
    code: 0,
    message: "✅ Configuración correcta.",
    meta: { LARK_APP_ID, OPENAI_MODEL, OPENAI_MAX_TOKEN },
  };
}

// --- Procesador Principal de Mensajes ---
async function handleReply(userInput, sessionId, messageId, eventId) {
  const question = userInput.text.replace("@_user_1", "");
  logger("LOG", "Question: " + question);

  const action = question.trim();
  if (action.startsWith("/")) {
    return await cmdProcess({ action, sessionId, messageId });
  }

  const prompt = await buildConversation(sessionId, question);
  const openaiResponse = await getOpenAIReply(prompt);

  await saveConversation(sessionId, question, openaiResponse);
  await reply(messageId, openaiResponse);

  return { code: 0 };
}

// --- Endpoint de Express para recibir los Webhooks de Lark ---
app.post("/", async (req, res) => {
  const params = req.body;

  // Si tiene encriptación activada
  if (params.encrypt) {
    return res.json({
      code: 1,
      message: { en_US: "You have open Encrypt Key Feature, please close it." },
    });
  }

  // Verificación inicial del Webhook por parte de Lark (url_verification)
  if (params.type === "url_verification") {
    return res.json({ challenge: params.challenge });
  }

  // Ejecución de autochequeo si se invoca sin encabezados
  if (!params.hasOwnProperty("header")) {
    return res.json(doctor());
  }

  // Procesamiento del evento de mensaje recibido
  if (params.header && params.header.event_type === "im.message.receive_v1") {
    const eventId = params.header.event_id;
    const messageId = params.event.message.message_id;
    const chatId = params.event.message.chat_id;
    const senderId = params.event.sender.sender_id.user_id;
    const sessionId = chatId + senderId;

    // Control de eventos duplicados
    if (await isDuplicateEvent(eventId)) {
      logger("LOG", "Skip repeat event: " + eventId);
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

// Inicio del servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor activo corriendo en el puerto ${PORT}`);
});
