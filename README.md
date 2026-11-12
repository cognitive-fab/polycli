# polycli

A Windows terminal for Claude Code workstreams. It groups Claude Code CLI sessions and shells by workstream, shows each session's version, model, effort, plan and folder, and keeps sessions alive across app restarts. A Cowork ↔ CLI bridge lets a Cowork task you link send prompts to a session and read the answers, and lets a session send messages back.

What it does, in short:

- **Workstreams** with Claude sessions (Remote Control on, so you can continue on claude.ai or your phone), PowerShell, **WSL** and **SSH** shells, and Mistral Vibe.
- **Pinned shells** that start a command (a server) whenever polycli starts, optionally after another shell is ready.
- **One, two or four panes**; a bar at the bottom lists what needs you, and ✋ marks a session asking you a question.
- Per workstream: a **Board** (Kanban, each card with its own Claude chat that writes specs), **Architecture** diagrams (archlens), **Docs** (Markdown preview and edit) and **Tests** (run test and check scripts, see the numbers).
- Git line with Commit / Push / Deploy, time and tokens per workstream, selections that scroll Claude's transcript.

What changed in each version: [`CHANGELOG.md`](CHANGELOG.md).

**Install.** Run `polycli-Setup-‹version›.exe` (built with `npm run dist` in `app/`, see [`app/README.md`](app/README.md#build-the-installer)). It installs for your user only, without administrator rights, and adds Start menu and desktop shortcuts; running a newer installer updates polycli in place, and uninstalling keeps your workstreams. The installer isn't signed yet, so SmartScreen may warn: **More info** → **Run anyway**. polycli needs Claude Code (`claude`) and Node.js 18 or newer (`node`) on PATH, and tells you at startup if one is missing.

- [Help](app/resources/help/HELP.md) explains how to use it, with screenshots (also under **? Help** in the app).
- [`DESIGN.md`](DESIGN.md) is the design (source of truth).
- [`app/`](app/) is the Electron app (Phase 1). See [`app/README.md`](app/README.md) to run it.
- [`spikes/`](spikes/) holds the Phase 0 experiments and their results.

**Mistral Vibe (optional).** **+ Mistral** opens the `vibe` CLI in a tab. Run `vibe --setup` once in a polycli shell first: it asks for your Mistral API key and saves it for Vibe. Setting `MISTRAL_API_KEY` in a workstream's environment variables is not enough on its own, because a key Vibe saved earlier (for example from `/login`) may take priority, and a Le Chat subscription may not include API access, so the key should come from the Mistral console. If Vibe answers "Invalid API key", run `vibe --setup` again. Searching the project from Vibe also needs ripgrep (`winget install BurntSushi.ripgrep.MSVC`).

Status: early, Windows only.
