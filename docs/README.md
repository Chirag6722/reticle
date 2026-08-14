# Docs index

Two audiences share this directory, which is why it looked like twenty-five unsorted files. Every page states its own audience in the first blockquote; this index is the shortcut.

Everything here is published to [docs.reticle.sh](https://docs.reticle.sh) by `docs.json`, which is the Mintlify config for this directory. User docs sit under the **Guides** and **Reference** tabs; contributor docs sit under **Contributing**, separated by tab rather than hidden — they were reachable by URL anyway, and an unlisted page is a page nobody finds.

---

## For people using Reticle

**Start:** [quickstart.mdx](quickstart.mdx) → [usage.md](usage.md) (the full tool reference).

| Page | What it answers |
| --- | --- |
| [quickstart.mdx](quickstart.mdx) | five minutes to a real verdict — every response on it was captured live |
| [why-reticle.mdx](why-reticle.mdx) | the false-green problem, the measured case, and where we lose |
| [install-agentic.mdx](install-agentic.mdx) | `npx reticle init` — what it writes and how to read its marks |
| [install-manual.mdx](install-manual.mdx) | wiring the MCP server and SDK by hand, per agent and framework |
| [getting-started.md](getting-started.md) | install it, connect an agent, verify something |
| [usage.md](usage.md) | every tool, every argument — the long-form reference |
| [predicates.mdx](predicates.mdx) | the predicate grammar, and which kinds actually prove something |
| [actions.mdx](actions.mdx) | every action and its arguments, including `press` and its history |
| [faq.mdx](faq.mdx) | production, frameworks, comparisons, and the honest limits |
| [tools-overview.mdx](tools-overview.mdx) | the 18 advertised tools, the 30 in the cold tail, and why |
| [tools-snapshot.mdx](tools-snapshot.mdx) | `reticle_snapshot` — three modes, from full tree to a 25-token route check |
| [tools-query.mdx](tools-query.mdx) | `reticle_query` — find elements by testing-library semantics |
| [tools-inspect.mdx](tools-inspect.mdx) | `reticle_inspect` — one element, down to source and design tokens |
| [tools-navigate.mdx](tools-navigate.mdx) | `reticle_navigate` — and why `ok` does not mean the page arrived |
| [tools-act.mdx](tools-act.mdx) | `reticle_act` — acts, proves nothing, and says so |
| [tools-act-and-wait.mdx](tools-act-and-wait.mdx) | `reticle_act_and_wait` — the tool that produces a verdict |
| [tools-act-sequence.mdx](tools-act-sequence.mdx) | `reticle_act_sequence` — batch a form into one round trip |
| [tools-observe.mdx](tools-observe.mdx) | `reticle_observe` — the whole timeline when you don't know what broke |
| [tools-network.mdx](tools-network.mdx) | `reticle_network` — the request log, redaction, and buffer honesty |
| [tools-console.mdx](tools-console.mdx) | `reticle_console` — and an empty result that proves it looked |
| [tools-state.mdx](tools-state.mdx) | `reticle_state` — what the app believes, not what it drew |
| [tools-wait-for.mdx](tools-wait-for.mdx) | `reticle_wait_for` — for consequences you did not cause |
| [tools-assert.mdx](tools-assert.mdx) | `reticle_assert` — verdicts, and a real failure explained |
| [tools-sessions.mdx](tools-sessions.mdx) | `reticle_sessions` — the health fields that decide if driving works |
| [tools-tools-and-run.mdx](tools-tools-and-run.mdx) | `reticle_tools` / `reticle_run` — reaching the other 30 |
| [tools-session-and-feedback.mdx](tools-session-and-feedback.mdx) | `reticle_session` / `reticle_feedback` — the human boundary |
| [packages.mdx](packages.mdx) | every library — what it does, why it exists, when you need it |
| [best-practices.mdx](best-practices.mdx) | the habits that make a verdict worth trusting |
| [skill-file.mdx](skill-file.mdx) | the paste-one-URL skill that teaches an agent Reticle |
| [agent-cheatsheet.md](agent-cheatsheet.md) | the condensed version an agent keeps in context |
| [for-agents.md](for-agents.md) | how to fetch these docs as Markdown or `llms.txt` |
| [architecture.md](architecture.md) | how it works, and why it is built this way |
| [platform-integration.md](platform-integration.md) | Vite, Next, Remix, Astro, plain HTML |
| [desktop-apps.md](desktop-apps.md) | Electron and Tauri |
| [instrumentation.mdx](instrumentation.mdx) | stores, signals, testids — how verdicts get stronger |
| [cli.mdx](cli.mdx) | every `reticle` command, with real output and measured exit codes |
| [integration-patterns.md](integration-patterns.md) | wiring it into a real codebase |
| [flows.md](flows.md) | record → save → replay → heal |
| [testing.md](testing.md) | `@reticlehq/test` — turning a session into a CI suite |
| [multi-agent-testing.md](multi-agent-testing.md) | more than one agent on one app |
| [human-control.md](human-control.md) | taking the wheel back from the agent |
| [deploy-checks.md](deploy-checks.md) | running Reticle against a deployed build |
| [token-efficiency.md](token-efficiency.md) | why it costs less than a screenshot loop |
| [benchmarks.md](benchmarks.md) | how the numbers were measured, including where Reticle loses |
| [vs-playwright-mcp.mdx](vs-playwright-mcp.mdx) | outside-in vs inside-out, and when Playwright is right |
| [vs-chrome-devtools-mcp.mdx](vs-chrome-devtools-mcp.mdx) | cheaper per look, catches less — the trade, measured |
| [vs-screenshots.mdx](vs-screenshots.mdx) | why a better vision model does not fix a non-visual bug |
| [telemetry.md](telemetry.md) | what is collected, and how to turn it off |
| [local-registry.md](local-registry.md) | installing an unpublished build |
| [enterprise.md](enterprise.md) | the licensed surface |

## For people working on Reticle

**Start:** [`CONTRIBUTING.md`](../CONTRIBUTING.md) → [gates.md](gates.md).

| Page | What it answers |
| --- | --- |
| [gates.md](gates.md) | **I changed some files — which gate do I run?** |
| [gate-plan.md](gate-plan.md) | why the gates are shaped this way, and what is still unbuilt |
| [system-map.md](system-map.md) | how a tool call reaches the app, and which failures are silent |
| [telemetry-contract.md](telemetry-contract.md) | required reading before touching anything that emits |
| [debugging.md](debugging.md) | debugging Reticle itself — the four signals and what each answers |
| [fixtures.md](fixtures.md) | the sibling `reticle-fixtures` repo: install complexity, not regressions |
| [matrix/README.md](matrix/README.md) | submitting an MCP-client compatibility record — the best first contribution |
| [matrix/MATRIX.md](matrix/MATRIX.md) | which clients are known to work (generated; do not hand-edit) |
| [`../apps/README.md`](../apps/README.md) | what belongs in `apps/`, and what does not |
| [`../apps/e2e/harness-rules.md`](../apps/e2e/harness-rules.md) | the four rules every gate obeys, and the incident behind each |
| [`../bench/README.md`](../bench/README.md) | what in `bench/` is live and what is a kept one-off study |

`fixtures-dispatch-receiver.yml` is not a doc — it is the workflow template `reticle-fixtures` needs, kept in this repo so the two ends of the contract cannot drift apart.

---

**Adding a page?** Three things, all required. Give it `title` + `description` frontmatter and no `# H1` — Mintlify renders the frontmatter title as the heading, so an H1 shows up twice. Add its slug to the right tab in `docs.json`. Add a row to the right table above. A page missing from `docs.json` is one nobody can reach; a page missing from this index is one no contributor knows exists.

**Adding a second product?** Do not nest these files under a product folder pre-emptively — that renames every live URL to buy nothing. Mintlify supports `navigation.products`, where each product declares its own `directory`. When the second product exists, put its pages in `docs/<product>/`, switch `docs.json` from `tabs` to `products`, and give this product `"directory": ""` so today's URLs keep working.
