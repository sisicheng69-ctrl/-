// guard_sdk/ai.js — AI gateway access for Guard sub-apps (Node).
//
// The same text API works in both environments:
// - sandbox preview -> RedCowork OpenAI-compatible proxy (`ai.protocol=openai`)
// - deployed Pod    -> Runway Bedrock (default when protocol is omitted)
// IMAGE remains an independent Google GenerateContent channel.
//
// Config ./ai.properties (keys carry the `ai.` prefix). Image keys read
// strictly from ai.image_* — never fall back to the text keys.
//
// Traps closed: protocol-specific headers/payloads, fake-200 {Code,Error}
// detection, OpenAI SSE parsing, and Gemini finishReason checks.

const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PROPS_PATH = path.join(PROJECT_ROOT, "ai.properties");

function loadProps() {
  let raw;
  try {
    raw = fs.readFileSync(PROPS_PATH, "utf-8");
  } catch (e) {
    // ENOENT is normal (no AI configured); anything else is a real problem
    // (permission denied, IO error, etc.) and must not be silently swallowed
    // — otherwise the caller falls through to bedrock and reports a cryptic
    // "Failed to parse URL" from an empty base_url.
    if (e.code === "ENOENT") return {};
    throw new Error(`guard_sdk/ai: cannot read ${PROPS_PATH}: ${e.message}`);
  }
  const props = {};
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("=");
    if (i < 0) continue;
    props[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  }
  return props;
}

function isAiEnabled() {
  const p = loadProps();
  // Both protocols only need base_url + api_key. The RedCowork proxy owns model
  // selection; production Bedrock ignores the client's model field.
  return Boolean(p["ai.base_url"] && p["ai.api_key"]);
}

function isImageEnabled() {
  const p = loadProps();
  return Boolean(p["ai.image_base_url"] && p["ai.image_api_key"]);
}

function checkBusinessError(data) {
  if (data && (data.Code || data.Error)) {
    throw new Error(`upstream business error: ${data.Error || data.Code}`);
  }
}

// --- TEXT: OpenAI Chat Completions or Bedrock InvokeModel --- //

function textCfg() {
  const p = loadProps();
  const base = (p["ai.base_url"] || "").replace(/\/$/, "");
  const key = p["ai.api_key"];
  // Fail loudly at call time rather than constructing a broken URL and
  // handing it to fetch — that surfaces as an opaque "Failed to parse URL"
  // that hides the fact ai.properties is missing/incomplete.
  if (!base) throw new Error(`guard_sdk/ai: ai.base_url missing in ${PROPS_PATH}`);
  if (!key) throw new Error(`guard_sdk/ai: ai.api_key missing in ${PROPS_PATH}`);
  const protocol = p["ai.protocol"] === "openai" ? "openai" : "bedrock";
  const headers =
    protocol === "openai"
      ? { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }
      : { token: key, "api-key": key, "Content-Type": "application/json" };
  return { base, headers, protocol };
}

function openAiMessages(messages, system) {
  return system ? [{ role: "system", content: system }, ...messages] : messages;
}

function openAiError(data, status) {
  const error = data && data.error;
  const detail =
    typeof error === "string"
      ? error
      : error && typeof error.message === "string"
        ? error.message
        : `HTTP ${status}`;
  return new Error(`OpenAI-compatible gateway error: ${detail}`);
}

function parseOpenAiSseLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice(5).trim();
  if (!payload) return null;
  if (payload === "[DONE]") return { done: true, text: "" };
  const data = JSON.parse(payload);
  if (data.error) throw openAiError(data, 200);
  const text = data.choices && data.choices[0] && data.choices[0].delta?.content;
  return { done: false, text: typeof text === "string" ? text : "" };
}

async function chat(messages, { system = null, maxTokens = 8000, thinking = false } = {}) {
  // Non-streaming chat -> concatenated text string.
  const { base, headers, protocol } = textCfg();
  if (protocol === "openai") {
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        messages: openAiMessages(messages, system),
        stream: false,
        max_tokens: maxTokens,
      }),
    });
    const data = await r.json();
    if (!r.ok || data.error) throw openAiError(data, r.status);
    const content = data.choices && data.choices[0] && data.choices[0].message?.content;
    if (typeof content !== "string") {
      throw new Error("OpenAI-compatible gateway returned no text content");
    }
    return content;
  }

  const body = { anthropic_version: "bedrock-2023-05-31", max_tokens: maxTokens, messages };
  if (system) body.system = system;
  if (thinking) {
    body.thinking = { type: "adaptive" };
    body.output_config = { effort: "medium" };
  }
  const r = await fetch(`${base}/bedrock_runtime/model/invoke`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const data = await r.json();
  checkBusinessError(data);
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

async function* chatStream(messages, { system = null, maxTokens = 2048 } = {}) {
  const { base, headers, protocol } = textCfg();
  if (protocol === "openai") {
    const resp = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        messages: openAiMessages(messages, system),
        stream: true,
        max_tokens: maxTokens,
      }),
    });
    if (!resp.ok) {
      const raw = await resp.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch (_) {
        data = {};
      }
      throw openAiError(data, resp.status);
    }
    if (!resp.body) throw new Error("OpenAI-compatible gateway returned no stream body");

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        buf += decoder.decode();
        break;
      }
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || "";
      for (const line of lines) {
        const event = parseOpenAiSseLine(line);
        if (!event) continue;
        if (event.done) return;
        if (event.text) yield event.text;
      }
    }
    if (buf) {
      const event = parseOpenAiSseLine(buf);
      if (event && !event.done && event.text) yield event.text;
    }
    return;
  }

  // Bedrock streaming uses a dedicated endpoint with base64-wrapped events.
  const body = { anthropic_version: "bedrock-2023-05-31", max_tokens: maxTokens, messages };
  if (system) body.system = system;
  const resp = await fetch(`${base}/bedrock_runtime/model/invoke-with-response-stream`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line) continue;
      let event;
      try {
        const outer = JSON.parse(line);
        const chunkB64 = outer && outer.chunk && outer.chunk.bytes;
        if (!chunkB64) continue;
        event = JSON.parse(Buffer.from(chunkB64, "base64").toString("utf8"));
      } catch (_) {
        continue;
      }
      if (
        event.type === "content_block_delta" &&
        event.delta &&
        event.delta.type === "text_delta" &&
        event.delta.text
      ) {
        yield event.delta.text;
      } else if (event.type === "message_stop") {
        return;
      }
    }
  }
}

function imageBlock(buffer, mediaType = "image/jpeg") {
  // vision content block for chat() (image input, text output)
  return {
    type: "image",
    source: { type: "base64", media_type: mediaType, data: Buffer.from(buffer).toString("base64") },
  };
}

// --- IMAGE: Google GenerateContent + Gemini Nano Banana --- //

const SAFETY_OFF = [
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_HARASSMENT",
].map((category) => ({ category, threshold: "OFF" }));

function imageCfg() {
  const p = loadProps();
  const base = (p["ai.image_base_url"] || "").replace(/\/$/, ""); // strict, no fallback
  const key = p["ai.image_api_key"];
  return { base, headers: { "api-key": key, "Content-Type": "application/json" } };
}

function extractImage(data) {
  checkBusinessError(data);
  const cand = (data.candidates || [])[0] || {};
  const reason = cand.finishReason;
  if (reason && reason !== "STOP" && reason !== "MAX_TOKENS") {
    throw new Error(`image generation refused: finishReason=${reason}`);
  }
  for (const part of (cand.content && cand.content.parts) || []) {
    if (part.inlineData && part.inlineData.data) {
      return Buffer.from(part.inlineData.data, "base64");
    }
  }
  throw new Error("image generation returned no inlineData");
}

async function generateImage(
  prompt,
  { aspectRatio = "1:1", imageSize = "1K", mimeType = "image/png" } = {},
) {
  // Text -> image. Returns a Buffer (persist via guard_sdk/db.uploadFile).
  const { base, headers } = imageCfg();
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 1,
      maxOutputTokens: 32768,
      responseModalities: ["TEXT", "IMAGE"],
      topP: 0.95,
      imageConfig: { aspectRatio, imageSize, imageOutputOptions: { mimeType } },
    },
    safetySettings: SAFETY_OFF,
  };
  const r = await fetch(`${base}/google/v1:generateContent`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return extractImage(await r.json());
}

async function editImage(prompt, referenceImages = []) {
  // referenceImages: [{ mime, buffer }] up to 14 combined into one output.
  const { base, headers } = imageCfg();
  const parts = referenceImages.slice(0, 14).map(({ mime, buffer }) => ({
    inlineData: { mimeType: mime, data: Buffer.from(buffer).toString("base64") },
  }));
  parts.push({ text: prompt });
  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: 1,
      maxOutputTokens: 32768,
      responseModalities: ["TEXT", "IMAGE"],
      topP: 0.95,
    },
    safetySettings: SAFETY_OFF,
  };
  const r = await fetch(`${base}/google/v1:generateContent`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return extractImage(await r.json());
}

module.exports = {
  isAiEnabled,
  isImageEnabled,
  chat,
  chatStream,
  imageBlock,
  generateImage,
  editImage,
};
