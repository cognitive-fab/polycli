# Phase 0 spikes

The spikes answer the open questions in `../DESIGN.md` §11 before any app code is written.

## 0c: Can Cowork call a polycli desktop extension?

`0c-mcpb/` is a zero-dependency stdio MCP server, packed to `../out/polycli-spike.mcpb`. It exposes two tools:
- `polycli_ping(delay_seconds, note)`
- `polycli_whoami(note)`

Every process start, `initialize` call and tool call is logged to `%APPDATA%\polycli\spike-0c.jsonl`.

To rebuild it: `npx -y @anthropic-ai/mcpb pack spikes/0c-mcpb out/polycli-spike.mcpb`.

The questions it answers:
- Does Cowork see and call the tools?
- Does each Cowork task get its own server process (compare `pid` across tasks)?
- Does `clientInfo` or `params._meta` identify the calling task?
- What is the per-call timeout? Find the largest `delay_seconds` that still returns.

## 0a/0b/0d: Background sessions driven through node-pty

`0ab-bg/run-spike.mjs` launches a real `claude --bg` session (Haiku, "Reply PONG" prompts) with hooks and a statusLine from a `--settings` file. It then:
1. attaches through node-pty and pastes prompts with bracketed paste (single-line and multi-line);
2. presses ← on an empty prompt;
3. kills the client and reattaches;
4. runs `stop` → reattach and `respawn` → reattach, prompting after each;
5. removes the session with `claude rm`.

The results go to `0ab-bg/run/report.json`. The full hook payloads are in `0ab-bg/run/hooks.jsonl`.

Prerequisite: `0ab-bg/run/cwd` must be a trusted folder. Run `claude` there once, accept the trust prompt, then `/exit`.

Run it with: `cd spikes/0ab-bg && npm i && node run-spike.mjs`

xterm.js rendering (resize, mouse, alternate screen) needs a window. That part is deferred to the first Electron shell.

## Results (2026-11-05)

- `node-pty@1.1.0` installs from prebuilt binaries on Node 24 with no compiler. It has not been checked under Electron yet.
- **0a/0b/0d** (full data in `0ab-bg/run/report.json`):
  - `claude --bg` requires a trusted folder, matched by exact path. It ignores `--session-id`, and the bgId is the first 8 hex digits of the sessionId.
  - Attach is ready in about 8 s, and the client enables bracketed-paste mode. Pasted prompts, single-line and multi-line, match `UserPromptSubmit.prompt` exactly.
  - `Stop` carries `last_assistant_message`.
  - Hooks from `--settings` survive stop → attach and respawn.
  - ← on an empty prompt switches to the agent view.
  - statusLine fires only while a client is attached, and it has no effort field. Effort is in the transcript as `perTurnEffort`.
  - Killing a node-pty client prints "AttachConsole failed" from `conpty_console_list_agent`. It is harmless, but it needs handling.
- **0c**:
  - Cowork calls host extension tools, at about 16 ms of overhead per call.
  - One shared server process serves all tasks, and nothing identifies the caller.
  - Today's Cowork tasks run remotely and write no local session files.
  - The relay fails any call that hasn't returned within **60 s**.
  - The `.mcpb` installs by passing it as an argument to the desktop app's `claude.exe`.
