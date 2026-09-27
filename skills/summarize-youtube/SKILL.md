---
name: summarize-youtube
description: Use when Alex or the YouTube intake bot needs a library brief from a public YouTube URL for Stage 6 / 01-inbox/youtube. Calls summarize_youtube_video; never invent video content.
---

# Summarize YouTube (intake brief)

## When to use

Use this skill when Alex (or an intake bot) needs a **library-report brief** from a **public YouTube URL** for Stage 6 intake under `01-inbox/youtube`.

Do **not** invent video content. Always call the MCP tool.

## How to call

1. Call tool `summarize_youtube_video` with:
   - `video_url` (required): public `youtube.com/watch` or `youtu.be` URL
   - `prompt` (optional): omit to use the server default SE/ML intake brief prompt
2. The tool returns MCP text that is JSON: `{"brief":"..."}`.
3. Paste the brief into `01-inbox/youtube/<subject>.md` — **the caller writes files**; this plugin does not write to Ai-Library.

## Constraints

- Public YouTube URLs only.
- Extracted notes / brief prose only — never a full transcript.
- No Ai-Library filesystem writes from the MCP server.
- Never invent a brief on API failure; surface the tool error instead.
