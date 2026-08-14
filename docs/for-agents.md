---
title: Docs for agents
description: Fetch any page as plain Markdown, pull the whole site as one file, or hand a page straight to your agent.
icon: robot
---

These docs are built to be read by a program, not just a person. Nothing here needs an API key, a scraper, or an HTML parser — every page has a plain-text form at a predictable URL.

The site lives at **`https://docs.reticle.sh`**.

## Fetch one page

Append `.md` to any documentation URL and you get the source Markdown, with the page's frontmatter and no site chrome:

```bash
curl https://docs.reticle.sh/getting-started.md
curl https://docs.reticle.sh/agent-cheatsheet.md
curl https://docs.reticle.sh/usage.md
```

The slug is the filename in [`docs/`](https://github.com/reticlehq/reticle/tree/main/docs) — so `docs/token-efficiency.md` in the repo is `/token-efficiency` on the site and `/token-efficiency.md` as raw text.

## Fetch the index, or everything

| URL | What it is | Use it when |
| --- | --- | --- |
| [`/llms.txt`](https://docs.reticle.sh/llms.txt) | Every page title and URL, ~2 KB | You want to pick the right page before spending tokens on it |
| [`/llms-full.txt`](https://docs.reticle.sh/llms-full.txt) | The entire documentation as one file | You are seeding a context window or an index once |

Start with `llms.txt`. It is small enough to read in full and tells you which single page answers the question — which is almost always cheaper than pulling `llms-full.txt`.

## Pull a page into your harness

Every page has a menu in its top-right corner: copy the page as Markdown, or open it directly in Claude, ChatGPT, Cursor or VS Code with the source already attached. That is the fastest route when a human is driving and wants the agent to have the page.

> None of this is Reticle itself. These endpoints serve the **documentation**. Reticle runs on your machine and verifies your app — you get it with `npx reticle init`. See [Getting started](/getting-started).

## Which page to read

You rarely need more than one.

| You want to | Read |
| --- | --- |
| Install Reticle and get a first verdict | [Getting started](/getting-started) |
| Get fluent in one screen | [Agent cheat sheet](/agent-cheatsheet) |
| Look up a specific tool, flag, or workflow | [Complete usage guide](/usage) |
| Understand what Reticle is doing under the hood | [Architecture](/architecture) |
| Wire it into a desktop app | [Desktop apps](/desktop-apps) |
| Make the checks repeatable in CI | [Specs for CI](/testing) |
| Work on Reticle itself | [Gates](/gates), then [System map](/system-map) |
