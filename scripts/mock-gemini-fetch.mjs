import { appendFileSync } from "node:fs";

const logPath = process.env.MOCK_GEMINI_LOG;

function logCall(url) {
  if (!logPath) return;
  appendFileSync(logPath, `${String(url)}\n`);
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    const onAbort = () => {
      clearTimeout(timer);
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      reject(err);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

globalThis.fetch = async (url, opts) => {
  logCall(url);
  const delay = Number(process.env.MOCK_GEMINI_DELAY_MS || "0");
  const mode = process.env.MOCK_GEMINI_MODE || "ok";
  await wait(delay, opts?.signal);
  if (mode === "hang") {
    await wait(86_400_000, opts?.signal);
  }
  if (mode === "http-error") {
    return new Response(JSON.stringify({ error: { message: "video is private" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  if (mode === "empty") {
    return new Response('data: {"candidates":[{"content":{"parts":[{}]}}]}\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }
  const text = process.env.MOCK_GEMINI_TEXT || "measured brief";
  const payload = JSON.stringify({
    candidates: [{ content: { parts: [{ text }] } }],
  });
  return new Response(`data: ${payload}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
};
