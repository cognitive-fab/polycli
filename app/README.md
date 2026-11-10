# polycli app

A Windows terminal for Claude Code workstreams. The design is in [`../DESIGN.md`](../DESIGN.md).

## Run

```
cd app
npm install
npm start
```

This needs Windows, Node 18 or newer on PATH (the hook helpers run with `node`), and `claude` on PATH.

## What it does

- **Workstreams.** A name, a color and a main folder. They are listed in the left rail.
- **Claude sessions.** Each one is a `claude --bg` background session named "‹workstream› · ‹role›" and shown through `claude attach` in a tab. You can pick the model and effort.
  - **Close** stops the session; the conversation is kept and the session moves to *Closed*.
  - **Reopen** attaches again.
  - **Restart** runs `claude respawn`: same conversation, current Claude Code version.
  - **Delete** runs `claude rm`.
- **Header.** `Claude Code v… / ‹model› with ‹effort› effort · Claude ‹plan› / ‹folder› ⎇ ‹branch›`. Version and model come from a per-session statusLine, effort from the transcript, and the plan from `~/.claude.json`.
- **VS Code.** Click the folder in the header, or the VS Code button. Shift-click opens the git root, and Ctrl-click opens a new window. `Code.exe` is started directly, with no shell.
- **Session id.** The id after the folder in the header (e.g. `⧉ 7b663657`) copies `claude attach 7b663657`. Run it in any terminal to continue there; that terminal takes the session over (one attach at a time), and the pane offers **Take back**.
- **Copy and paste.** Drag selects (polycli keeps Claude's mouse reporting off so the selection is local; the wheel still scrolls Claude). Ctrl+C copies when there is a selection and otherwise goes to Claude as usual; Ctrl+Shift+C always copies. Ctrl+V and Ctrl+Shift+V paste once. A program can also set the clipboard with OSC 52.
- **Git line.** Under the folder in each session header: branch, ahead/behind or "not published", changed files, the GitHub repo and the branch's PR with its checks. **Commit** (your message, or ask Claude to write it), **Push** / **Publish**, and **Deploy** (the workstream's deploy command, or a `package.json` `deploy` script) appear when they apply. Commit and Push wait while Claude is working; Deploy runs in a new shell tab after a confirmation.
- **Cowork bridge.** The `polycli bridge` extension (in `../bridge`, packed by `npm run bridge:pack`, installed from the workstream's **Cowork** panel) lets Cowork tasks link to a workstream, send prompts to its sessions and read the answers, open sessions, and report artifacts. Links and prompts are approved in the bar at the bottom of the window unless the workstream's policy allows them. A session sends a message back with `node "$POLYCLI_POST" "…"`; the task reads it with `polycli_inbox`. See the help.
- **Light mode.** The top-bar button cycles System / Light / Dark.
- **Environment variables per workstream.** ⚙ Settings in the rail: name/value pairs given to every Claude session (through its settings file) and every new shell in that workstream. Values are stored encrypted and never shown again; running sessions pick up a change on Restart, and the pane says so.
- **Keys.** The Keys button in the top bar lists the key-like variables saved in Windows (names only) with the workstreams that use them. Which keys a workstream uses is set in its ⚙ Settings.
- **Shells.** PowerShell in the workstream folder, a WSL distribution (`wsl.exe -d`), or SSH (`ssh -t [-i key] [-p port] user@host`, hosts from `~/.ssh/config` suggested, a pasted ssh command understood). They end when polycli exits and are restarted when it starts again.
- **Pinned shells.** A command run in the shell whenever polycli starts (and on ▶ Run), optionally after another shell is ready: a text in its output, a port that answers, or its command finished (a hidden OSC 633 marker reports the end).
- **Views.** Main / Board / Architecture / Docs / Tests per workstream. The Board's card chats run `claude -p` in the workstream folder (Read/Write/Edit/Glob/Grep/WebSearch/WebFetch, no shell); cards are in `.polycli/`, card documents in `docs/cards/`. Tests runs `npm run` for test/check scripts and parses node:test, TAP and Jest summaries.
- **Panes.** One, two or four panes, each with a workstream and its tabs. A bar at the bottom lists sessions that need you or ask a question (✋, from the `AskUserQuestion` hooks) and Cowork requests.
- **Remote Control.** New sessions start with `--remote-control <name>` unless turned off in the New session dialog (always off with an API key, a gateway or a cloud provider).
- **Selections in Claude panes** grow past the edge: polycli scrolls Claude's transcript one wheel step at a time and collects the lines.
- **Time and tokens.** Weekly Claude time and output tokens per workstream (from the transcripts, reset Monday 07:00), and your own time on billable workstreams with monthly history.
- **Survives polycli exiting.** Claude sessions are background sessions. When polycli starts, it reattaches every session that was open.
- **Needs-you inbox.** Claude's `Notification` hook (`notification_type: permission_prompt` and similar) marks a session "Needs you" and counts it in the top bar. If polycli isn't in focus, its taskbar button flashes.
  - Windows toasts need the app to be installed with a Start menu shortcut.
  - In a dev run (`npm start`), Windows refuses them: "Settings prevent the notification type from being delivered".
- **Folder trust.** If Claude Code hasn't trusted the folder yet, the tab runs plain `claude`, so you answer its trust prompt yourself. After `/exit`, polycli starts the session.

polycli writes only to `%APPDATA%\polycli`: state (workstream variable values encrypted), hook helpers, and per-session settings files (which carry the workstream's variables in plain text, because Claude reads them from there). Your `~/.claude/settings.json` is never changed. Each session gets its hooks and statusLine from its own `--settings` file.

## Not yet (later phases)

- Splits and saved layouts. Tabs only for now.
- The command palette and the global hotkey.
- The Cowork bridge and the artifacts panel.
- WSL.

## Help

[`resources/help/HELP.md`](resources/help/HELP.md) is the user guide; the app shows it under **? Help**. Its screenshots are made by `node scripts/smoke.js help` (demo workstreams, a demo key list).

## Tests

- `npm run smoke` drives the real app end to end: new session → prompt → close → reopen → restart → prompt → shell → delete. It uses Haiku in `spikes/0ab-bg/run/cwd` with an isolated home, and writes `out/smoke.json` and screenshots.
- `node scripts/smoke.js needs` runs a session in default permission mode and asks it to run a command. It checks the permission prompt → needs-you → inbox path, then declines with Esc.
- `node scripts/smoke.js bridge` runs the real extension process against the app with a Haiku session: link, approve, a short prompt (PONG), a long multi-line prompt (LONGPONG), an artifact.
- `npm run persist` hard-kills polycli's main process while a session runs. It checks that the session survived, starts polycli again, and checks that the session is reattached and still answers.
