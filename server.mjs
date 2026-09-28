#!/usr/bin/env node
/**
 * youtube-intake MCP server (stdio, Content-Length framing).
 * Zero npm dependencies. Node 18+ fetch.
 * Never logs GEMINI_API_KEY.
 */

import { stdin as input, stdout as output } from "node:process";

const SERVER_NAME = "youtube-intake";
const SERVER_VERSION = "0.2.0";
const PROTOCOL_VERSION = "2024-11-05";

// Same shape as Ai-Library X Bookmarks reports. Body copied word for word from
// akao47/Ai-Library 00-admin/02-bots/bookmarks.md (card v1).
// If that body changes, update this copy too.
const DEFAULT_PROMPT = `Write one report for this video.
Body, in this order:
what the subject is
what it takes to do that subject
whether the claims hold up against official documentation and ordinary software engineering and machine learning practice
Extracted notes only. Never return a full transcript.`;

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent";

const YT_URL_RE =
  /^(https?:\/\/)?(www\.)?(youtube\.com\/watch\?|youtu\.be\/)/i;

/** "ndjson" is what Cursor sends. "content-length" is the local prove framing. */
let framing = null;

function writeMessage(msg) {
  const body = JSON.stringify(msg);
  if (framing === "ndjson") {
    output.write(body);
    output.write("\n");
    return;
  }
  const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
  output.write(header);
  output.write(body);
}

function toolResult(text, isError = false) {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

function isValidYouTubeUrl(url) {
  return typeof url === "string" && url.trim().length > 0 && YT_URL_RE.test(url.trim());
}

const TOOL_DEF = {
  name: "summarize_youtube_video",
  description:
    "Write a report on a public YouTube video in the same shape as Ai-Library X Bookmarks reports. Returns JSON { brief: string }. Never invents content on failure.",
  inputSchema: {
    type: "object",
    properties: {
      video_url: {
        type: "string",
        description: "Public YouTube URL (youtube.com/watch or youtu.be)",
      },
      prompt: {
        type: "string",
        description:
          "Optional custom prompt. If omitted, the server default prompt (same shape as X Bookmarks reports) is used.",
      },
    },
    required: ["video_url"],
  },
};

async function callGemini(videoUrl, prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || typeof apiKey !== "string" || apiKey.trim() === "") {
    return {
      error: "GEMINI_API_KEY is not set. Export it or configure it in the MCP host env.",
    };
  }

  const body = {
    contents: [
      {
        parts: [
          { file_data: { file_uri: videoUrl } },
          { text: prompt },
        ],
      },
    ],
  };

  let res;
  try {
    res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { error: `Gemini fetch failed: ${err?.message || String(err)}` };
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    return {
      error: `Gemini response not JSON (HTTP ${res.status}): ${err?.message || String(err)}`,
    };
  }

  if (!res.ok) {
    const msg =
      data?.error?.message ||
      data?.message ||
      `Gemini HTTP ${res.status}`;
    return { error: String(msg) };
  }

  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    return { error: "Gemini returned no content parts" };
  }

  const brief = parts
    .filter((p) => typeof p?.text === "string")
    .map((p) => p.text)
    .join("")
    .trim();

  if (!brief) {
    return { error: "Gemini returned empty text brief" };
  }

  return { brief };
}

async function handleToolsCall(args) {
  const videoUrl = args?.video_url;
  if (!isValidYouTubeUrl(videoUrl)) {
    return toolResult(
      'Invalid or missing video_url: expected non-empty public youtube.com/watch or youtu.be URL',
      true
    );
  }

  const prompt =
    typeof args?.prompt === "string" && args.prompt.trim() !== ""
      ? args.prompt
      : DEFAULT_PROMPT;

  const result = await callGemini(videoUrl.trim(), prompt);
  if (result.error) {
    return toolResult(result.error, true);
  }

  return toolResult(JSON.stringify({ brief: result.brief }));
}

async function handleRequest(msg) {
  const { id, method, params } = msg;

  if (method === "notifications/initialized" || method?.startsWith("notifications/")) {
    return; // no response for notifications
  }

  if (id === undefined || id === null) {
    return;
  }

  try {
    if (method === "initialize") {
      writeMessage({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          capabilities: { tools: {} },
        },
      });
      return;
    }

    if (method === "tools/list") {
      writeMessage({
        jsonrpc: "2.0",
        id,
        result: { tools: [TOOL_DEF] },
      });
      return;
    }

    if (method === "tools/call") {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name !== "summarize_youtube_video") {
        writeMessage({
          jsonrpc: "2.0",
          id,
          result: toolResult(`Unknown tool: ${name}`, true),
        });
        return;
      }
      const result = await handleToolsCall(args);
      writeMessage({ jsonrpc: "2.0", id, result });
      return;
    }

    if (method === "ping") {
      writeMessage({ jsonrpc: "2.0", id, result: {} });
      return;
    }

    writeMessage({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  } catch (err) {
    writeMessage({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: err?.message || String(err),
      },
    });
  }
}

/** Content-Length framed reader over stdin */
async function main() {
  let buffer = Buffer.alloc(0);

  input.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    processBuffer();
  });

  let inflight = 0;

  input.on("end", () => {
    const wait = () => {
      if (inflight > 0) {
        setTimeout(wait, 50);
        return;
      }
      setTimeout(() => process.exit(0), 20);
    };
    wait();
  });

  function detectFraming() {
    let i = 0;
    while (i < buffer.length && (buffer[i] === 32 || buffer[i] === 9 || buffer[i] === 10 || buffer[i] === 13)) {
      i++;
    }
    if (i >= buffer.length) return;
    framing = buffer[i] === 123 ? "ndjson" : "content-length";
    if (i > 0) buffer = buffer.subarray(i);
  }

  function processNdjson() {
    while (true) {
      const nl = buffer.indexOf(10);
      if (nl < 0) return;
      const line = buffer.subarray(0, nl).toString("utf8").replace(/\r$/, "").trim();
      buffer = buffer.subarray(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      dispatch(msg);
    }
  }

  function processBuffer() {
    if (!framing) detectFraming();
    if (framing === "ndjson") {
      processNdjson();
      return;
    }
    while (true) {
      const headerEnd = findHeaderEnd(buffer);
      if (headerEnd < 0) return;

      const headerText = buffer.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(headerText);
      if (!match) {
        // skip malformed; drop through blank line
        buffer = buffer.subarray(headerEnd + (buffer[headerEnd] === 13 ? 4 : 2));
        continue;
      }
      const length = parseInt(match[1], 10);
      const bodyStart = headerEnd + (buffer[headerEnd] === 13 ? 4 : 2); // \r\n\r\n or \n\n
      if (buffer.length < bodyStart + length) return;

      const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      buffer = buffer.subarray(bodyStart + length);

      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }

      dispatch(msg);
    }
  }

  function dispatch(msg) {
    inflight += 1;
    Promise.resolve(handleRequest(msg))
      .catch((err) => {
        if (msg?.id !== undefined && msg?.id !== null) {
          writeMessage({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32603, message: err?.message || String(err) },
          });
        }
      })
      .finally(() => {
        inflight -= 1;
      });
  }
}

function findHeaderEnd(buf) {
  // look for \r\n\r\n or \n\n
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10) {
      if (i + 3 < buf.length && buf[i + 2] === 13 && buf[i + 3] === 10) {
        return i;
      }
    }
    if (buf[i] === 10 && buf[i + 1] === 10) {
      return i;
    }
  }
  return -1;
}

main();
