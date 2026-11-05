# polycli app (Phase 1)

A Windows terminal for Claude Code workstreams. The design is in [`../DESIGN.md`](../DESIGN.md).

## Run

```
cd app
npm install
npm start
```

This needs Windows, Node 18 or newer on PATH (the hook helpers run with `node`), and `claude` on PATH.

## What Phase 1 does

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
- **Environment variables per workstream.** ⚙ Settings in the rail: name/value pairs given to every Claude session (through its settings file) and every new shell in that workstream. Values are stored encrypted and never shown again; running sessions pick up a change on Restart, and the pane says so.
- **Keys.** The Keys button in the top bar lists the key-like variables saved in Windows (names only) with the workstreams that use them. Which keys a workstream uses is set in its ⚙ Settings.
- **Shells.** `pwsh` tabs in the workstream folder. They end when polycli exits and are restarted when it starts again.
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

## Tests

- `npm run smoke` drives the real app end to end: new session → prompt → close → reopen → restart → prompt → shell → delete. It uses Haiku in `spikes/0ab-bg/run/cwd` with an isolated home, and writes `out/smoke.json` and screenshots.
- `node scripts/smoke.js needs` runs a session in default permission mode and asks it to run a command. It checks the permission prompt → needs-you → inbox path, then declines with Esc.
- `npm run persist` hard-kills polycli's main process while a session runs. It checks that the session survived, starts polycli again, and checks that the session is reattached and still answers.
