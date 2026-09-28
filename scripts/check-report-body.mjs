import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function extractPrompt(source) {
  const match = source.match(/const DEFAULT_PROMPT = `([\s\S]*?)`;/);
  if (!match) fail("DEFAULT_PROMPT template not found in server.mjs");
  return match[1];
}

function extractCardBody(markdown) {
  const marker = "Body, in this order:\n";
  const start = markdown.indexOf(marker);
  if (start < 0) fail("bookmarks.md has no card v1 body");
  const rest = markdown.slice(start);
  const end = rest.indexOf("\n\n");
  if (end < 0) fail("bookmarks.md card v1 body has no end");
  return rest.slice(0, end);
}

const prompt = extractPrompt(readFileSync(join(root, "server.mjs"), "utf8"));
const fixture = readFileSync(join(root, "fixtures", "bookmarks-card-v1.body.txt"), "utf8").trimEnd();
const livePath =
  process.env.BOOKMARKS_MD ||
  join(process.env.HOME || "", "Documents/Ai-Library/00-admin/02-bots/bookmarks.md");

let expected = fixture;
if (existsSync(livePath)) {
  const live = extractCardBody(readFileSync(livePath, "utf8"));
  if (live !== fixture) {
    fail(`fixtures/bookmarks-card-v1.body.txt does not match ${livePath}`);
  }
  expected = live;
}

if (!prompt.includes(expected)) {
  fail("DEFAULT_PROMPT does not contain the bookmarks card v1 body");
}

process.stdout.write("report body matches bookmarks card v1\n");
