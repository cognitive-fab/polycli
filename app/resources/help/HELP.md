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

## Remote Control

New Claude sessions start with Remote Control on, so you can continue them from claude.ai/code or the Claude mobile app, where they appear under their polycli name. The **Remote Control** box in the New session dialog turns it off for a session, and polycli remembers your last choice. A session with it on shows **remote** in its header. Remote Control needs a claude.ai login (Pro, Max, Ultra, Team or Enterprise); in a workstream whose environment variables set an API key, a base URL or Bedrock/Vertex/Foundry, polycli starts sessions without it. Sessions created before this version stay without Remote Control, also after a Restart; start a new session to get it.

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

When Claude needs a decision (a permission prompt, for example), the session turns **yellow**, the **need you** counter in the top bar goes up, and the taskbar button flashes when polycli isn't in front. A bar at the **bottom** of the window also lists every session that needs you or is asking a question (✋) and isn't on screen, with a **Show** button; Cowork link requests and prompts to approve appear in the same bar. Click the counter or **Show** to jump to the session.

## Shells

**+ Shell** opens PowerShell in the workstream folder, with the workstream's environment variables. Shells end when polycli closes and new ones open in the same folders when it starts again; their history isn't kept.

### WSL and SSH shells

**+ Shell** asks which kind: **PowerShell** on this computer (the default), a **WSL** distribution, or **SSH** to another computer. SSH has one box per part of the ssh command: **Host** (your `~/.ssh/config` hosts are suggested), **User**, **Key** (the private keys in `~/.ssh`) and **Port**. You can also paste a whole command such as `ssh -t -i "$HOME\.ssh\id_jdubray" user@192.168.12.125`: polycli takes the host, key (`-i`), port (`-p`) and user (`-l`) from it; for any other ssh option, add it to that host in `~/.ssh/config`. Passwords and host-key questions are answered in the tab. An optional folder sets where the shell starts (a Linux path or `C:\…` for WSL, a folder on the other computer for SSH). The rail shows wsl or ssh next to these shells. Shift+click **+ Shell** opens PowerShell without asking. Workstream environment variables reach PowerShell shells only. A WSL or SSH shell can be pinned like any shell; its command runs in bash (WSL) or the remote login shell (SSH).

### Pinned shells

**📌 Pin…** in a shell's header gives it a command that runs every time polycli starts (and on **▶ Run**), for example a server: `agentmesh up`. A pinned shell can **start after** another shell of the workstream is ready, meaning one of:

- its output shows a text you give (`listening on`): the usual choice for a server, which never finishes;
- a port on this computer answers (`8080`): also for a server;
- its pinned command has finished successfully: for a build or setup step.

While it waits, the shell says what it is waiting for. polycli gives up after 15 minutes, and doesn't start it if the other shell's command failed or the other shell was closed. **Edit pin…** changes it or unpins the shell.

## Mistral

**+ Mistral** opens Mistral Vibe (the `vibe` command) in a new tab in the workstream folder, with the workstream's environment variables. Sign in or paste your key the first time Vibe asks, or set `MISTRAL_API_KEY` in the workstream's settings. When you quit Vibe the tab stays on a shell; restarting polycli starts Vibe again.

## Two or four panes

The buttons at the right of the Main / Board / … bar show one pane (▢), two side by side (◫) or four (⊞) in the center. Each pane has its own tabs and shows one workstream. The selected pane has a blue border: the rail and the tabs act on it, so to put a workstream in a pane, click the pane and then the workstream in the rail. A session or shell is shown in one pane at a time; picking the same workstream in two panes shows two different sessions or shells of it, and a pane says so when there is nothing left to show (start another session or shell there). polycli remembers the panes.

## Architecture and Docs

Above the tabs, **Main**, **Architecture** and **Docs** switch what the workstream shows.

- **Architecture** shows the archlens diagrams found in `docs/architecture/` (or `architecture/`) of the workstream folder as tiles. Click one to open it in the viewer; ‹ › move between diagrams. The architecture document (README.md) is the last tile.
- **Docs** shows `docs/` as tiles: folders drill down, the path above the tiles takes you back up. Click a Markdown file to preview it; **Edit** shows the source beside a live preview, **Save** (Ctrl+S) writes it. If the file changed on disk meanwhile, polycli asks before overwriting. HTML files and images open in the viewer; **+ New document** creates a Markdown file in the current folder.

## Artifacts

**Artifacts** (above the tabs) lists, newest first, what the workstream produced:

- **claude.ai artifacts** a Claude session published (Claude Code's Artifact tool), with the session's name;
- **documents** a session wrote or edited (Markdown, HTML, PDF, Word, Excel, PowerPoint, CSV, text), anywhere it worked, worktrees included;
- what a linked **Cowork** task reported with `polycli_add_artifact` (◇ and the task's name).

New ones appear as the sessions and tasks report them; **↻** also reads the sessions' transcripts again, so what a session made before polycli watched it is listed too. **All / Sessions / Cowork** and the filter box narrow the list.

Click one to open it beside the list:

- **Web pages** (claude.ai artifacts, links from Cowork) open inside polycli. The viewer has its own login: sign in to claude.ai there once, and it stays signed in. Links a page opens stay in the viewer (**‹** goes back); **Open in browser** opens the page you're on in your browser. Only https pages load, and a page can't use the camera, the microphone or your location.
- **Local files**: HTML pages (with the images and scripts beside them) and images show in the viewer, Markdown as a preview. A published page that also has its file on this PC offers **Local copy** / **Online**. Other files (Word, PDF…) are shown in Explorer with **Show in folder**; polycli never runs them.

## Board

**Board** (next to Main) is a Kanban board for the workstream: Ready, Doing, Done. Describe a task in the Ready box and press **Add & discuss** (Ctrl+Enter): a card opens with a chat where Claude talks the task through with you, then can write a functional spec, a tech spec or a literature search. Drag cards between columns, or use ‹ ›.

Each card's chat is a separate headless Claude (`claude -p`, resumed per card) running in the workstream folder. It can read the project, search the web and write files, but not run commands. What it writes goes to `docs/cards/<card>/` and appears as links on the card; click one to open it in Docs, where you can preview and edit it. Cards and chats are stored in `.polycli/` in the project folder (add it to `.gitignore` if you don't want to commit them).

## Tests

**Tests** runs the `test`, `check*`, `verify*` and `ci` scripts from the project's `package.json` and shows the numbers: tests, passed, failed, skipped, time, the failing test names, live progress while it runs, and a history of past runs. Counts come from the node:test, TAP or Jest summary; a script that prints none of those shows pass or fail only.

## A session asks a question

When a Claude session puts questions on screen and waits for your answers, a ✋ appears next to the workstream's dot in the rail, and on the session's entry and tab. It goes away when you answer. Sessions started before this version need a Restart to report questions.

## Time and tokens

The pill at the top right shows, for the selected workstream, what Claude did this week: generation time and output tokens, like `(5m 38s · ↓ 40.7k tokens)`. The week resets Monday at 7:00.

Tick **Billable workstream** in its settings to also count your own time on it: the workstream is selected, polycli is the focused window, you haven't been idle for 5 minutes, and none of its Claude sessions is generating. The pill then starts with `⏱` and this month's total, and glows while counting. Click the pill for monthly totals per workstream, with days underneath, and **Copy CSV**.

## Copy and paste

To select more than one screen, drag past the top of the pane (or down onto Claude's input box): the transcript scrolls and the selection keeps growing, as in a console window. Ctrl+C copies all of it, not only the part on screen. Scrolling with the wheel clears a selection.

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

Cowork tasks can work with your polycli sessions: link to a workstream, send prompts to its Claude sessions and read the answers, and report the artifacts and documents they produce.

**Set up once.** Click **Cowork** under a workstream, then **Install or update the extension…**. The Claude desktop app opens its install dialog for the **polycli bridge** extension (it says the extension is unsigned); install it. polycli must be running for Cowork to reach it.

You manage the connection: open the Cowork task, open (or reopen) the Claude session in polycli, and approve the link. Cowork can't open, close or restart sessions; if the session it needs is closed, it asks you to reopen it.

**In a Cowork task**, ask for it in plain words, for example: *"Use the polycli tools: link this task to the acme-api workstream, then ask the main session to run the tests and tell me the result."*

1. **Link.** The task asks to link; the request opens as a dialog (and stays in the bar at the bottom if you choose **Later**). Pick the workstream and click **Link**, or **Reject**. Several requests can be rejected at once, or muted for 15 minutes. To skip the dialogs, tick **Accept Cowork requests automatically** (in the dialog, or in **⚙** settings): a link to a workstream the task names is made at once (polycli shows a short note), and its prompts are sent without asking, except one starting with /, !, # or @. A request without a workstream still asks.
2. **Prompts.** Each prompt the task wants to send appears in the bar, in full, with the target session. Click **Send** or **Reject**.

![A prompt from Cowork waiting for approval](cowork-approval.png)

3. **Delivery.** polycli types the prompt into the session when it is idle (never while you are typing in it), with a first line saying which Cowork task sent it. The tab shows **◇ From Cowork** while it runs, and the answer goes back to the task.
4. **Permission prompts** inside the session are still yours to answer in polycli; the Cowork task waits.

**Policies** (workstream **⚙ Settings**): prompts from Cowork can be sent without asking. Prompts that start with `!`, `/`, `#` or `@` always ask.

The **Cowork** panel of a workstream lists the linked tasks (with **Revoke**), the artifacts and documents they reported (**Open link**, **Show file**), and their recent prompts and answers.

### Messages back to the linked task

The bridge also works the other way. Ask a Claude session to send something to the linked Cowork or Claude Design task (a brief, a request, a result): it runs `node "$POLYCLI_POST" "<message>"`, and the task reads it with the `polycli_inbox` tool. Each linked task reads each message once; messages wait up to 7 days, so a task linked later still finds them. The workstream's **Cowork** dialog lists them as waiting or read. Sessions started before this version need a Restart to get the command, and the extension must be updated (**Install or update the extension…** in the Cowork dialog) for the task to get `polycli_inbox`.

## Install and update

Run **polycli-Setup-‹version›.exe**. It asks who to install for: **Only for me** (the default, no administrator rights, in `%LOCALAPPDATA%\Programs\polycli`) or all users (asks for administrator rights); you can pick another folder. It adds polycli to the Start menu and the desktop. To update, run the newer installer: it closes polycli first (your Claude sessions keep running and are reattached when polycli starts again; shells start again). Uninstall from **Settings → Apps**; your workstreams and settings in `%APPDATA%\polycli` are kept.

The installer isn't signed yet, so Windows SmartScreen may say "Windows protected your PC": click **More info**, then **Run anyway**. The zip (**polycli-‹version›-win-x64.zip**) is the same app without installing: unzip it anywhere and run `polycli.exe`.

polycli needs **Claude Code** (`claude`) and **Node.js 18 or newer** (`node`) on PATH; it says at startup if one is missing.

## Start with Windows

**⚙** in the top bar → **Start polycli when I sign in to Windows**. The Claude sessions that were open are reattached when polycli starts; after a restart of Windows they start again with their conversation. If you turned this on while running polycli from source, turn it off and on again in the installed polycli so Windows starts the installed one.

## Themes

The top-bar button cycles **System**, **Light** and **Dark**. System follows Windows.

![Light theme](light.png)

## Troubleshooting

- **"Trust needed"**: Claude Code hasn't trusted the folder yet. Answer its prompt in the tab, then type `/exit`; polycli starts the session.
- **"Detached"**: the tab lost its connection while the session kept running. polycli reconnects by itself; **Reattach** does it now.
- **No pop-up notifications**: Windows only shows them for an installed app (from the Start menu shortcut), and only when notifications are on in **Windows Settings → System → Notifications**. Otherwise the taskbar button flashes instead.
