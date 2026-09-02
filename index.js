require("dotenv").config();
const express = require("express");
const lark = require("@larksuiteoapi/node-sdk");
const axios = require("axios");
const { Redis } = require("@upstash/redis");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const LARK_APP_ID = process.env.APPID || "";
const LARK_APP_SECRET = process.env.SECRET || "";
const OPENAI_KEY = process.env.KEY || "";
const OPENAI_MODEL = process.env.MODEL || "gpt-4o-mini";

// Cargar la base de datos de productos desde productos.md
let productosKnowledge = "";
try {
  const filePath = path.join(__dirname, "productos.md");
  productosKnowledge = fs.readFileSync(filePath, "utf8");
  console.log("✅ Base de datos productos.md cargada correctamente.");
} catch (error) {
  console.error("⚠️ No se pudo leer productos.md:", error.message);
}

const redis = (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  ? Redis.fromEnv() : null;

const client = new lark.Client({
  appId: LARK_APP_ID,
  appSecret: LARK_APP_SECRET,
  domain: lark.Domain.Lark,
});

function logger(tag, param) { console.error(`[${tag}]`, param); }

// Función para eliminar todo el formato Markdown predeterminado de OpenAI
function cleanMarkdown(text) {
  if (!text) return "";
  return text
    .replace(/^#{1,6}\s*/gm, "")       // Elimina los numerales de encabezados (###)
    .replace(/\*\*([^*]+)\*\*/g, "$1") // Elimina las negritas (**texto**)
    .replace(/\*([^*]+)\*/g, "$1")     // Elimina las cursivas (*texto*)
    .replace(/_([^_]+)_/g, "$1")       // Elimina subguiones (_texto_)
    .replace(/`([^`]+)`/g, "$1")       // Elimina marcas de código (`texto`)
    .trim();
}

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
  let messages = [
    {
      role: "system",
      content: `Eres el asistente virtual oficial de soporte e información sobre productos de Cubitt.

A continuación tienes la BASE DE DATOS OFICIAL de nuestros productos:

--- INICIO BASE DE DATOS ---
${productosKnowledge}
--- FIN BASE DE DATOS ---

REGLAS DE RESPUESTA OBLIGATORIAS:
1. Responde a las dudas del usuario basándote ÚNICAMENTE en la base de datos oficial provista arriba.
2. Si la información o el producto NO se encuentra especificado en la base de datos, responde exactamente: "Lo siento, no tengo esa información registrada en la base de datos oficial de productos."
3. JAMÁS inventes especificaciones, precios, medidas o funciones que no estén explícitamente escritas.
4. Mantén un tono profesional, claro y directo.
5. Usa únicamente texto plano con mayúsculas para títulos, guiones (-) o puntos (•) para listas y emojis para destacar aspectos clave.`
    }
  ];

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

async function getOpenAIReply(messages) {
  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      { model: OPENAI_MODEL.trim(), messages: messages },
      { 
        headers: { 
          Authorization: `Bearer ${OPENAI_KEY.trim()}`, 
          "Content-Type": "application/json" 
        }, 
        timeout: 50000 
      }
    );
    return response.data.choices[0].message.content;
  } catch (e) {
    const detail = e.response ? JSON.stringify(e.response.data) : e.message;
    logger("OpenAI API Error", detail);
    return "En este momento no puedo consultar la información. Por favor intenta de nuevo.";
  }
}

async function handleReply(userInput, sessionId, messageId, eventId) {
  const question = userInput.text.replace("@_user_1", "");
  if (question.trim() === "/clear") {
    if (redis) await redis.del(`history:${sessionId}`);
    await reply(messageId, "✅ Historial borrado");
    return { code: 0 };
  }
  const messages = await buildConversation(sessionId, question);
  const rawAnswer = await getOpenAIReply(messages);
  
  // Limpieza estricta de Markdown antes de responder en Lark
  const cleanAnswer = cleanMarkdown(rawAnswer);

  await saveConversation(sessionId, question, cleanAnswer);
  await reply(messageId, cleanAnswer);
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
