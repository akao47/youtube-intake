import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const server = join(root, "server.mjs");

const initMsg = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "check-handshake", version: "0" },
  },
};
const listMsg = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };

function ndjson(msg) {
  return JSON.stringify(msg) + "\n";
}

function contentLength(msg) {
  const body = JSON.stringify(msg);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function spawnNode(args) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GEMINI_API_KEY: "handshake-check" },
  });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  child.stdout.on("data", (chunk) => {
    stdout = Buffer.concat([stdout, chunk]);
  });
  child.stderr.on("data", (chunk) => {
    stderr = Buffer.concat([stderr, chunk]);
  });
  child.collected = () => ({
    stdout: stdout.toString("utf8"),
    stderr: stderr.toString("utf8"),
  });
  return child;
}

function waitExit(child, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out after ${ms}ms\n${child.collected().stdout}\n${child.collected().stderr}`));
    }, ms);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, ...child.collected() });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function assertInitialize(text, label) {
  if (
    !text.includes('"id":1') ||
    !text.includes('"protocolVersion":"2024-11-05"') ||
    !text.includes('"name":"youtube-intake"')
  ) {
    fail(`${label} did not answer initialize: ${JSON.stringify(text)}`);
  }
  if (text.includes("handshake-check")) fail(`${label} wrote the env value`);
}

{
  const child = spawnNode([server]);
  const pending = waitExit(child, 2000);
  child.stdin.end(ndjson(initMsg));
  const result = await pending;
  if (result.code !== 0) fail(`ndjson close exit ${result.code}`);
  assertInitialize(result.stdout, "ndjson close");
  if (!result.stdout.trimEnd().endsWith("}")) fail("ndjson close stdout is not a JSON line");
  process.stdout.write("ndjson close ok\n");
}

{
  const child = spawnNode([server]);
  const pending = waitExit(child, 2000);
  child.stdin.end(contentLength(initMsg));
  const result = await pending;
  if (result.code !== 0) fail(`content-length close exit ${result.code}`);
  if (!result.stdout.startsWith("Content-Length:")) {
    fail(`content-length close missing header: ${JSON.stringify(result.stdout)}`);
  }
  assertInitialize(result.stdout, "content-length close");
  process.stdout.write("content-length close ok\n");
}

{
  const child = spawnNode([server]);
  const pending = waitExit(child, 3000);
  child.stdin.write(ndjson(initMsg));
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (child.exitCode != null) fail("server exited while stdin stayed open");
  assertInitialize(child.collected().stdout, "ndjson held");
  child.stdin.write(ndjson(listMsg));
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (child.exitCode != null) fail("server exited before stdin closed");
  if (!child.collected().stdout.includes('"name":"summarize_youtube_video"')) {
    fail(`tools/list missing while stdin stayed open: ${JSON.stringify(child.collected().stdout)}`);
  }
  child.stdin.end();
  const result = await pending;
  if (result.code !== 0) fail(`ndjson held exit ${result.code}`);
  process.stdout.write("ndjson held ok\n");
}

{
  const dir = mkdtempSync(join(tmpdir(), "yt-handshake-"));
  const launcher = join(dir, "launch.mjs");
  writeFileSync(
    launcher,
    `import { stdin } from "node:process";\nstdin.pause();\nawait new Promise((r) => setTimeout(r, 40));\nawait import(${JSON.stringify(pathToFileURL(server).href)});\n`
  );
  try {
    const child = spawnNode([launcher]);
    const pending = waitExit(child, 2000);
    child.stdin.end(ndjson(initMsg));
    const result = await pending;
    if (result.code !== 0) {
      fail(`paused import exit ${result.code} stderr ${JSON.stringify(result.stderr)}`);
    }
    assertInitialize(result.stdout, "paused import");
    process.stdout.write("paused import ok\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

process.stdout.write("handshake ok\n");
