import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const server = join(root, "server.mjs");
const mock = pathToFileURL(join(root, "scripts", "mock-gemini-fetch.mjs")).href;
const video = "https://youtu.be/9hE5-98ZeCg";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function spawnServer(env, logPath) {
  const child = spawn(process.execPath, ["--import", mock, server], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      GEMINI_API_KEY: "dummy-not-a-secret",
      MOCK_GEMINI_LOG: logPath,
      ...env,
    },
  });
  let stdout = "";
  const messages = [];
  let rest = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
    rest += chunk.toString("utf8");
    while (true) {
      const nl = rest.indexOf("\n");
      if (nl < 0) break;
      const line = rest.slice(0, nl).trim();
      rest = rest.slice(nl + 1);
      if (!line) continue;
      messages.push(JSON.parse(line));
    }
  });
  child.stdoutText = () => stdout;
  child.messages = messages;
  return child;
}

function send(child, msg) {
  child.stdin.write(`${JSON.stringify(msg)}\n`);
}

function waitForId(child, id, ms) {
  const started = Date.now();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.stdout.off("data", tick);
      resolve({ msg: null, elapsed: Date.now() - started });
    }, ms);
    function tick() {
      const msg = child.messages.find((item) => item.id === id);
      if (!msg) return;
      clearTimeout(timer);
      child.stdout.off("data", tick);
      resolve({ msg, elapsed: Date.now() - started });
    }
    child.stdout.on("data", tick);
    tick();
  });
}

async function initialize(child) {
  send(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "check-tool-budget", version: "0" },
    },
  });
  const init = await waitForId(child, 1, 1000);
  if (!init.msg) fail(`initialize did not answer\n${child.stdoutText()}`);
}

function toolText(msg) {
  return msg?.result?.content?.[0]?.text ?? "";
}

function assertNoSecret(child) {
  if (child.stdoutText().includes("dummy-not-a-secret")) {
    fail("stdout contains the dummy API key");
  }
}

const dir = mkdtempSync(join(tmpdir(), "yt-budget-"));

try {
  {
    const logPath = join(dir, "slow.log");
    const child = spawnServer(
      {
        MOCK_GEMINI_DELAY_MS: "5000",
        MOCK_GEMINI_TEXT: "slow brief",
        YOUTUBE_INTAKE_TOOL_BUDGET_MS: "200",
        YOUTUBE_INTAKE_GEMINI_DEADLINE_MS: "20000",
      },
      logPath
    );
    await initialize(child);
    const started = Date.now();
    send(child, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "summarize_youtube_video",
        arguments: { video_url: video },
      },
    });
    const first = await waitForId(child, 3, 2000);
    if (!first.msg) {
      fail(
        `slow summarize did not answer within 2000ms elapsed=${Date.now() - started}\n${child.stdoutText()}`
      );
    }
    const pendingText = toolText(first.msg);
    const pending = JSON.parse(pendingText);
    if (pending.status !== "pending" || pending.poll !== "get_youtube_summary" || pending.brief) {
      fail(`slow summarize returned ${pendingText} in ${first.elapsed}ms`);
    }
    if (!pending.job_id || pendingText.includes("slow brief")) {
      fail(`slow summarize leaked or missed job_id: ${pendingText}`);
    }
    if (first.msg.result.isError === true) fail(`pending marked isError: ${pendingText}`);
    process.stdout.write(`slow summarize pending in ${first.elapsed}ms\n`);

    let briefText = "";
    for (let id = 4; id < 40; id += 1) {
      send(child, {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: "get_youtube_summary",
          arguments: { job_id: pending.job_id },
        },
      });
      const polled = await waitForId(child, id, 2000);
      if (!polled.msg) fail(`poll ${id} did not answer\n${child.stdoutText()}`);
      const text = toolText(polled.msg);
      if (text === '{"brief":"slow brief"}') {
        briefText = text;
        break;
      }
    }
    if (briefText !== '{"brief":"slow brief"}') {
      fail(`poll did not return the brief\n${child.stdoutText()}`);
    }
    const calls = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
    if (calls.length !== 1) fail(`expected 1 Gemini call, saw ${calls.length}: ${calls.join(" | ")}`);
    assertNoSecret(child);
    child.kill("SIGKILL");
    process.stdout.write("slow summarize polled to brief\n");
  }

  {
    const logPath = join(dir, "fast.log");
    const child = spawnServer(
      {
        MOCK_GEMINI_DELAY_MS: "20",
        MOCK_GEMINI_TEXT: "fast brief",
        YOUTUBE_INTAKE_TOOL_BUDGET_MS: "2000",
      },
      logPath
    );
    await initialize(child);
    send(child, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const listed = await waitForId(child, 2, 1000);
    const names = listed.msg?.result?.tools?.map((tool) => tool.name) ?? [];
    if (!names.includes("summarize_youtube_video") || !names.includes("get_youtube_summary")) {
      fail(`tools/list missing poll tool: ${JSON.stringify(names)}`);
    }
    send(child, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "summarize_youtube_video",
        arguments: { video_url: video },
      },
    });
    const done = await waitForId(child, 3, 2000);
    if (toolText(done.msg) !== '{"brief":"fast brief"}') {
      fail(`fast summarize returned ${toolText(done.msg)}`);
    }
    if (done.msg.result.isError === true) fail("fast summarize isError");
    assertNoSecret(child);
    child.kill("SIGKILL");
    process.stdout.write("fast summarize returned brief\n");
  }

  {
    const logPath = join(dir, "http.log");
    const child = spawnServer(
      {
        MOCK_GEMINI_MODE: "http-error",
        MOCK_GEMINI_DELAY_MS: "0",
        YOUTUBE_INTAKE_TOOL_BUDGET_MS: "1000",
      },
      logPath
    );
    await initialize(child);
    send(child, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "summarize_youtube_video",
        arguments: { video_url: "https://www.youtube.com/watch?v=9hE5-98ZeCg" },
      },
    });
    const failed = await waitForId(child, 3, 1000);
    if (toolText(failed.msg) !== "video is private" || failed.msg.result.isError !== true) {
      fail(`http error returned ${JSON.stringify(failed.msg?.result)}`);
    }
    if (toolText(failed.msg).includes("brief")) fail("http error invented a brief");
    child.kill("SIGKILL");
    process.stdout.write("http error surfaced\n");
  }

  {
    const logPath = join(dir, "empty.log");
    const child = spawnServer(
      {
        MOCK_GEMINI_MODE: "empty",
        YOUTUBE_INTAKE_TOOL_BUDGET_MS: "1000",
      },
      logPath
    );
    await initialize(child);
    send(child, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "summarize_youtube_video",
        arguments: { video_url: video },
      },
    });
    const empty = await waitForId(child, 3, 1000);
    if (toolText(empty.msg) !== "Gemini returned empty text brief" || empty.msg.result.isError !== true) {
      fail(`empty Gemini returned ${JSON.stringify(empty.msg?.result)}`);
    }
    child.kill("SIGKILL");
    process.stdout.write("empty Gemini surfaced\n");
  }

  {
    const logPath = join(dir, "garbage.log");
    const child = spawnServer(
      {
        MOCK_GEMINI_MODE: "garbage",
        YOUTUBE_INTAKE_TOOL_BUDGET_MS: "1000",
      },
      logPath
    );
    await initialize(child);
    send(child, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "summarize_youtube_video",
        arguments: { video_url: video },
      },
    });
    const garbage = await waitForId(child, 3, 1000);
    if (
      toolText(garbage.msg) !== "Gemini response not JSON (HTTP 200)" ||
      garbage.msg.result.isError !== true
    ) {
      fail(`garbage Gemini returned ${JSON.stringify(garbage.msg?.result)}`);
    }
    child.kill("SIGKILL");
    process.stdout.write("garbage Gemini surfaced\n");
  }

  {
    const logPath = join(dir, "hang.log");
    const child = spawnServer(
      {
        MOCK_GEMINI_MODE: "hang",
        MOCK_GEMINI_DELAY_MS: "0",
        MOCK_GEMINI_TEXT: "should not appear",
        YOUTUBE_INTAKE_TOOL_BUDGET_MS: "100",
        YOUTUBE_INTAKE_GEMINI_DEADLINE_MS: "300",
      },
      logPath
    );
    await initialize(child);
    send(child, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "summarize_youtube_video",
        arguments: { video_url: video },
      },
    });
    const pendingMsg = await waitForId(child, 3, 1000);
    const pending = JSON.parse(toolText(pendingMsg.msg));
    if (pending.status !== "pending") fail(`hang did not go pending: ${toolText(pendingMsg.msg)}`);
    let errorText = "";
    for (let id = 4; id < 30; id += 1) {
      send(child, {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: "get_youtube_summary",
          arguments: { job_id: pending.job_id },
        },
      });
      const polled = await waitForId(child, id, 1000);
      const text = toolText(polled.msg);
      if (polled.msg?.result?.isError === true) {
        errorText = text;
        break;
      }
    }
    if (errorText !== "Gemini timed out after 300ms. No brief was produced.") {
      fail(`hang poll returned ${JSON.stringify(errorText)}\n${child.stdoutText()}`);
    }
    if (child.stdoutText().includes("should not appear")) fail("hang invented brief text");
    child.kill("SIGKILL");
    process.stdout.write("hang timed out without a brief\n");
  }

  {
    const logPath = join(dir, "bad-url.log");
    const child = spawnServer({ YOUTUBE_INTAKE_TOOL_BUDGET_MS: "500" }, logPath);
    await initialize(child);
    send(child, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "summarize_youtube_video",
        arguments: { video_url: "https://example.com/watch?v=1" },
      },
    });
    const bad = await waitForId(child, 3, 1000);
    if (
      toolText(bad.msg) !==
        "Invalid or missing video_url: expected non-empty public youtube.com/watch or youtu.be URL" ||
      bad.msg.result.isError !== true
    ) {
      fail(`bad url returned ${JSON.stringify(bad.msg?.result)}`);
    }
    send(child, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "get_youtube_summary", arguments: {} },
    });
    const missing = await waitForId(child, 4, 1000);
    if (toolText(missing.msg) !== "Missing job_id. No report was produced." || missing.msg.result.isError !== true) {
      fail(`missing job_id returned ${JSON.stringify(missing.msg?.result)}`);
    }
    send(child, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "get_youtube_summary", arguments: { job_id: "missing" } },
    });
    const unknown = await waitForId(child, 5, 1000);
    if (toolText(unknown.msg) !== "Unknown job_id. No report was produced." || unknown.msg.result.isError !== true) {
      fail(`unknown job_id returned ${JSON.stringify(unknown.msg?.result)}`);
    }
    let calls = "";
    try {
      calls = readFileSync(logPath, "utf8");
    } catch {
      calls = "";
    }
    if (calls.trim() !== "") fail(`bad url called Gemini: ${calls}`);
    child.kill("SIGKILL");
    process.stdout.write("bad url and unknown job surfaced\n");
  }

  {
    const logPath = join(dir, "nokey.log");
    const child = spawnServer(
      { GEMINI_API_KEY: "", YOUTUBE_INTAKE_TOOL_BUDGET_MS: "500" },
      logPath
    );
    await initialize(child);
    send(child, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "summarize_youtube_video",
        arguments: { video_url: video },
      },
    });
    const missingKey = await waitForId(child, 3, 1000);
    if (
      toolText(missingKey.msg) !==
        "GEMINI_API_KEY is not set. Export it or configure it in the MCP host env." ||
      missingKey.msg.result.isError !== true
    ) {
      fail(`missing key returned ${JSON.stringify(missingKey.msg?.result)}`);
    }
    let calls = "";
    try {
      calls = readFileSync(logPath, "utf8");
    } catch {
      calls = "";
    }
    if (calls.trim() !== "") fail("missing key called Gemini");
    child.kill("SIGKILL");
    process.stdout.write("missing key surfaced\n");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write("tool budget ok\n");
