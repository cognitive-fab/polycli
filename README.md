# polycli

A Windows terminal for Claude Code workstreams. It groups Claude Code CLI sessions and shells by workstream, shows each session's version, model, effort, plan and folder, and keeps sessions alive across app restarts. A Cowork ↔ CLI bridge lets a Cowork task you link send prompts to a session and read the answers.

- [Help](app/resources/help/HELP.md) explains how to use it, with screenshots (also under **? Help** in the app).
- [`DESIGN.md`](DESIGN.md) is the design (source of truth).
- [`app/`](app/) is the Electron app (Phase 1). See [`app/README.md`](app/README.md) to run it.
- [`spikes/`](spikes/) holds the Phase 0 experiments and their results.

**Mistral Vibe (optional).** **+ Mistral** opens the `vibe` CLI in a tab. Run `vibe --setup` once in a polycli shell first: it asks for your Mistral API key and saves it for Vibe. Setting `MISTRAL_API_KEY` in a workstream's environment variables is not enough on its own, because a key Vibe saved earlier (for example from `/login`) may take priority, and a Le Chat subscription may not include API access, so the key should come from the Mistral console. If Vibe answers "Invalid API key", run `vibe --setup` again. Searching the project from Vibe also needs ripgrep (`winget install BurntSushi.ripgrep.MSVC`).

Status: early, Windows only.
