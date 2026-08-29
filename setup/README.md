# setup — onboarding in one call

`reticle.sh` installs Reticle into a project and does not stop until the user has **watched their own app being driven to a verdict**. That last part is the product; everything before it is plumbing.

```bash
./setup/reticle.sh                  # in the target project's root
node setup/reticle.mjs              # same thing, and the only form that works on Windows
```

`reticle.sh` is a launcher; `reticle.mjs` is the implementation. The split is deliberate: a `.sh` file cannot run on a stock Windows box (no `sh` without Git Bash or WSL), Windows is most of Reticle's users, and a `.sh` + `.ps1` pair drifts the first time somebody fixes a bug in one of them. Node is not an extra dependency to justify — it is the runtime every user of a JS SDK already has.

## Why it exists

Measured against an agent following SKILL.md by hand, across five real apps:

|                        | by hand    | one call                             |
| ---------------------- | ---------- | ------------------------------------ |
| cost                   | **$9.92**  | one child agent, or free on a re-run |
| model turns            | **176**    | 1                                    |
| wall clock             | **40 min** | ~1.5–5 min per app                   |
| produced a verdict     | **2 of 5** | see below                            |
| stopped to ask a human | **3 of 5** | never                                |

Almost none of the hand-driven time is compute. It is serialised model turns — run, read the report, decide, run again — plus one human round trip for an MCP client restart. Three of the five runs ended by asking someone to restart their client, having produced nothing to look at.

## The restart, and why the drive happens in a child process

A client reads its MCP server list once, at startup, and cannot reload it. That is not a Claude Code quirk: Gemini's `/mcp reload` re-discovers from the map built at startup and does **not** re-read `settings.json`, so a newly added server needs a full restart there too. Only whatever launched the process can perform one, and only if it is still waiting.

But onboarding does not need the CALLER to have the tools — it needs _a_ process that has them. A child agent spawned after `init` reads the list `init` just wrote. No human round trip, no resume, no lost context. The caller gets its tools whenever it next starts, and by then the verdict already exists.

Auto-restarting the caller is deliberately NOT attempted. Resuming its conversation needs its session id, and most CLIs do not tell a child what it is — Gemini exports `GEMINI_CLI=1` and nothing else, so there it is impossible rather than unimplemented. A guessed relaunch opens an EMPTY session that looks exactly like success, which is the failure this whole script exists to prevent.

## Flags

| flag               | for                                                                |
| ------------------ | ------------------------------------------------------------------ |
| `--app <dir>`      | monorepo: which app to wire. Usually unnecessary — see below       |
| `--url <url>`      | the app is already served here; do not start a dev server          |
| `--dev-cmd <cmd>`  | when the dev command is not `<pm> run dev`                         |
| `--port <n>`       | the **bridge** port (4400), never the dev server's                 |
| `--license <key>`  | writes `RETICLE_LICENSE_KEY` to `.env`, and `.env` to `.gitignore` |
| `--no-open`        | do not open a tab: CI, headless, or one you already have           |
| `--no-drive`       | stop once a session connects; leave the verdict to the caller      |
| `--no-restart-dev` | do not restart a dev server that predates `init`                   |
| `--json`           | one object on stdout, human progress on stderr                     |
| `--timeout <s>`    | per-phase budget (default 120)                                     |
| `--relaunch`       | attempt the caller restart where a supervisor makes it possible    |

`--json` is the one that matters to an agent: stdout carries what was wired, what connected, the verdict, and an **`agentTodo`** array. Reading one object is one turn; interpreting a report is several, and turns are the actual cost.

## What it does that a report-reader does not

- **Picks the app in a monorepo.** `init` will wire a monorepo ROOT — writing config into a directory nothing serves — and leave a `⚠` that reads like framework detection failing. Setup asks the only question that matters (_is there a dev command where I am pointed?_) and, if not, discovers workspace apps and re-runs `init --app` on the one that can be served.
- **Restarts a stale dev server.** One started before `init` edited the build config keeps serving the old bundle: the wiring is correct and nothing connects, 100% of the time.
- **Waits for the server to actually serve.** A URL in a log is an announcement, not readiness — Next prints `- Local: …` before it can answer, and opening a tab then gives you a 404 and a 180-second wait blamed on the SDK.
- **Drives the tab a human is looking at.** A daemon accumulates sessions; taking the first URL match drove whichever it listed first, usually the oldest, while the HUD played to an empty room.
- **Finishes the capabilities file** when the session reports `hasCapabilities:false`, before driving — otherwise `reticle_state` returns nothing and every verdict rests on the DOM alone.
- **Replays instead of re-driving** once a flow is saved. The first drive is a model choosing what to prove (~70% of wall clock). Every one after it is `reticle verify`: deterministic, no model.

## Registering with the other agents

`init` registers the MCP server with eight clients, and only where it already finds them. That left a real hole: VS Code's **user-scope** `mcp.json` exists on machines today and init only ever writes the project-scope `.vscode/mcp.json`, so a VS Code user has no tools outside the directory they ran init in. Zed, Warp, Kiro, Amp, Copilot CLI, Amazon Q, Factory Droid, Cline and Roo were not covered at all.

`agents.mjs` adds twelve more, under one rule:

- **A documented path is written even when the agent is absent**, so a later install is already wired. That is the "future installs" case.
- **A path that cannot be evidenced is refused.** Cline's and Roo's live under VS Code globalStorage, which moves under Insiders, portable installs and a custom `--user-data-dir` — so they are written only where the host's standard layout is actually present. A config file at a guessed location is one nobody reads, which looks exactly like success.
- **Formats that cannot be merged safely are never rewritten** — TOML, an existing YAML, JSONC carrying comments. The snippet is printed instead. Reformatting somebody's config to add one entry is not ours to do.

Keys are per-client and getting one wrong writes a file the client silently ignores: Zed wants `context_servers`, Amp wants a dotted top-level `amp.mcpServers`, VS Code wants `servers`, and Continue's is a YAML _list_ whose items carry a `name`. Eighteen tests run the planner against a pretend filesystem for all three platforms, which is also the only way the Windows rows get checked.

The `/reticle` skill goes to the agents with a documented skills directory — Zed's `~/.agents/skills/`, Kiro's `~/.kiro/steering/` — and only when they are installed, because scaffolding a skills tree for absent software is litter.

## Restarting the caller

`claude-supervised.sh` launches Claude Code in a loop so that `reticle.sh --relaunch` can restart it and resume the same conversation. It exists because a client reads its MCP server list ONCE, at startup, and nothing inside the process can make it re-read that — Gemini's `/mcp reload` re-discovers from the map built at startup and does not re-read `settings.json` either, so this is structural rather than one client's quirk. Only whatever launched the process can restart it.

**You do not need this to onboard.** The verdict comes from a child agent that reads the MCP list at its own startup, so the caller gets its tools whenever it next starts anyway. The supervisor only removes the wait.

It refuses to resume a session id with no transcript behind it. That is the failure that looks like success: `--resume` on an unknown id opens an EMPTY conversation under that id, with no error anywhere.

## How long it actually takes

Measured on a pristine `npm create vite` app. The drive is a model, so it is most of the clock and it varies a great deal — 19 to 49 turns for the same trivial counter app.

|                                | time                       |
| ------------------------------ | -------------------------- |
| install + connect (no model)   | **13-28s**                 |
| first install, drive included  | **111-252s, median ~213s** |
| re-run, replaying a saved flow | **~20s, no model at all**  |

A faster `--drive-model` reaches the same `verified: "yes"` about three times quicker, and leaves a weaker artifact: `assertion-free` or `presence-only` flows in three runs of four. Those only ACT, so they pass even when the feature is broken — and since a re-run REPLAYS the saved flow, a weak one becomes a permanent green. Setup therefore re-records once with the stronger model when the grade comes back weak. Across four runs that produced `asserted` every time, and cost back most of the speed: the escalated runs land at 220-252s.

`--flow` roughly doubles the chance the fast model gets there first try (2 of 4 against about 1 of 4), because the turns go into FINDING a journey and naming one removes that search. It does not reliably buy the target: the best run was 111s and the median was still ~213s. One good sample is not a result, which is the whole reason these numbers are stated at n=4 rather than n=1.

**So: sub-30s is real for re-runs and not honest for a first install.** The only way to a fast first install is to skip the drive, and a setup that reports success without a verdict is the false green this entire script exists to prevent.

## The gates

```bash
node setup/reticle.test.mjs     # the unit gates, no network, no browser
node setup/break-matrix.mjs     # 16 environments built to break it
```

`break-matrix.mjs` is the negative control, and it is the more important of the two. A setup script is judged by its failures: the success path has one shape, and the failure paths are where users live. Every scenario asserts four things, and the last two are the ones that bite:

1. it exits non-zero — never a green install for a broken machine
2. **no raw stack trace reaches the user** — `TypeError: fetch is not defined` is not a message
3. **the output names THAT cause** — "no session appeared" sends an agent to re-run `init`, the one action that cannot help
4. `ok` is false in `--json`

Covered: Node missing, Node too old, malformed `package.json`, no dev script, a read-only checkout, an unreachable npm registry, a stranger on the bridge port, a monorepo with several apps, a dev server that exits / never prints a URL / serves HTTPS with a self-signed certificate, no browser to open, an agent CLI that is on PATH and broken, a package manager the lockfile names but the machine lacks, a corrupt `.reticle.json`, and a re-run over an existing install.

Three of those scenarios have passed **for the wrong reason** at some point — a fake old-Node shim that delegated the version probe to the real Node, an assertion checking a stale error string, and a TLS scenario with no TLS server in it. A negative control that passes for the wrong reason is worse than no control, which is why the assertions are cause-specific strings rather than exit codes.

## Testing against real apps

`reticle-fixtures/scripts/setup-run.mjs` installs into somebody else's real applications and records phase timings, `connected`, `visible`, `hasCapabilities`, `flowSaved`, and every `agentTodo`.

Two things it must get right or it measures itself instead of the product:

- **Clone `node_modules`, never symlink it.** Turbopack rejects a symlink pointing outside the project root, so the Next fixtures died at boot and it read like a broken install.
- **`visible` reads false here and that is the harness.** macOS Chrome reports a fully occluded window as hidden, and in an automated run the terminal is frontmost throughout. A human running setup gets the browser brought to the front. Do not "fix" the script for that row.

## Known debt

`pick-session.mjs` and `reticle.mjs`'s `pickSession` are two copies of the rule that stops a stray tab passing for your install. That rule is a false-green guard and should be one module with one test.

## Finishing the validation

Three things are not yet proven, and two of them are blocked on machine state rather than on work. They are written out here so that finishing them is a command, not an investigation.

### 1. The full fixture suite, on a machine with free memory

```bash
cd ../reticle-fixtures && node scripts/setup-run.mjs          # all 9 apps
```

Six of nine reached the AHA moment on the last complete pass. The other three failed for causes that were each identified and are not the script: two were environmental (an uninstrumented control failed identically), one was a defect since fixed and confirmed on its app.

**Check swap before trusting a run.** `sysctl vm.swapusage` — this suite was measured on a machine down to 1.2 GB free, and macOS jetsam SIGKILLed setup mid-run at the moment it launched a browser. The runs that die produce zero-byte result files and look exactly like a broken script; three runs were discarded that way. Turbopack falls over first, with `EMFILE: too many open files` surfacing as the alarming and entirely misleading `The directory at .next/dev was deleted`.

### 2. The drive model, and the artifact it leaves

```bash
node scripts/setup-run.mjs --only astro-nanostores --drive-model sonnet
```

Measured on a pristine `npm create vite` app: the default model takes ~183-200s and saves a flow graded `asserted`; a faster model takes 70-87s (3x) and saved `assertion-free` or `presence-only` flows in three runs out of four. Both produce a live verdict of `yes` — the difference is entirely in what gets left behind, and since setup REPLAYS saved flows on every later run, a weak one becomes a permanent green that proves nothing.

Setup now reads the grade and says so, so the trade is visible rather than silent. What is not yet known is whether the weak grade is the model being lazy or the recording path not capturing an `until` that demonstrably fired live — one run's own report described asserting the text changed, and the saved flow still graded `presence-only`. That is worth a `reticle_feedback` if it reproduces.

### 3. Windows

`.github/workflows/setup-gates.yml` runs the pure parsing and the early refusals on `windows-latest`, which is what actually EXECUTES `where`, `netstat` and the Node-version guard. Still unexecuted anywhere: `taskkill` teardown and `npx.cmd` spawning, because both need a dev server running on Windows. The break matrix is POSIX-only by construction — its scenarios build fake `node`/`npx`/`claude` shims as `/bin/sh` scripts — so its count says nothing about Windows, and the workflow is explicit about that rather than quietly running fewer tests.
