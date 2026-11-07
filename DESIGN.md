# polycli: a terminal app organized by workstream for Claude Code on Windows

Status: design draft v2, 2026-11-04. Working name: **polycli**.

v2 changes from the first draft:
- Electron instead of Tauri. WSL is deferred.
- Forward-looking only: no adoption of sessions started outside polycli.
- New: a two-way Cowork ↔ CLI prompt bridge, a session header, VS Code launch, a Cowork artifacts list, and Cowork-style close/restart.

## 1. Problem

The user runs several Claude Code CLI sessions in parallel, plus Cowork tasks that spin off more parallel work on the same repo. Terminal tabs get auto-generated names (`polywork-57`, `polywork-65`, …). Nothing records which terminal belongs to which piece of work, or which Cowork task asked for it. Cowork cannot talk to the CLI sessions it needs.

The missing unit is the **workstream**: one named piece of work that spans CLI sessions, plain shells, the Cowork task(s) driving it, and the artifacts and documents they produce.

## 2. Goals and non-goals

**Goals**
1. Launch and host Claude Code sessions and shells inside named workstreams, named correctly from birth.
2. Each session shows who it is: Claude Code version, model and effort, plan, folder.
3. Close, reopen and restart a CLI session as easily as a Cowork task, without losing the conversation.
4. **Cowork ↔ CLI dialog**: Cowork sends a prompt to a CLI session and reads the response back.
5. Keep a list of the artifacts and documents produced by Cowork (and the CLI), attached to the session and workstream.
6. Open VS Code on the right folder in one click.
7. One attention signal across sessions: **who needs me**.

**Non-goals (for now)**
- Sessions started outside polycli. Forward-looking only: they are not shown, adopted or managed.
- WSL (see §12, Later).
- Replacing Cowork or the desktop app, or rendering transcripts.
- Writing to Claude's files. polycli only *reads* them; its own state lives in its own store.

## 3. Concepts

```
Workstream ──< CliSession ──< Pane
    │      ──< Shell (recipe) ──< Pane
    │      ──< CoworkLink ──< ArtifactRef
    └──< Folder
```

- **Workstream**: a name, color, icon, one-line goal, folders, and an archived flag. polycli owns it.
  - **Archive** (built): refused while a session is busy or needs you. It closes the sessions (`claude stop`, conversations kept) and shells, sets `archived`, and hides the workstream under *Archived* in the rail. New, reopened and restarted sessions are refused until **Restore**. The Cowork bridge doesn't list it, can't link to it, and tells linked tasks it is archived.
- **CliSession**: one Claude Code conversation that polycli launched.
  - Fields: `bgId` (parsed from the `--bg` output at launch), `sessionId` (full UUID, learned from the first `SessionStart` hook or `agents --json`; its first 8 hex digits are the `bgId`), `name`, `cwd`, `role`, `state`, header info (§5), bridge policy (§7.4).
  - It is a Claude **background session** (`claude --bg`). It lives under Claude's own supervisor, not under polycli.
  - **Prompt list** (built): every `UserPromptSubmit` prompt is appended to `data/prompts/<id>.jsonl` (clipped to 8,000 characters, the last 200 kept, removed on Delete); `/clear` (SessionStart `source: clear`) is recorded as a divider. The record only carries `historySeq`, so state.json stays small; the renderer fetches the list when it changes. The list sits at the right of the pane, newest first; hover shows the whole prompt. A click finds the prompt in Claude's fullscreen transcript, which lives in the alternate screen with no xterm scrollback: polycli presses Ctrl+End, then Page Up (half a screen each) until a `❯` row matching the prompt shows, measuring each move by aligning the two screens, so later prompts with the same text are counted and "yes" finds the right "yes". Row 0 is skipped (Claude pins the current prompt there). Not while Claude needs you, since the keys would move a menu selection.
- **Shell**: a recipe (`pwsh`, `npm run dev`, …) run as a plain ConPTY child. It is **not** durable: it ends when polycli exits, and the recipe re-runs it on restore.
- **CoworkLink**: a Cowork task (`local_<id>`) linked to a workstream, and optionally to specific CLI sessions (§7.3).
- **ArtifactRef**: an artifact, document or output file, plus where it came from (§8).

## 4. Session lifecycle (Cowork-like)

Claude Code already supplies every primitive needed:

| User action | What polycli runs | Effect |
|---|---|---|
| **New session** | `claude --bg -n "<workstream> · <role>" --settings <run/<slot>.json> [--model …] [--effort …] [-w <worktree>]` → parse `bgId` from stdout (`backgrounded · 2eb9ba4f · <name> …`) → pane runs `claude attach <bgId>` | Named from birth. It starts idle with no prompt needed. **Spike result:** `--bg` ignores `--session-id` ("--bg manages the session id"). The bgId is the first 8 hex digits of the sessionId; the full ID arrives with the first `SessionStart` hook and in `agents --json`. |
| **Close** (× on the tab) | `claude stop <bgId>` | Process stops and the **conversation is kept**. The session moves to the workstream's *Closed* list with its last summary line. |
| **Reopen** (click a closed session) | `claude attach <bgId>` | Reopens the stopped session in place. Per `claude stop --help`: "`claude attach <id>` opens it again". |
| **Restart** (⟳) | `claude respawn <bgId>`, then re-attach | Restarts the same conversation on the current Claude Code version, settings and MCP config. Use it after an update or a stuck state. |
| **Restart fresh** | stop the old session, then **New session** with the same name, cwd, role and layout slot | A new conversation in the same slot ("new chat"). |
| **Hide pane** | nothing: only the view is hidden. The `claude attach` PTY stays attached. | The session keeps running. Prompts and status still flow (§7.2). |
| **Delete** | `claude rm <bgId>` (asks for confirmation) | Removes the session and, when it is safe, its worktree. |

**Folder trust (found in spike 0).** `claude --bg` refuses a folder whose trust prompt was never accepted. It prints "Workspace not trusted. Run `claude` in <dir> once and accept the trust prompt, then retry."
- What was observed: accepting the prompt in a subfolder of a git repo recorded the **repo root**, and `--bg` then accepted the subfolder. General parent-folder inheritance has not been tested beyond that. The pre-check accepts a folder when it or any ancestor is trusted. It is only a pre-check: `--bg`'s "not trusted" answer is authoritative and still opens the trust pane.
- **Pre-check (read-only):** before launching, polycli reads `~/.claude.json` → `projects[<path>].hasTrustDialogAccepted`. Keys appear in both `C:\…` and `C:/…` forms, so the path is normalized before lookup. Matching the error string is kept as a fallback.
- **Proposed flow, not yet run end-to-end:** for an untrusted folder, polycli opens a pane running plain interactive `claude`, so **the user** answers the trust prompt. Then polycli sends `/exit` and does the `--bg` launch.
- polycli never accepts trust on the user's behalf, and never writes `~/.claude.json`.

Closing or crashing polycli never ends a CLI session, because they are `--bg`. On the next start, polycli reattaches every session that was open, in its old layout slot.

**Status (Phase 1 findings).** `claude agents --json` takes 1–2 s per call, and its `state` is coarse.
- `state` is the task state shown in agent view. Observed values: `blocked` (waiting for input, including a fresh idle session), `working`, `stopped`, and `done`.
- `done` means the task is finished, **not** that the process ended: a live session reads `done` after a turn that completed its work, and a stopped one reads `done` too. (Treating `done` as ended closed a live session in real use.)
- A session whose process runs has a `pid` and a `status` (`idle` / `busy`); an ended one has neither.
- `blocked` does **not** mean needs-you.

So the two sources split the work:
- **`agents --json`, polled every 5 s, decides whether a session exists.** Missing, or no `pid`, means `closed`.
- **Hooks decide the turn state:**
  - `UserPromptSubmit` → `busy`;
  - `Stop` → `idle`;
  - `Notification` → `needs-you`, except idle-prompt notifications.
- **Reconciliation:**
  - A `busy` session that reads `blocked` on two consecutive polls settles as `idle`. This covers a turn that ended without `Stop` (Ctrl+C, crash).
  - After an attach, `blocked`, or an attach client quiet for 3 s, settles `starting` or `detached` as `idle`, because a reattach doesn't always produce a statusLine.
  - On polycli restart, a saved `busy` or `needs-you` is kept, because after a reattach a permission prompt also reads `blocked`.
- **Error states:** a launch error gives `failed`, with a Try again button. An attach client that exits on its own gives `detached`, with an automatic reattach of at most 3 per minute while the session still exists.
- **Attached elsewhere:** a session takes one attach client at a time; `claude attach <id>` in another terminal takes it over, and polycli's client exits after printing "Session opened in another window". polycli then marks the session `elsewhere`, does not reattach (also not on restart), and offers **Take back**. Hooks keep reporting turn state meanwhile. The pane header shows the id; clicking it copies `claude attach <id>`.

## 5. Session header and live info

Every CLI pane has a header strip that mirrors Claude's welcome banner and stays live:

```
┌ polygraph-paper · reviewer ──────────── ⚠ needs you ── [⧉ VS Code] [⟳] [×] ┐
│ Claude Code v2.1.287                                                        │
│ Opus 5.5 with high effort · Claude Ultra                                    │
│ ~\code\polycli  ⎇ main                                                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

| Field | Source |
|---|---|
| Version `v2.1.287` | statusLine input `version`, or the `version` field on transcript lines |
| Model `Opus 5.5` | statusLine input `model.display_name` (live, so it follows `/model`). Fallback: transcript `model` (`claude-opus-5-5`) mapped to a display name. |
| Effort `high` | Transcript `perTurnEffort` on assistant lines (verified; the statusLine input has no effort field), falling back to the launch `--effort` |
| Plan `Claude Ultra` | `~/.claude.json` → `oauthAccount.planDisplayName` (`"Ultra"`), shown as "Claude Ultra". Only that one field is read. |
| Folder `~\code\polycli` | Where the session is now: the `cwd` of its `claude agents --json` entry (polled every 5 s), shortened with `~`. A session can move, e.g. into a git worktree via EnterWorktree (seen: `cosa` → `cosa\.claude\worktrees\fix-backup-verify-sigpipe`). The launch folder is kept as `cwd` and the current one as `liveCwd`; the header shows a "worktree" tag and the launch folder in its tooltip, and the branch (`git rev-parse` in the current folder) and the VS Code button follow it. |

**Git line** (fourth header line, hidden outside a git repository), for the folder the session is in now:
- branch (or detached HEAD); `↑ahead ↓behind` against the upstream, "synced", or "not published"; "● n changed" or "clean"; conflicts;
- the GitHub repo (from the `origin` remote, https or ssh form) and the branch's pull request with its checks reduced to ✓ / ✗ / pending counts (`gh pr view`; skipped quietly when `gh` is missing or signed out);
- actions: **Commit** (when there are changes), **Push** / **Publish** (when ahead, or no upstream), **Deploy** (when configured), ↻ refresh.

How it is read and acted on:
- One `git status --porcelain=v2 --branch` per folder, with `--no-optional-locks` / `GIT_OPTIONAL_LOCKS=0` so a background read never takes the index lock from Claude's or the user's own commit, `GIT_TERMINAL_PROMPT=0`, and timeouts. Results are cached per folder (sessions sharing a folder share them) and kept out of `state.json`.
- Refreshed on `Stop` and `PostToolUse` (debounced), on a folder change, after polycli's own commit or push, and every 20 s for open sessions; the PR every 60 s. The UI is told only when something changed.
- **Commit** lists the changed files (repo-relative), optionally stages everything (`git add -A`), and passes the message on stdin (`git commit -F -`); hooks and signing run as usual, never `--no-verify`. **Ask Claude to commit** sends the session a prompt instead (only when it is attached and idle).
- **Push** confirms branch → upstream and the commit count; with no upstream it runs `git push -u origin HEAD`. Never forced; a rejection (remote moved on) is shown as git reports it.
- Commit and Push are disabled while the session is busy or waiting on a prompt, since files may be half edited.
- **Deploy** runs the workstream's deploy command (⚙ Settings), or else a `deploy` script found in `package.json` (session folder, then repo root), after a confirmation that shows the command and folder. It runs in a new shell tab of the workstream, so the output is visible and the workstream's variables apply. The command is passed only to that first start: a restored shell is a plain shell, so restarting polycli never deploys again.
- GitHub links open in the browser only after the main process re-checks they are `https://github.com/…`.

**Themes.** System / Light / Dark (top bar), saved in `ui.theme`; System follows Windows. Colors are CSS tokens with a light set; terminals switch theme live and the light one has a full 16-color palette. Claude Code's own UI was readable on the light terminal in the test screenshot.

### 5.1 statusLine feed
The per-session `--settings` file sets `statusLine` to `polycli-status`. The script:
1. reads the JSON Claude passes on stdin;
2. forwards it fire-and-forget to `\\.\pipe\polycli`;
3. prints a compact status line, so the in-terminal view stays useful.

The user's global `settings.json` is untouched. (It has no statusLine today, so nothing is overridden.)

**Spike result:** statusLine fires only while a client is attached (0 events in 8 s detached). Hidden-but-attached panes still get it. For a detached session, the header comes from the transcript.

**Spike result: the ← key.** Pressing ← on an empty prompt switches an attached client to Claude's **agent view** (the list of all sessions). The attach process does not exit. Before every bridge paste, polycli must confirm the pane shows the session's own prompt (its name appears in the input box border), and press → / reattach if not.

### 5.2 Hooks (same settings file)
- **`UserPromptSubmit`**: turn started. It also correlates bridge prompts (§7.2).
- **`Stop`**: turn done. Carries `transcript_path`, which is used to read the response.
- **`Notification`**: needs-you.
- **`SessionStart` / `SessionEnd`**: lifecycle.
- **`PostToolUse`** matching `Write|Edit|Artifact`: records documents and artifacts the CLI produced (§8).

Every hook runs `node polycli-hook.mjs <event>`, which connects to the pipe with a 100 ms timeout, writes one line, and **always exits 0**. A hook must never block or fail Claude.

## 6. Open in VS Code

- Clicking the header's folder, or **⧉ VS Code**, opens VS Code on `<cwd>`.
  - The launcher spawns `Code.exe` **directly** (`%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe`, which accepts `-r`, `-n` and `-g` itself), with an argument array and `shell:false`.
  - It never goes through `code.cmd`, because a `.cmd` file always runs via cmd.exe, where `&` or `|` in a path would be interpreted.
  - Only absolute paths that exist are passed. Artifact paths come from Cowork data and are untrusted.
  - If the session runs in a worktree (`-w`), the worktree path is opened.
  - Shift-click opens the git root instead. Ctrl-click opens a new window (`-n`). The default is `-r`, which reuses the window already showing that folder.
- Artifact and document rows (§8) open with `code -g <file>` for text and code files, and with the default app (`shell.openPath`) for pdf, docx, png and similar.
- There is also a workstream-level "Open all folders" action, which opens a multi-root workspace (`.code-workspace` generated under `%APPDATA%\polycli\workspaces\`).

## 6a. Environment variables and keys

**Findings (2026-11-05).**
- A background session takes its environment from Claude's background process, not from the process that runs `claude --bg`. A variable set only in polycli's environment did not reach the session.
- Windows user variables (`HKCU\Environment`) do reach it: `POLYWORLD_API_KEY`, `FRED_API_KEY` and the others were all present.
- A settings file's `env` block reaches the session. Claude re-reads the settings file on `claude respawn` and when a stopped session is reopened, so a changed value is applied by Restart or Reopen.
- Only `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `apiKeyHelper` and similar change how Claude itself signs in and bills. Names like `POLYWATCH_ANTHROPIC_API_KEY` mean nothing to Claude.

**Per-workstream variables.** Workstream ⚙ Settings holds name/value pairs.
- Values are encrypted with Electron `safeStorage` (DPAPI, current Windows user) in `state.json` and are never sent to the renderer; the dialog shows names only.
- When a session launches, restarts or reopens, polycli writes them into the session's `--settings` file (`env` block) under `%APPDATA%\polycli\run`. Claude has to read them from there, so that file holds them in plain text, readable by the same Windows user, like the registry's user variables.
- New shells in the workstream get them on top of polycli's environment.
- Each change bumps the workstream's `envRev`. A session or shell started with an older revision shows "environment changed, Restart to apply".
- Names starting with `ANTHROPIC_` or `CLAUDE_CODE_USE_` get a warning that they change Claude's own sign-in and billing.

**Global keys.** The Keys button lists the key-like variables saved in Windows (user and machine; names only, matched on KEY, TOKEN, SECRET, PASSWORD, CREDENTIAL, ENDPOINT). Each workstream records which of them it uses (`uses`, bookkeeping only), and the Keys view shows, per key, the workstreams that use it and the ones that set their own value.

## 7. Cowork ↔ CLI bridge

### 7.1 Transport: a local MCP server Cowork already knows how to use
Cowork sessions can call host-side desktop extensions. Their recorded tool lists include `mcp__Desktop_Commander__*` and Windows-MCP tools, which are local stdio servers installed under `%APPDATA%\Claude\Claude Extensions\`.

polycli therefore ships **`polycli-bridge`**:
- a small Node MCP server packaged as a Claude desktop extension (`.mcpb`);
- it connects to polycli's `\\.\pipe\polycli-bridge`, authenticating with a per-install token from `%APPDATA%\polycli\bridge.token`;
- if polycli isn't running, every tool returns "polycli is not running" and nothing else.

**Spike 0c results (2026-11-05):**
- **Installing.** Windows has no file association for `.mcpb`. Launching `claude.exe <file.mcpb>` (the desktop app) opens its "Install Extension?" dialog, so the polycli installer can use the same route. The desktop flags the extension as unsigned.
- **Round trip works.** Two Cowork tasks called the extension's tools and got results back.
  - Each call costs about 16 ms of overhead.
  - Calls of 30 s and 60 s both returned.
  - Calls are concurrent: task B was served while task A's 60 s call was pending.
- **One shared server process for every Cowork task.** It is started by the desktop with its built-in Node.
  - `clientInfo` is the generic `local-agent-mode-<extension name>`.
  - `params._meta` is empty.
  - So **the server cannot tell which task is calling** (§7.3).
- **Today's Cowork tasks wrote nothing local.** No new `local_<id>` folder or `audit.jsonl` appeared. The desktop log shows them reaching host tools through `remote-tools-device`. They run remotely, so the local Cowork files describe older tasks only.
- **Per-call timeout: 60 s, end to end.** The 60 s ping finished at 60.002 s on the server, but Cowork had already failed it with "Device '<machine>' did not respond within 60s… the tool may still be running there". That wording confirms calls travel through a remote-tools relay to this machine. Consequences:
  - Every bridge tool must return within **40 s**, leaving margin for the relay. `wait_seconds` is capped at 40, and `link_status` blocks for at most 25 s.
  - Long operations are always two-step: start, then poll with `polycli_read` or `polycli_link_status`.
  - A timed-out call may still complete on the host. So `polycli_send` is idempotent: Cowork passes a `client_ref`, and a retry with the same `client_ref` returns the existing `turn_id` rather than sending the prompt twice.

Tools:

| Tool | Purpose |
|---|---|
| `polycli_link(task_title, workstream?)` / `polycli_link_status(link)` | Pair this Cowork task with a workstream (§7.3). Returns a `link` token that every tool below except `polycli_list` requires. |
| `polycli_add_artifact(link, title, kind, url?, path?, description?)` | Cowork reports an artifact or document it produced (§8) |
| `polycli_list(workstream?)` | Workstreams and sessions, with name, state, header info and pending turns |
| `polycli_send(link, session, text, client_ref, wait_seconds≤40)` | Queue a prompt (idempotent per `client_ref`). Returns `{turn_id, state}`. If the turn finishes within the wait, it also returns the response. |
| `polycli_read(session, turn_id)` | `{state: queued\|running\|needs-you\|done\|failed, response, files_changed[], artifacts[], ended_at}` |
| `polycli_status(session)` | Live state and header |

**The user manages the connection** (decided 2026-11-06): they open the Cowork task, open or reopen the Claude session in polycli, and approve the link between them. Cowork never opens, closes or restarts a session; a prompt for a closed session fails with "ask the user to reopen it in polycli". (`polycli_open_session` existed until 0.2.0; `close` / `restart` tools were planned and dropped.)

The wait is capped at 40 s because the relay fails calls at 60 s (spike 0c), so Cowork long-polls with `polycli_read`. Cowork cannot answer a CLI permission prompt. A `needs-you` state tells Cowork "waiting for the user in polycli", and the user approves it in the pane.

### 7.1a Built (2026-11-05)

The bridge is implemented: the extension in `bridge/` (zero dependencies, packed with `npm run bridge:pack`), the pipe server in `app/src/main/bridge.js`, the turn/link core in `app/src/main/cowork.js`, and the UI (Cowork bar, Cowork panel, policies). Tools: `polycli_list`, `polycli_link`, `polycli_link_status`, `polycli_send`, `polycli_read`, `polycli_status`, `polycli_add_artifact`. Not built yet: Edit & send, folder watching, legacy Cowork files, Pin a copy.

**Findings that changed the delivery (probe, 2026-11-05):**
- A long or multi-line bracketed paste is shown as `[Pasted text #1 +20 lines]` (after up to ~6 s), and `UserPromptSubmit` receives it wrapped in `<pasted_content id=…>`. Claude treats such pasted content as quoted data and declined to act on an instruction inside it. So every bridge prompt is preceded by a short line typed as the user's own input: `[polycli <turn id>] Request relayed from a Cowork task linked to this workstream (link <id>, approved by me in polycli | allowed by my polycli policy for this workstream). Please handle it:`. The wording is fixed: nothing the Cowork task chooses (not even its title) goes into this line, since Claude reads it as the user's own words. The approval bar shows this line above the prompt. With it, Claude answered the long prompt (smoke test: LONGPONG).
- The `[polycli <turn id>]` marker is what correlates `UserPromptSubmit` with the turn (not a text comparison).
- The paste check counts the `[Pasted text` placeholder as shown; otherwise long prompts were pasted three times.
- **Esc does not fire `Stop`.** A running turn that goes busy → idle without `Stop` settles from the transcript's last assistant message written after the turn started, or fails as "ended without a response".

### 7.2 Delivering a prompt and reading the answer
1. polycli keeps a per-session FIFO of bridge turns. A turn is written only when the session is `idle`.
2. **Validate, then write.**
   - Text containing ESC or any C0 control character other than `\n` and `\t` is **rejected** (not stripped), so an embedded `ESC[201~` can never end the paste early and smuggle keystrokes.
   - Text starting with `!`, `/`, `#` or `@` (Claude input modes) always needs explicit approval, whatever the allow-policy.
   - Then it goes into the attached PTY as bracketed paste (`ESC[200~ … ESC[201~`), so multi-line text doesn't submit early, followed by Enter. Spike 0b confirms that the TUI enables bracketed-paste mode and how long to wait before Enter. The pane shows a banner line ("◇ from Cowork: *State machine compat…*") above it, so the human sees what came in.
   - The PTY stays attached in the background even when the pane is hidden. Panes are a view; attachment is always there.
3. **Correlate**: the next `UserPromptSubmit` whose prompt equals the queued text marks the turn `running`. Correlation is exact because sends to a session are serialized.
4. **Collect**: on `Stop`, take the final assistant text from the hook input's `last_assistant_message` (**spike 0b: present, and it matched the transcript in 4 of 4 turns**). If it is missing, read `transcript_path` from the turn's user message to the end, retrying until this turn's assistant entry is present and the file size has been stable for 200 ms, for up to 3 s. If that times out, the turn is `done` with `response_incomplete: true`, and it is re-read on the next poll. From the result:
   - the response is the text of the final assistant message;
   - `files_changed` comes from Write and Edit tool uses;
   - `artifacts` come from Artifact tool results.

   The turn becomes `done`. If the session ends or crashes mid-turn, the turn becomes `failed`.
5. A human typing into the same session at the same time is allowed. Bridge turns wait for idle, and only the correlated turn's output is returned.

### 7.3 Knowing which Cowork task is calling
Spike 0c showed that the server cannot identify the caller:
- one process serves every task;
- `clientInfo` is generic and `_meta` is empty;
- current Cowork tasks run remotely, leaving no local audit log to scan.

So the identity is **explicit and paired once**:

1. **Pair.** The Cowork task calls `polycli_link(task_title, workstream?)`.
   - polycli shows a banner: "Cowork task *‹title›* wants to link to workstream *‹ws›*". The user can [Link], [Link to another workstream…] or [Reject].
   - The call returns `{link: "lnk_<random 128-bit>", state: "pending"}` immediately. Cowork polls `polycli_link_status(link)` until the user decides. The tool description asks for one poll every 10 s or more, and `link_status` may block for up to 25 s waiting for a decision.
   - A pending link **expires after 10 minutes**. `link_status` then returns `expired`, and the banner disappears.
   - There is no global cap, since the server can't tell callers apart and one noisy task could exhaust it for everyone. Instead, all pending requests collapse into **one** banner ("3 Cowork link requests"), with [Review] [Reject all] [Mute requests for 15 min]. While muted, `polycli_link` returns `muted`, and nothing is lost: the task can retry later.
2. **Use.** Every other tool except `polycli_list` requires `link`.
   - The token is returned only in that task's own tool result, and the shared server keeps no per-caller state. One task therefore can't act as another without seeing its token.
   - The tool descriptions tell Cowork to keep the token for the rest of the task.
3. **Record.** An approved link becomes a **CoworkLink** (task title → workstream, plus the sessions it opened or prompted).
   - Link titles are claimed by Cowork, not proven. The user confirms each one once, and every later approval banner shows the link's title.
   - The user can revoke a link at any time. After that, its token gets "link revoked".

Tasks that never call the bridge can still be added by hand ("+ Cowork task" with a title and URL), so a workstream can list them.

### 7.4 Safety
Cowork browses the web and reads documents. A prompt it relays into a CLI session with shell access is a prompt-injection path. So the policy is set **per workstream**:
- `send`: **ask each** (default) | allow for this session | allow for this workstream.
  - The approval banner shows **exactly the bytes that will be sent**: the full prompt text, the calling Cowork task and the target session, with [Send] [Edit & send] [Reject].
- Bridged sessions keep their own permission mode. polycli never adds `--dangerously-skip-permissions` or `bypassPermissions` for a bridge launch.
- The pipe accepts only callers that present the install token. The token file is ACL'd to the user. Every bridge call is written to `events.jsonl`.

## 8. Artifacts and documents

Per session and rolled up per workstream, an **Artifacts** panel lists:

| From | Source | Shown as |
|---|---|---|
| Cowork artifacts and documents (primary) | Reported by the linked task itself: `polycli_add_artifact(link, title, kind, url?, path?, description?)`. The bridge tool descriptions ask Cowork to report every artifact or document it creates for the workstream. | name, description, link or file |
| New files in workstream folders | fs-watch on the workstream's folders lists new document-like files under "New in folders". **No attribution is guessed.** A file is labeled "CLI ‹session›" only when a `PostToolUse` Write/Edit hook reported that exact path; hooks are best-effort, so a missed report just leaves it unlabeled. The user can drag any file onto a session or Cowork link to keep it there. | files, grouped by folder |
| Older local Cowork tasks (best effort) | `…\local-agent-mode-sessions\…\artifacts.json`, `local_<id>\outputs\*`, `fsDetectedFiles`. Spike 0c found that tasks running today don't write these, so this row only covers older local tasks. | name, files |
| CLI documents | `PostToolUse` on `Write` for document-like files (`.md .html .pdf .docx .pptx .xlsx .csv`) | files |
| CLI published artifacts | `PostToolUse` on `Artifact` → claude.ai URL | links |

- polycli **keeps the list** in its own store. If Cowork later archives the task, the entries remain, with "source gone" when a file disappears.
- "Pin a copy" snapshots a file into `%APPDATA%\polycli\pinned\<workstream>\` for the cases where you need it to survive.
- Watching: fs-watch on workstream folders, plus the legacy Cowork files. `local_<id>.json` is large, so it is re-read only when its mtime changes.

## 9. UI

```
┌─ polycli ──────────────────────────────────────────── ⚠ 1 · ◇ 1 pending ─ ⌘K ┐
│ WORKSTREAMS           │ reviewer │ writer │ pwsh │ +                          │
│                       ├──────────────────────────────────────────────────────┤
│ ● polygraph-paper   ⚠ │ Claude Code v2.1.287                [⧉ VS Code][⟳][×] │
│   ├ ▣ reviewer      ⚠ │ Opus 5.5 with high effort · Claude Ultra             │
│   ├ ▣ writer        ◐ │ ~\code\polygraph  ⎇ main                             │
│   ├ ▣ pwsh          · │──────────────────────────────────────────────────────│
│   ├ ◇ Cowork: State…  │ ◇ from Cowork: "Run the compat suite on v3 and…"    │
│   └ Closed (2)        │ > Run the compat suite on v3 and summarize failures  │
│ ● polysim           ● │   ● Bash(npm run compat -- v3)                       │
│   └ ▣ main          ● │   …                                                  │
│                       ├──────────────────────────────────────────────────────┤
│ + New workstream      │ ARTIFACTS  ◇ compat-report.html · ◇ fig_SDLC.png ·  │
│                       │            ▣ docs/compat.md · ◇ Polysec SDLC model   │
└───────────────────────┴──────────────────────────────────────────────────────┘
 ▣ CLI session   ◇ Cowork task   ⚠ needs you   ◐ busy   ● idle   · shell
```

- **Left rail**: workstreams → sessions, shells, Cowork tasks, and a *Closed* list per workstream (click to reopen). Hover shows ⟳ and ×.
- **Center**: tabs and splits for the workstream. Each CLI pane carries the header from §5.
- **Bottom/side panel**: Artifacts (§8), the bridge queue (pending and running turns, with approval banners), and the event timeline.
- **Top bar**: the needs-you inbox, the pending bridge approvals, and `Ctrl+K` (command palette: new session, jump to needs-you, reopen, restart, open in VS Code, fuzzy search).
- Global hotkey `Win+Alt+C`. A tray icon carries the needs-you count. Windows toasts fire on needs-you and on bridge requests.
- The window title shows the active workstream name.

## 9a. Project views and Mistral

- **Views.** The active workstream has three views at the same level: Main (tabs and terminals), Architecture and Docs (`ui.view`). Switching never closes a terminal.
- **Files** (`main/projectfiles.js`). Architecture lists `*.architecture.html` (not `.visual-check.`) from `architecture/` or `docs/architecture/`, titled from the matching `.json`. Docs lists `docs/` with folders as tiles. Every path is relative to the workstream folder, confined to `architecture/` and `docs/` on the real path. polycli edits only existing `.md/.markdown/.txt` files (refusing when the mtime moved since it was read) and creates new `.md` files; this is the one place it writes project files, and only on a click.
- **Viewer.** HTML and images load in a sandboxed iframe from `polycli-view://<workstream id>/<path>`, served by main with its own CSP (inline scripts, Google Fonts, nothing else). The iframe has `allow-same-origin` only because archlens pages use localStorage; its origin differs from the app's.
- **Mistral.** `+ Mistral` is a shell tab (`agent: 'mistral'`) that runs Mistral Vibe (`vibe`); restart reruns it. No API integration: Vibe handles the subscription login or `MISTRAL_API_KEY`.

## 9b. Time and tokens (`main/billing.js`)

Per workstream (keyed by id, name kept for history), in hourly local buckets in `state.billing`: `bill` (my seconds), `gen` (Claude's `turn_duration`) and `out` (output tokens). Transcripts are read incrementally by byte offset (a message written once per content block is counted once, by id), so restarts never double count and history survives Claude pruning transcripts. `bill` ticks every 5 s while the workstream is billable and selected, the window is focused, system idle is under 5 minutes and no session of the workstream is `busy`. Week = since Monday 07:00 local. Still open: attributing time per Cowork task, and manual adjustments.

## 10. Architecture (Electron)

```
┌─ renderer (vanilla JS modules + xterm.js, fit addon) ──────────────────────┐
│ rail · panes+headers · artifacts · bridge queue · palette                  │
└──────────────▲───────────────────────────────▲─────────────────────────────┘
               │ contextBridge IPC             │ MessagePort (PTY bytes)
┌──────────────┴──── main process ─────────────┴──┐   ┌─ utilityProcess: ptyHost ─┐
│ SessionManager  (--bg/attach/stop/respawn/rm,   │◄─►│ node-pty (ConPTY)          │
│                  agents --json poll, reconcile) │   │  • claude attach <bgId>    │
│ HookServer      \\.\pipe\polycli                │   │  • shell recipes           │
│ BridgeServer    \\.\pipe\polycli-bridge (token) │   └────────────────────────────┘
│ CoworkIndex     artifacts.json, outputs, audit  │
│ Store           %APPDATA%\polycli (JSON+JSONL)  │   polycli-hook.mjs / polycli-status.mjs
│ Launchers       VS Code, default app            │   polycli-bridge (.mcpb, MCP stdio)
│ Notifier/Tray                                   │
└─────────────────────────────────────────────────┘
```

- **ptyHost runs in an Electron `utilityProcess`** (the same pattern as VS Code's). A renderer reload or crash doesn't drop terminals. A full app exit ends the shells only, never the `--bg` Claude sessions.
- **Store**: `state.json` (workstreams, sessions, links, policies, layouts), written atomically (write temp file, then rename), plus `events.jsonl` (append-only). This avoids a native SQLite module. SQLite can be revisited if the event log gets large.
- **Native modules**: only `node-pty`, rebuilt for Electron with `@electron/rebuild` (this may need the VS C++ build tools). Packaging: `electron-builder` NSIS, per-user install.
- **Helper scripts** (`polycli-hook.mjs`, `polycli-status.mjs`) run on the installed Node 24 (about 50 ms startup). If hook latency is noticeable, port them to a tiny compiled exe.
- **Format drift**: the CoworkIndex and transcript readers parse only the fields they need, fail per record, and show a "source degraded" chip. Fixture files per Claude version back regression tests. `claude agents --json` is the only documented interface, and lifecycle depends on it alone.

## 11. Phases

| Phase | Scope | Done when |
|---|---|---|
| **0: Spikes** (2–3 days) | (a) `claude --bg` + `attach` inside xterm.js/node-pty: resize, mouse, detach key, reattach after app kill. (b) Bracketed-paste prompt injection + `UserPromptSubmit`/`Stop` correlation. (c) Hello-world `.mcpb` called from Cowork: approval, latency, timeout. (d) statusLine fields: confirm `version` and `model.display_name`, and whether effort is present. | All four have a yes/no and numbers. Spike (c) decides the bridge transport. |
| **1: Core terminal** | Workstreams; new / close / reopen / restart / restart-fresh / delete; headers; VS Code launch; shells and recipes; layouts; reattach on restart; status reconciliation; needs-you inbox and toasts. | A day of CLI work done in polycli. Killing polycli loses **no Claude session**, and shells come back from their recipes. |
| **2: Cowork read side** | CoworkIndex; manual CoworkLinks; Artifacts panel (Cowork + CLI); pin a copy. | Every artifact and output of a linked Cowork task is listed and opens in one click. |
| **3: Bridge** | `polycli-bridge` extension; send/read/status; approvals and policies; audit-log attribution. | Cowork sends a prompt to a named CLI session, the user approves it once, and Cowork reads the answer back without the user copy-pasting. |

## 12. Later
- **WSL**: `wsl.exe -d <distro> -- claude --bg …` + attach; hooks via `/mnt/c` interop; distro-side `claude agents --json`, polled only when the distro is running.
- Optional discovery of sessions started outside polycli (read-only).
- CLI → Cowork notifications (today Cowork polls with `polycli_read`).

## 13. Risks
- **Bridge transport (spike 0c).** If a new extension can't be called from Cowork reliably, the fallback is a **mailbox folder** inside a Cowork-selected folder (Cowork mounts those into its VM). That fallback would need the same approval banner, a per-link token, and git-excluding `.polycli/`.
- **Prompt injection through Cowork.** Mitigated by approvals with the full text shown, per-workstream policy, and no permission bypass for bridged sessions (§7.4).
- **Undocumented files** (`audit.jsonl`, `artifacts.json`, the transcript, `~/.claude.json`). These are read-only, use tolerant parsers, and degrade per source.
- **`claude attach` in xterm.js** (spike 0a). Terminal quirks around resize and alternate screen.
- **TUI paste behavior.** If Claude's input box changes how it handles bracketed paste, correlation (§7.2) still holds, but delivery may need an adjustment. Spike 0b covers this.
