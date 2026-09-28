import { spawn } from "node:child_process";

const init =
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"prove","version":"0.0.1"}}}';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function frameContentLength(body) {
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

function handshake(label, payload) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["server.mjs"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = Buffer.alloc(0);
    const timer = setTimeout(() => {
      child.kill();
      fail(`${label} produced no stdout within 1000ms while stdin stayed open`);
    }, 1000);
    child.stdout.on("data", (chunk) => {
      out = Buffer.concat([out, chunk]);
      if (!out.toString("utf8").includes('"youtube-intake"')) return;
      clearTimeout(timer);
      child.kill();
      resolve(`${label} bytes=${out.length}`);
    });
    child.stdin.write(payload);
  });
}

process.stdout.write(`${await handshake("ndjson", `${init}\n`)}\n`);
process.stdout.write(`${await handshake("content-length", frameContentLength(init))}\n`);
process.exit(0);
