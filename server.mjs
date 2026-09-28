#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { stdin as input, stdout as output } from "node:process";

const SERVER_NAME = "youtube-intake";
const SERVER_VERSION = "0.2.0";
const PROTOCOL_VERSION = "2024-11-05";

const DEFAULT_PROMPT = `Write one report for this video.
Body, in this order:
what the subject is
what it takes to do that subject
whether the claims hold up against official documentation
and ordinary software engineering and machine learning practice
Extracted notes only. Never return a full transcript.`;

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse";

function readMillis(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

const TOOL_BUDGET_MS = readMillis("YOUTUBE_INTAKE_TOOL_BUDGET_MS", 45_000, 50, 50_000);
const GEMINI_DEADLINE_MS = readMillis("YOUTUBE_INTAKE_GEMINI_DEADLINE_MS", 480_000, 50, 600_000);

const jobs = new Map();
const latestByKey = new Map();

const YT_URL_RE =
  /^(https?:\/\/)?(www\.)?(youtube\.com\/watch\?|youtu\.be\/)/i;

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

const SUMMARIZE_TOOL = {
  name: "summarize_youtube_video",
  description:
    'Write a report on a public YouTube video in the same shape as Ai-Library X Bookmarks reports. Returns JSON {"brief":string} when Gemini finishes inside the host budget. If Gemini is still running, returns JSON {"status":"pending","job_id":string,"poll":"get_youtube_summary"} with no brief. Call get_youtube_summary with that job_id until brief or an error. A pending result is not a report. Never invents content.',
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

const POLL_TOOL = {
  name: "get_youtube_summary",
  description:
    'Poll a YouTube report started by summarize_youtube_video. Pass job_id. Returns JSON {"brief":string} when ready, the same pending JSON when Gemini is still running, or an error. Never invents a brief.',
  inputSchema: {
    type: "object",
    properties: {
      job_id: {
        type: "string",
        description: "job_id from a pending summarize_youtube_video result",
      },
    },
    required: ["job_id"],
  },
};

const TOOLS = [SUMMARIZE_TOOL, POLL_TOOL];

function textsFromPayload(data) {
  const chunks = Array.isArray(data) ? data : [data];
  let out = "";
  for (const chunk of chunks) {
    const parts = chunk?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (typeof part?.text === "string") out += part.text;
    }
  }
  return out;
}

function extractBrief(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith("data:") || trimmed.includes("\ndata:")) {
    let out = "";
    for (const line of raw.split("\n")) {
      const row = line.trim();
      if (!row.startsWith("data:")) continue;
      const payload = row.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        out += textsFromPayload(JSON.parse(payload));
      } catch {
        continue;
      }
    }
    return out.trim();
  }
  let data;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return textsFromPayload(data).trim();
}

function errorFromBody(raw, status) {
  try {
    const data = JSON.parse(raw);
    const msg = data?.error?.message || data?.message;
    if (msg) return String(msg);
  } catch {
    return `Gemini HTTP ${status}`;
  }
  return `Gemini HTTP ${status}`;
}

function jobToToolResult(job) {
  if (job.status === "done") {
    return toolResult(JSON.stringify({ brief: job.brief }));
  }
  if (job.status === "error") {
    return toolResult(job.error, true);
  }
  return toolResult(
    JSON.stringify({
      status: "pending",
      job_id: job.id,
      poll: "get_youtube_summary",
    })
  );
}

function waitForJob(job, ms) {
  if (job.status !== "running") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    job.done.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function apiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key || typeof key !== "string" || key.trim() === "") return "";
  return key;
}

async function executeJob(job, videoUrl, prompt) {
  const deadline = AbortSignal.timeout(GEMINI_DEADLINE_MS);
  try {
    const res = await fetch(GEMINI_URL, {
      method: "POST",
      signal: deadline,
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey(),
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ file_data: { file_uri: videoUrl } }, { text: prompt }],
          },
        ],
      }),
    });
    const raw = await res.text();
    if (!res.ok) {
      job.status = "error";
      job.error = errorFromBody(raw, res.status);
      return;
    }
    const brief = extractBrief(raw);
    if (brief == null) {
      job.status = "error";
      job.error = `Gemini response not JSON (HTTP ${res.status})`;
      return;
    }
    if (!brief) {
      job.status = "error";
      job.error = "Gemini returned empty text brief";
      return;
    }
    job.brief = brief;
    job.status = "done";
  } catch (err) {
    job.status = "error";
    job.error = deadline.aborted
      ? `Gemini timed out after ${GEMINI_DEADLINE_MS}ms. No brief was produced.`
      : `Gemini fetch failed: ${err?.message || String(err)}`;
  } finally {
    job.finish();
  }
}

function beginJob(videoUrl, prompt) {
  const key = `${videoUrl}\n${prompt}`;
  const existing = jobs.get(latestByKey.get(key));
  if (existing && existing.status !== "error") return existing;
  const id = randomUUID();
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  const job = { id, status: "running", brief: "", error: "", done, finish };
  jobs.set(id, job);
  latestByKey.set(key, id);
  void executeJob(job, videoUrl, prompt);
  return job;
}

async function handleSummarize(args) {
  const videoUrl = typeof args?.video_url === "string" ? args.video_url.trim() : "";
  if (!isValidYouTubeUrl(videoUrl)) {
    return toolResult(
      "Invalid or missing video_url: expected non-empty public youtube.com/watch or youtu.be URL",
      true
    );
  }
  if (!apiKey()) {
    return toolResult(
      "GEMINI_API_KEY is not set. Export it or configure it in the MCP host env.",
      true
    );
  }
  const prompt =
    typeof args?.prompt === "string" && args.prompt.trim() !== ""
      ? args.prompt
      : DEFAULT_PROMPT;
  const job = beginJob(videoUrl, prompt);
  await waitForJob(job, TOOL_BUDGET_MS);
  return jobToToolResult(job);
}

async function handleGetSummary(args) {
  const jobId = typeof args?.job_id === "string" ? args.job_id.trim() : "";
  if (!jobId) {
    return toolResult("Missing job_id. No report was produced.", true);
  }
  const job = jobs.get(jobId);
  if (!job) {
    return toolResult("Unknown job_id. No report was produced.", true);
  }
  await waitForJob(job, TOOL_BUDGET_MS);
  return jobToToolResult(job);
}

async function handleRequest(msg) {
  const { id, method, params } = msg;

  if (method === "notifications/initialized" || method?.startsWith("notifications/")) {
    return;
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
        result: { tools: TOOLS },
      });
      return;
    }

    if (method === "tools/call") {
      const name = params?.name;
      const args = params?.arguments ?? {};
      const result =
        name === "summarize_youtube_video"
          ? await handleSummarize(args)
          : name === "get_youtube_summary"
            ? await handleGetSummary(args)
            : toolResult(`Unknown tool: ${name}`, true);
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

  // pause() sticks. A data listener does not resume an explicit pause.
  input.resume();

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
        buffer = buffer.subarray(headerEnd + (buffer[headerEnd] === 13 ? 4 : 2));
        continue;
      }
      const length = parseInt(match[1], 10);
      const bodyStart = headerEnd + (buffer[headerEnd] === 13 ? 4 : 2);
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
