# Changelog

## Unreleased
- **Browse plugins**: ⚙ Settings → Plugins and skills → **Browse plugins…** searches the official plugin directory (and the marketplaces you added) and installs a plugin, by default for this workstream only (off in Claude, On here).
- **Repeated messages in a Claude pane fixed**: after switching away from a workstream and back, a long-running session's pane could draw Claude's screen into the scrollback over and over (the same lines repeated, leftovers after a resize), and the wheel scrolled those copies instead of Claude's transcript. The pane is rebuilt from the last 256 KB of output, which no longer held Claude's switch to its full-screen mode; polycli now keeps those modes and replays them first.

## 0.4.0 — 2026-11-26
- **Plugins and skills per workstream**: ⚙ Settings → Plugins and skills switches plugins on or off for a workstream (with the tokens each adds to every request) and sets each of your own and the project's skills to on, name only, only when typed, or off; copy one of your skills into the project.
- **MCP servers and permission profiles per workstream**: ⚙ Settings → MCP and permissions switches MCP servers off, picks a permission profile (Standard, No publishing, Careful, Live systems; editable in ⚙ → Edit profiles…) and adds the workstream's own deny, ask and allow rules and permission mode. The project's saved "always allow" rules are listed, and those holding a password or key, or allowing a whole tool, can be removed.
- **Context meter and hand-off**: each session header shows how full the context is, and the top bar your plan's 5-hour and weekly usage. Near full: **Compact**, or **Hand off** to a new session from a note Claude writes and you can edit.
- **polywatch in polycli**: confirmed findings with no outcome show as badges on sessions and workstreams, with **Real** / **False alarm**; and a **code-review light** per session asks for a `/code-review` only where polywatch can't cover the code (gaps in its checks, interactions across turns or parallel sessions, open defects, fragile areas), red only at push time, learning per project from what reviews find.
- **Worktrees view**: every worktree of the repository, merged (in git or by its GitHub PR), changed or in use, with **Remove** and **Clean up merged**; a branch is deleted only when its work is merged.
- **Command palette**: Ctrl+K / Ctrl+Shift+P to jump anywhere or run a command, `?` to search prompts, artifacts and cards; global hotkey Win+Alt+C.
- **Auto-update** from GitHub Releases (Restart now, or Update when I quit), built by a GitHub Actions workflow on a version tag; and **Export / Import** of settings to set up another PC.
- Workstream settings are now in tabs (General, Environment, Plugins and skills, MCP and permissions). A changed setting shows a notice above each session, with **Restart all**; a session Claude is working in restarts when it is done.
- Artifacts: a Markdown artifact's images next to it now load; a transcript line still being written is no longer skipped for good; overlapping list loads can't show an older list.
- **Artifacts view**: per workstream, the claude.ai artifacts its sessions published, the documents they wrote and what its Cowork tasks reported, in one list that updates as they report. Click one to open it inside polycli: web pages in a built-in viewer (sign in to claude.ai there once), local HTML, images and Markdown beside the list.
- **Windows installer**: `npm run dist` builds `polycli-Setup-‹version›.exe` (for you only by default, no administrator rights; Start menu and desktop shortcuts, updates in place, keeps your data on uninstall) and a zip to run without installing. A check after each build confirms the icon, the version and that the packaged app runs (window, hooks, help, bridge extension, a shell).
- **polycli has its own icon** (window, taskbar, installer, shortcuts).
- At startup, polycli says if **Claude Code or Node.js is missing** from PATH, instead of sessions that silently never report their state.
- **Cowork requests open as a dialog** (one at a time; **Later** leaves them in the bottom bar), and an **auto mode** (⚙ settings, or the box in the dialog) accepts them without asking: links to a workstream the task names, and prompts (those starting with a command character still ask).
- **No more "Assertion failed … conpty.cc" crash**: node-pty 1.1.0 kept its terminal list without a lock, so terminals ending at the same moment (after a reboot, or several closing together) could trip an assertion that froze every terminal. polycli now uses node-pty 1.2.0-beta.18, which guards it.
- **After a reboot**, sessions whose background process ended are started again (same conversation) instead of being reattached in a loop.

## 0.3.0 — 2026-11-10

### Workstream views
- **Main / Board / Architecture / Docs / Tests** above the tabs switch what the selected workstream shows.
- **Board**: a Kanban board (Ready, Doing, Done). Each card has its own chat with headless Claude, which can talk the task through and write a functional spec, a tech spec or a literature search into `docs/cards/<card>/`; the documents open in Docs. Cards live in `.polycli/` in the project.
- **Architecture**: the archlens diagrams in `docs/architecture/` (or `architecture/`) as tiles, opened in a viewer, with the architecture document.
- **Docs**: `docs/` as tiles with folders; Markdown preview and editing (Ctrl+S, asks before overwriting a file changed on disk); HTML and images in the viewer.
- **Tests**: runs the project's `test*`, `check*`, `verify*`, `smoke*` and `ci` scripts (also in `app/` or `packages/*`) and shows tests, passed, failed, skipped, failing names, live progress and a history.

### Center
- **One, two or four panes** (▢ ◫ ⊞): each pane shows its own workstream and tabs; the same workstream in two panes shows two of its sessions or shells.
- **Notifications at the bottom**: a bar lists the sessions that need you or ask a question (with **Show**), and Cowork link requests and prompts to approve.
- **✋** replaces the status dot of a workstream, session or tab while a session waits on your answers.

### Shells
- **WSL and SSH shells**: **+ Shell** asks for PowerShell, a WSL distribution, or SSH (host, user, key, port; hosts from `~/.ssh/config` are suggested, and a pasted `ssh -t -i … user@host` command is understood). `~` in the folder means the remote home.
- **Pinned shells**: a command run whenever polycli starts (and on ▶ Run), optionally after another shell is ready: a text in its output, a port that answers, or its command finished.
- **+ Mistral** opens Mistral Vibe (`vibe`) in a tab.

### Claude sessions
- New sessions start with **Remote Control** on, so they can be continued from claude.ai/code or the Claude mobile app (a remembered box in the New session dialog; off for API-key, gateway and cloud-provider setups).
- **Selecting past the edge** of a Claude pane scrolls the transcript and keeps growing the selection; Ctrl+C copies all of it. The wheel clears a selection.
- **Prompt list**: blocks Claude Code writes into the conversation as XML (a `<task-notification>` when a background task ends, and the like) show by name with their status and gist, and the hover card shows their fields, with long ones as Markdown.
- **Time and tokens** per workstream: this week's Claude time and output tokens (resets Monday 07:00), and for billable workstreams your own time, with monthly history and CSV.

### Cowork bridge (extension 0.3.0)
- **`polycli_inbox`**: a CLI session sends a message to the linked Cowork or Claude Design task with `node "$POLYCLI_POST" "…"`; the task reads it with the new tool.
- A relayed prompt is no longer submitted before its text has landed (it could reach Claude as its header line alone).

### Fixes
- Sessions launched while polycli inherited `FORCE_COLOR` looked failed while they ran; the output is now read without color codes, and such sessions are adopted on start.

## 0.2.0 — 2026-11-06
- Prompt list beside each Claude session; start polycli at sign-in.
- Paste images and files into a pane as paths.
- Archive workstreams; Cowork prompts interrupted at a permission prompt are settled.
- The Cowork bridge; in-app help with screenshots.
- Git line with Commit / Push / Deploy in the session header; light mode.
- A session followed into a git worktree; workstream environment variables and the Keys view.
