# Roadmap

Direction, not dates. What actually shipped is in the [CHANGELOG](./CHANGELOG.md); how it ships is in [RELEASING](./RELEASING.md). Priorities shift with what users hit — open an issue to push on any of these.

Each item below has a **tracking issue** labelled `roadmap`: that's where the design gets argued and where you say "I'll take this". Anything unclaimed is genuinely up for grabs — comment before you start so two people don't build it twice. Live discussion happens in [Discord](https://discord.gg/BwAbzv9ZRz) `#roadmap`.

## Guiding bet

Reticle's edge is seeing the **program**, not the pixels — app state, signals, request cardinality, swallowed errors — the bug classes a DOM/screenshot tool structurally can't catch. Everything below serves making that catch more reliable, cheaper, and easier to adopt.

## Near-term

- **Zero-install tier.** Drive any React app over CDP with no SDK installed — component state, network, and console at parity with the read everyone benchmarks — as the on-ramp, with the SDK as the upsell for signals, named stores, and `file:line`. (The fiber reader already works; the remaining piece is a boundary decision on where the CDP-injected reader lives.)
- **More framework state adapters.** Broaden first-class `reticle_state` support across the stores React and Next apps actually use.
- **Sharper diagnosis.** Keep tightening the failure capsule — first-divergence + blast radius + the exact `file:line` — since the measured win is fewer agent tool-calls to a fix, not just detection.

## Ongoing

- **Verifier honesty.** The standing invariant: a green never rests on evidence it doesn't have. New false-green classes get fixed as they're found, each with a regression guard.
- **Cost & scale.** Keep the per-call token cost flat as apps grow, and the SDK overhead under budget on large DOMs and long sessions.
- **OSS health.** Externally-verifiable security posture, clean packaging, and docs that get a new user to first success fast.

## Enterprise (source-available)

SSO/SAML, SCIM, RBAC, audit logs, and verify-before-merge policy gates live under `packages/server/ee/`, source-available and free for development/evaluation, unlocked in production by a license key. The core verification engine stays free forever.

## Not planned

- Turning Reticle into a general browser-automation framework — it gates _edits_ inside the agent loop; Playwright gates _releases_, and the honest recommendation is to use both.
- Any telemetry or phone-home. It runs on your machine, in your infra, and stays that way.
