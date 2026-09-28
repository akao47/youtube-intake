# youtube-intake

Agent Plugin that writes reports on **public YouTube videos** via Gemini `generateContent` in the same shape as Ai-Library X Bookmarks reports.

**Domain:** `YoutubeIntakeBrief = { brief: string }`

**Tool:** `summarize_youtube_video` — returns MCP text that is JSON `{"brief":"..."}`.

## Report shape

Note: the report body is the same shape as Ai-Library X Bookmarks reports, copied word for word from 00-admin/02-bots/bookmarks.md (card v1). If that body changes, update server.mjs too. Claims are verified later by Ai-Library Homework, not here.

## Files

| Path | Role |
|------|------|
| `plugin.json` | Agent Plugin manifest (no undeclared top-level fields) |
| `mcp.json` | stdio MCP server entry (`node server.mjs`) |
| `server.mjs` | Zero-dep MCP server (Content-Length framing) |
| `skills/summarize-youtube/SKILL.md` | When/how to call the tool |
| `.gitignore` | `.env`, secrets, `node_modules`, etc. |

## Set `GEMINI_API_KEY`

Auth header: `x-goog-api-key` ← `process.env.GEMINI_API_KEY`.

**CLI prove / smoke (export in the shell):**

```bash
export GEMINI_API_KEY='your-key-here'
```

**Cursor IDE:** Agent Plugin schema has **no `variables` field**, so the host must inject env. Options:

1. Export `GEMINI_API_KEY` in the environment that launches Cursor, or
2. Override / extend the MCP server env in Cursor’s MCP / Plugins configure UI so `GEMINI_API_KEY` is set for `youtube-intake`, or
3. For local smoke only, export before running the prove commands below.

Never commit the key. `.gitignore` covers `.env` and `secrets*`.

## Exact prove commands

Syntax check (no network, no key):

```bash
node --check /workspace/youtube-intake/server.mjs
```

Smoke `initialize` + `tools/list` with Content-Length framing (no API key required):

```bash
cd /workspace/youtube-intake
(
  INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"prove","version":"0.0.1"}}}'
  LIST='{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
  printf 'Content-Length: %s\r\n\r\n%s' "${#INIT}" "$INIT"
  printf 'Content-Length: %s\r\n\r\n%s' "${#LIST}" "$LIST"
) | node server.mjs
```

Optional live call (needs key; do **not** run in CI without secrets):

```bash
export GEMINI_API_KEY='your-key-here'
cd /workspace/youtube-intake
# Then Content-Length-frame a tools/call for summarize_youtube_video with a public video_url.
# Documented only — prove smoke above does not require this.
```

## Cursor IDE local path

After prove, install locally (symlink or copy) at:

```text
~/.cursor/plugins/local/youtube-intake
```

Example:

```bash
mkdir -p ~/.cursor/plugins/local
ln -sfn /workspace/youtube-intake ~/.cursor/plugins/local/youtube-intake
```

**Note:** Grok Bot cannot load that Cursor path; local install is for Alex’s Cursor IDE.

## After prove — publish choice

Ask the owner **once**: Marketplace vs [cursor.directory](https://cursor.directory). Default **cursor.directory** unless they work at Google or insist otherwise. **Do not publish** from this scaffold step.

## Model / API (locked)

- `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent`
- Header: `x-goog-api-key`
- Body parts order: `[{ file_data: { file_uri: video_url } }, { text: prompt }]`
