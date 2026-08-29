# Experiment: onboarding in one shell call

**Question:** the SKILL.md install takes ≥20 minutes and we cannot say whether it works. Where does the time actually go, and how much of it is removable?

**Claim under test:** almost none of the 20 minutes is compute. It is ~15 serialised model turns (run, read the report, decide, run again) plus one human round trip for the MCP client restart. Collapsing the turns into one shell call and deleting the restart should land the same verdict in a fraction of the time, with the same honesty gates.

## What the script changes

| SKILL.md | Here |
| --- | --- |
| ~15 agent turns, each a full model round trip | 1 call |
| npx download, then detection, serially | prefetch runs while `package.json` is read |
| "ask the user to restart their client, then say 'continue'" | the drive runs in a fresh `claude -p`, which reads the MCP list at ITS startup |
| stale dev server diagnosed after the empty-session list | restarted before the tab is opened |

The restart is the interesting one. A client reads its MCP server list once, at startup, and nothing inside the process can reload it — so a switch is a restart, and only whatever launched the process can perform one (the mechanism in `mac-setup/claude/plugin/scripts/handoff.sh`: write a handoff file, SIGTERM `$CLAUDE_PID`, and the supervisor relaunches with `--resume $CLAUDE_CODE_SESSION_ID`). But onboarding does not need the calling session to have the tools — it needs _a_ process that has them. A child `claude -p` is that process, and it costs no human round trip at all. `--relaunch` still offers the real restart (supervisor handoff when `CL_RUN` is set, else a new terminal window on `--resume`), for the session's own later use.

## Honesty gates kept, deliberately

Speed is worthless if it buys a false green — the verdict IS the product.

- No `.reticle.json` after init ⇒ hard stop, not "installed".
- Every `⚠`/`ℹ` line from init is surfaced as an `AGENT:` line, not swallowed.
- The session must match the app's own URL, not merely exist (`pick-session.mjs`) — a daemon usually has other tabs on it, and passing on one of those is exactly the false green.
- No session in 60s ⇒ exit 1 with the troubleshooting order, never a pass.
- The drive still ends in `reticle_act_and_wait`; the script does not invent a verdict.

## Run

```bash
bash experiments/onboarding/onboard.sh            # in the target project's root
bash experiments/onboarding/onboard.test.sh       # the gates, no network
```

Flags: `--app <dir>` (monorepo), `--url <url>` (dev server already yours), `--no-restart-dev`, `--no-drive`, `--relaunch`.

## Measuring it

The script prints a `TIMING:` block per phase. To answer the original question, run it against a pristine scaffold (`npm create vite`, `create-next-app`) and compare with an agent doing SKILL.md by hand on the same scaffold — wall clock **and** whether step 5 produced a verdict. `pnpm gate:install` already scaffolds those three apps; that is where this belongs if it survives.

Not measured yet. Nothing here should ship on the strength of the design alone.
