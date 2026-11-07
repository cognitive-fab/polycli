# polycli help

polycli keeps your Claude Code sessions and shells organized by **workstream**, one window for all of them.

![polycli with a workstream, two Claude sessions and a shell](overview.png)

## Workstreams

A workstream is one piece of work: a name, a color and a main folder. Its Claude sessions and shells are listed under it in the left rail. Click **+** next to *Workstreams* to create one.

- The dot after a name shows the most urgent state inside it: **yellow** needs you, **blue** working, **green** idle.
- Under the active workstream: **+ Claude** starts a session, **+ Shell** opens PowerShell in the folder, **VS Code** opens the folder, **⚙ Settings** edits the name, color, environment variables and deploy command.
- Closed sessions are kept under **Closed (n)**. Click one to reopen it with its conversation.
- To put a finished workstream away, use **⚙ Settings → Archive workstream…**. This closes its sessions (conversations are kept) and shells, and moves it to **Archived (n)** at the bottom of the rail. It keeps its settings, variables and Cowork history. Linked Cowork tasks can't use it while it is archived. Click **Restore** to bring it back, then reopen its sessions from **Closed**. polycli waits until Claude is idle before archiving.

## Claude sessions

**+ Claude** asks for a role (the session is named "workstream · role"), a folder, a model and an effort. Each session is a Claude Code *background* session shown in a tab:

- It **keeps running when polycli closes**, and polycli reconnects to it when it starts again.
- **✕ Close** stops it but keeps the conversation; it moves to *Closed*.
- **⟳ Restart** restarts it on the current Claude Code version with the same conversation. Use it after changing the workstream's environment variables.
- **Delete** removes the session and its conversation.
- Everything Claude Code does works as usual inside the tab. Pressing **←** on an empty prompt opens Claude's agent view.

**Prompts.** The column at the right of a session lists the prompts you sent it, newest first, with the time. Hover one to read it in full; click it to scroll Claude's conversation to it (the prompt line is highlighted for a few seconds). Prompts sent before a `/clear` stay in the list, greyed out. **›** hides the column for every session and **‹** brings it back. The list starts with the prompts sent once this version of polycli runs.

## The session header

![Session header](header.png)

1. **Claude Code version**.
2. **Model and effort**, then your plan.
3. **Folder.** Click to open it in VS Code (**Shift**: the git repository root, **Ctrl**: a new VS Code window). A **worktree** tag appears when the session moved into a git worktree (see below). The **⧉ id** copies `claude attach <id>`.
4. **Git line** (only in a git repository): branch, sync state, changed files, the GitHub repository, the pull request and its checks, and the **Commit**, **Push** and **Deploy** buttons.

## Worktrees

A git *worktree* is a second working folder for the same repository, checked out on a different branch. Claude Code can create one (in `.claude\worktrees\<name>` inside the repository) to work on a branch in isolation: your main folder and its branch are untouched while Claude works, and the work comes back through a merge or a pull request.

When a session moves into a worktree, the header shows that folder with a **worktree** tag, the branch shown is the worktree's branch, and VS Code opens the worktree. Hover the folder to see where the session started.

## Git: Commit, Push, Deploy

- **Commit** lists the changed files, stages them (`git add -A`, optional) and commits with your message. Your git hooks and signing run as usual. **Ask Claude to commit** lets the session write the message and commit instead.
- **Push** asks first and shows what will be pushed. A branch that isn't on GitHub yet shows **Publish**. polycli never force-pushes; if GitHub rejects the push, you see git's message.
- **Commit** and **Push** are disabled while Claude is working, so you don't commit half-edited files.
- **Deploy** appears when the workstream has a deploy command (**⚙ Settings**), or when `package.json` has a `deploy` script. It asks first, then runs in a new shell tab so you see the output. It never runs again by itself.
- **↻** refreshes the git and pull request information. It also refreshes after each Claude turn and every 20 seconds.

## Needs you

When Claude needs a decision (a permission prompt, for example), the session turns **yellow**, the **need you** counter in the top bar goes up, and the taskbar button flashes when polycli isn't in front. Click the counter to jump to the session.

## Shells

**+ Shell** opens PowerShell in the workstream folder, with the workstream's environment variables. Shells end when polycli closes and new ones open in the same folders when it starts again; their history isn't kept.

## Mistral

**+ Mistral** opens Mistral Vibe (the `vibe` command) in a new tab in the workstream folder, with the workstream's environment variables. Sign in or paste your key the first time Vibe asks, or set `MISTRAL_API_KEY` in the workstream's settings. When you quit Vibe the tab stays on a shell; restarting polycli starts Vibe again.

## Architecture and Docs

Above the tabs, **Main**, **Architecture** and **Docs** switch what the workstream shows.

- **Architecture** shows the archlens diagrams found in `docs/architecture/` (or `architecture/`) of the workstream folder as tiles. Click one to open it in the viewer; ‹ › move between diagrams. The architecture document (README.md) is the last tile.
- **Docs** shows `docs/` as tiles: folders drill down, the path above the tiles takes you back up. Click a Markdown file to preview it; **Edit** shows the source beside a live preview, **Save** (Ctrl+S) writes it. If the file changed on disk meanwhile, polycli asks before overwriting. HTML files and images open in the viewer; **+ New document** creates a Markdown file in the current folder.

## Time and tokens

The pill at the top right shows, for the selected workstream's folder, what Claude did this week: generation time and output tokens, like `(5m 38s · ↓ 40.7k tokens)`. The week resets Monday at 7:00.

Tick **Billable folder** in a workstream's settings to also count your own time on it: the workstream is selected, polycli is the focused window, you haven't been idle for 5 minutes, and none of its Claude sessions is generating. The pill then starts with `⏱` and this month's total, and glows while counting. Click the pill for monthly totals per folder, with days underneath, and **Copy CSV**.

## Copy and paste

- **Drag** to select text, then **Ctrl+C** to copy. With nothing selected, Ctrl+C goes to Claude as usual.
- **Ctrl+Shift+C** always copies and never reaches Claude.
- **Ctrl+V** pastes. The mouse wheel scrolls Claude's conversation.
- **Images and files go in as paths.** Paste a screenshot or a copied image with Ctrl+V: polycli saves it as a PNG under `%APPDATA%\polycli\pastes` and types its path, and Claude attaches it as *[Image #1]*. Files copied in Explorer (Ctrl+C on a file) paste as their paths, and so do files dragged onto a pane. Paths with spaces are quoted. When the clipboard also has text, the text is pasted. Saved pastes are deleted after 7 days.

## Continue in another terminal

Click the **⧉ id** in the header to copy `claude attach <id>`, and run it in any terminal. A session can only be attached in one place, so that terminal takes it over and the tab shows **Take back**. The conversation is the same in both places.

## Environment variables and keys

![Workstream settings](settings.png)

- **⚙ Settings → Environment variables**: name/value pairs given to every Claude session and new shell of the workstream, on top of your Windows variables. Values are stored encrypted and never shown again. Running sessions pick up a change on **Restart**; the tab tells you when one is needed.
- Variables that start with `ANTHROPIC_` or `CLAUDE_CODE_USE_` change how Claude itself signs in and bills, and polycli warns about them.
- **Global keys this workstream uses**: tick the Windows key variables the workstream relies on, for your own tracking.

![Keys](keys.png)

**Keys** in the top bar lists the key-like variables saved in Windows (names only), which workstreams use each one, and which workstreams set their own value.

## Cowork bridge

Cowork tasks can work with your polycli sessions: link to a workstream, send prompts to its Claude sessions and read the answers, start new sessions for parallel work, and report the artifacts and documents they produce.

**Set up once.** Click **Cowork** under a workstream, then **Install or update the extension…**. The Claude desktop app opens its install dialog for the **polycli bridge** extension (it says the extension is unsigned); install it. polycli must be running for Cowork to reach it.

**In a Cowork task**, ask for it in plain words, for example: *"Use the polycli tools: link this task to the acme-api workstream, then ask the main session to run the tests and tell me the result."*

1. **Link.** The task asks to link; a **Cowork** bar appears above the tabs. Pick the workstream and click **Link**, or **Reject**. Several requests can be rejected at once, or muted for 15 minutes.
2. **Prompts.** Each prompt the task wants to send appears in the bar, in full, with the target session. Click **Send** or **Reject**.

![A prompt from Cowork waiting for approval](cowork-approval.png)

3. **Delivery.** polycli types the prompt into the session when it is idle (never while you are typing in it), with a first line saying which Cowork task sent it. The tab shows **◇ From Cowork** while it runs, and the answer goes back to the task.
4. **Permission prompts** inside the session are still yours to answer in polycli; the Cowork task waits.

**Policies** (workstream **⚙ Settings**): prompts from Cowork can be sent without asking, and new sessions it requests can start without asking (only in the workstream folder). Prompts that start with `!`, `/`, `#` or `@` always ask.

The **Cowork** panel of a workstream lists the linked tasks (with **Revoke**), the artifacts and documents they reported (**Open link**, **Show file**), and their recent prompts and answers.

## Start with Windows

**⚙** in the top bar → **Start polycli when I sign in to Windows**. The Claude sessions that were open are reattached when polycli starts; after a restart of Windows they start again with their conversation.

## Themes

The top-bar button cycles **System**, **Light** and **Dark**. System follows Windows.

![Light theme](light.png)

## Troubleshooting

- **"Trust needed"**: Claude Code hasn't trusted the folder yet. Answer its prompt in the tab, then type `/exit`; polycli starts the session.
- **"Detached"**: the tab lost its connection while the session kept running. polycli reconnects by itself; **Reattach** does it now.
- **No pop-up notifications**: Windows only shows them for an installed app. In a development run (`npm start`) the taskbar button flashes instead.
