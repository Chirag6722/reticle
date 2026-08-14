---
title: Desktop apps
description: 'Verify Electron and Tauri apps from inside, over a localhost WebSocket — no browser to open, no screenshot to interpret.'
icon: display
---

Reticle verifies desktop apps the same way it verifies web apps — from **inside** the app, over a localhost WebSocket. There is no browser to open and no screenshot to interpret.

- [How you actually test a desktop app](#how-you-actually-test-a-desktop-app)
- [Electron](#electron)
- [Tauri](#tauri)
- [What IPC looks like to an agent](#what-ipc-looks-like-to-an-agent)
- [Troubleshooting](#troubleshooting)

---

## How you actually test a desktop app

The usual question is _"it's a desktop app — what URL does the agent open?"_ None. The direction is reversed from what browser tooling trains you to expect:

```text
┌──────────────┐   MCP     ┌───────────────────┐   WebSocket    ┌───────────────────────┐
│ coding agent │◀────────▶│  reticle daemon    │◀──────────────▶│ your Electron/Tauri   │
│              │  stdio   │  (localhost:4400)  │   the app      │ window + the SDK      │
└──────────────┘          └───────────────────┘   dials OUT    └───────────────────────┘
```

Your app **connects to the daemon**, not the other way round. So the workflow is:

1. Start the daemon once: `npx @reticlehq/server serve`
2. Start your app exactly as you always do: `npm run dev`, `electron .`, `cargo tauri dev`.
3. That's it. `reticle status` now lists your window as a session, and the agent drives it.

`reticle open` has nothing to open for a desktop app and will say so, and there is no `reticle drive` for desktop — those launch a browser, which is not what you are testing. Headless works on both runtimes; see below.

## What works, measured

Every tool below was run against both demo apps against a live daemon.

The rows in **bold** are the ones a committed battery re-proves on every change — `pnpm test:e2e:desktop`, which starts a real Electron main process and a **packaged** Tauri binary (`tauri://localhost`, not `tauri dev`) and drives them headless. The rest were measured by hand. That distinction matters: this table used to report a hand-run score with nothing in the repo that reproduced it, so it could go stale without anything failing.

| Capability | Electron | Tauri | Note |
| --- | --- | --- | --- |
| sessions, snapshot, query, inspect | ✅ | ✅ | `inspect` returns `src/App.tsx:104` in a dev build; a packaged production renderer has no source map, so it reports `n/a` |
| capabilities, state (live store) | ✅ | ✅ | `reticle_state` reads the real store |
| act (click/fill/type/select) | ✅ | ✅ |  |
| **act_and_wait, wait_for, assert** | ✅ | ✅ | signal / state / route / net / console predicates |
| console errors | ✅ | ✅ | catches what the UI never shows |
| network — HTTP | ✅ | ✅ | on `file://` a relative URL has no origin; use an absolute one |
| **network — IPC** | ✅ | ✅ | `ipc://<channel>`, incl. failures. Electron: `invoke` and `sendSync` carry a verdict; a one-way `send` is recorded as `oneWay: true` with NO status, because the renderer never learns the outcome. Tauri: both the `ipc://` (macOS/Linux) and `http://ipc.localhost` (Windows) transports |
| route | ✅ | ✅ | use a **hash** router — see below |
| storage, animations, observe, explore | ✅ | ✅ |  |
| baseline (semantic), record → replay, crawl | ✅ | ✅ | `crawl` found real anomalies in both |
| navigate (reload) | ✅ | ✅ |  |
| **screenshot / visual_diff** | ✅ | ✅ | one line in Electron's main process; one Rust command in Tauri — see below. Reticle's own presenter panel is hidden for the shot, so a baseline records your app and not the instrument |
| **drivable while window occluded** | ✅ | ✅ | including minimized, app-hidden, and behind a fullscreen app on another Space |
| **headless** | ✅ | ✅ | Electron never shows the window; Tauri shows, loads, then hides |
| **a missing preload is DECLARED, not silent** | ✅ | n/a | without `@reticlehq/electron/preload` every IPC call is invisible, so verdicts carry `coverage: partial` naming the missing line instead of reading clean |
| network_mock, viewport | ❌ | ❌ | need a Reticle-driven browser |

### Screenshots

**Electron: one line in the main process.**

```js
const { installReticleCapture } = require('@reticlehq/electron/main');
const win = new BrowserWindow({ ... });
installReticleCapture(win);
```

That is all — no CDP flag, no extra packages, works on a packaged `file://` renderer. `reticle_screenshot` and `reticle_visual_diff` then work on your app.

Alternatively, since an Electron renderer _is_ Chromium, `--remote-debugging-port=9222` + `RETICLE_CDP_URL=http://127.0.0.1:9222` also works and additionally enables `fullPage` (the main-process route captures the window as composited, so it cannot scroll-stitch).

**Why the main process, and not a screen capture.** `webContents.capturePage()` reads the window's own backing store. Capturing a screen _region_ instead was tried and deliberately rejected: it photographs whatever is on top, so an app window behind your editor yields a picture of the editor — saved as a visual baseline that a later diff would trust. A screenshot tool that can silently return another window's pixels manufactures exactly the false green Reticle exists to eliminate. One caveat remains: a fully occluded or minimized window is only partially composited, so parts of the capture may come back blank. Bring the window forward for a complete image — but it is never the wrong window.

**Tauri: one Rust command.**

```rust
tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![reticle_tauri::reticle_capture])
    .on_page_load(reticle_tauri::on_page_load)
```

Nothing on the JavaScript side: the SDK invokes the command through Tauri's own internals, because Tauri has no preload stage where a shim could be installed. `reticle_screenshot` and `reticle_visual_diff` then work on your app, including headless.

`reticle_capture` renders the webview rather than reading the screen — like Electron's `capturePage()` — so it needs no screen-recording permission, cannot return another window's pixels, and is correct with nothing on screen at all. Each platform uses its own webview API:

| Platform | API | Status |
| --- | --- | --- |
| macOS | `WKWebView.takeSnapshot` | Verified against a running app |
| Linux, BSD | WebKitGTK `webkit_web_view_get_snapshot` | Snapshot + PNG encoding verified under `xvfb`; not yet driven through a full Tauri app |
| Windows | WebView2 `CapturePreview` | **Untested — compiles, never executed** |

The Windows path is written and type-checked against the real `webview2-com` API (which caught two genuine type errors), but nobody has run it on Windows. CI now re-checks it against that target on every PR (`cargo check --target x86_64-pc-windows-msvc`), so "compiles" is a gate rather than a claim — it had been asserted for months by a workflow comment while no such job existed. Executed is still a different word from compiled: it is shipped rather than withheld so it can be tried, and labelled rather than listed flatly so that trying it is a choice. If it works for you, say so and this row changes; treat a green from it as unconfirmed until then.

All three capture the visible viewport by default, so a baseline taken on a developer's Mac is comparable against the same app in Linux CI. On a platform with no webview API to call, capture reports no-provider rather than returning a plausible wrong image.

**`{ fullPage: true }` works on Tauri/Linux only.** WebKitGTK can render the whole document offscreen; `takeSnapshot` (macOS) and `CapturePreview` (Windows) only give what is composited, and Electron's `capturePage()` is the same. Asked for a full page they cannot produce, all of them return `{ ok:false, reason:'full-page-unsupported' }` rather than quietly handing back the viewport — a baseline that omits everything below the fold, while every later diff of it reports green about a region that was never captured. No baseline is written on a refusal.

An app that already has its own capture can expose `window.__reticleIpc.capture()` returning a PNG path instead; the SDK prefers it over the built-in command.

### A correction: the Tauri macOS "liveness constraint" was wrong

Earlier versions of this document said a Tauri app on macOS is only drivable while its window is on the active Space and unoccluded, and that hiding it suspends the webview. **That is not true, and the mistake is worth recording because it cost three features.**

Re-measured against the live app, a loaded Tauri webview answers Reticle commands at full speed while: minimized, app-hidden with Cmd-H, fully occluded, on another Space behind a fullscreen app, and with no window on screen at all. A full 43-tool drive passes in every one of those states.

What actually failed was narrower: **a webview that has never been presented never loads its page.** Every "suspension" experiment hid or moved the window from `setup`, i.e. before the first present, so the page never ran and every command timed out at 8s. The timeouts were real; the diagnosis was not. The `alwaysOnTop` workaround was then built to fix a problem that did not exist, measured as "still broken" for the same reason, and deleted.

The lesson generalises past this document: four experiments agreeing does not make a conclusion controlled, if all four share the same confound.

### Headless

**Electron: yes.** `show: false` plus `backgroundThrottling: false` in `webPreferences`. The second one is load-bearing — Chromium runs an unshown window's timers in slow motion, which turns every settle wait into a flake. Screenshots still work, because `capturePage` reads the backing store rather than the screen. Verified with a full tool drive against a window that was never shown.

**Tauri: yes — show, load, then hide.**

```rust
.on_page_load(reticle_tauri::on_page_load)   // hides the window when RETICLE_HEADLESS=1
```

Run with `RETICLE_HEADLESS=1 pnpm tauri dev`. Nothing ends up on screen, and screenshots keep working because the capture renders the webview rather than the screen.

The ordering is the whole trick. Hiding the window during `setup` hides it before the webview has ever been presented, and a webview that has never been presented never loads its page — which is what made headless Tauri look impossible. Hiding it after its first page load leaves everything running. Verified with a full 43-tool drive plus a screenshot and a visual diff against a window that is not on screen.

`xvfb-run -a pnpm tauri dev` also works on Linux and needs no app-side change at all.

### How it compares to Playwright MCP

Both attached to the same running Electron app, same task ("archive a todo, then verify it worked"):

| tool                   | ~tokens | ms      | verdict                                    |
| ---------------------- | ------- | ------- | ------------------------------------------ |
| reticle (lean)         | **350** | 1364    | caught the failure                         |
| playwright-mcp         | 1069    | **980** | blind to it — no network/IPC in its output |
| playwright-mcp → Tauri | —       | —       | cannot attach (no CDP in WKWebView)        |

Playwright MCP is faster. It is also structurally unable to see an IPC failure, because its channel is the accessibility tree. Full method, numbers and caveats: [`bench/desktop`](../bench/desktop).

### Routing: use a hash router

A packaged renderer runs on `file://`, where `pushState('/settings')` rewrites the URL to `file:///settings` — a path that does not exist, so the next reload lands on a blank page and the app is gone. This is why HashRouter is the standard choice for packaged Electron/Tauri apps. Reticle's route observer handles both, and a `{ kind: 'route', contains: … }` assertion matches the fragment.

## Electron

Two steps. The first is the ordinary web setup; the second is the only desktop-specific part.

**1. The renderer** — one line in `vite.config.ts`, exactly like a web app:

```ts
import { reticle } from '@reticlehq/vite-plugin';

export default defineConfig({
  base: './', // file:// needs relative asset paths
  plugins: [react(), reticle({ desktop: true })],
});
```

`desktop: true` does the two things a desktop shell needs and a web app must never get: the plugin also runs for `vite build` (a packaged renderer is a production build with **no dev server**, so the default serve-only gating would ship an app with no `connect()` at all), and `connect()` is called with `allowInProduction` so the SDK's production backstop does not refuse to start. Keep it behind your own dev-only build so an instrumented bundle can never reach a release binary.

Nothing to add in your app code. (You can still call `reticle.connect()` by hand and pass `inject: false` if you want control.)

**2. The preload** — one line, before you expose anything:

```bash
npm i -D @reticlehq/electron
```

```js
// electron/preload.cjs
require('@reticlehq/electron/preload');

const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  loadTodos: () => ipcRenderer.invoke('todos:load'),
});
```

That line is what makes your main-process calls visible. It has to live in the preload, and it is not a stylistic choice: `contextBridge.exposeInMainWorld` hands the renderer a **deeply frozen, non-configurable** object, so nothing running in the page can instrument `window.api`. The preload is the last point where `ipcRenderer.invoke` is still an ordinary, writable function. Patching there covers every channel you go on to expose, whatever you named it.

**Preload sandboxing.** A sandboxed preload can't resolve `node_modules`, so the bare `require` above fails. Either bundle your preload (electron-vite and Electron Forge do this by default — the require is inlined at build time and sandboxing stays on), or set `sandbox: false` in `webPreferences`.

**Packaged renderers.** An app that loads its renderer with `loadFile` runs on `file://`, which is a production Vite build. Pass `allowInProduction: true` to `connect()` for that mode, or keep the SDK gated behind `import.meta.env.DEV` so it never enters the shipped binary at all.

Working example: [`apps/electron-smoke`](../apps/electron-smoke).

## Tauri

Frontend side, nothing desktop-specific:

```ts
// src/main.tsx
import { reticle } from '@reticlehq/browser';

if (import.meta.env.DEV) reticle.connect();
```

Nothing else is needed for IPC. A Tauri `invoke` travels as a real `fetch` to Tauri's `ipc://` custom protocol, so Reticle already sees it; every `invoke('load_todos')` shows up as `ipc://load_todos`. Reticle also reads Tauri's `Tauri-Response` header, because the transport answers **HTTP 200 whether the Rust command returned `Ok` or `Err`** — without that translation a failed command would be recorded as a successful request.

The one required step is **CSP**. Tauri ships a restrictive default that blocks the bridge WebSocket before it opens, and the failure is silent from the app's side. In `src-tauri/tauri.conf.json`:

```json
{
  "app": {
    "security": {
      "csp": "default-src 'self' ipc: http://ipc.localhost; connect-src 'self' ipc: http://ipc.localhost ws://localhost:4400 ws://127.0.0.1:4400"
    }
  }
}
```

Keep `ipc: http://ipc.localhost` in `connect-src` — Tauri v2 needs it for `invoke` itself. Add your dev-server origin too if you use `devUrl`. This is a dev-only config; drop the `ws://` entries from your release config.

Working example: [`apps/tauri-smoke`](../apps/tauri-smoke).

## What IPC looks like to an agent

A desktop app reaches its backend over IPC, not HTTP. `fetch`/`XHR` patching cannot see that, so without the IPC observer every backend call in your app is a blind spot — `reticle_network` returns nothing, `act_and_wait` has no in-flight request to settle on, and `assert { net }` is vacuously true. That is a false green by construction.

Reticle records each IPC call as an ordinary request, so the tools you already use work unchanged:

```jsonc
// reticle_network { urlContains: "ipc://" }
{
  "calls": [
    { "method": "ipc", "url": "ipc://todos:load", "status": 200, "ms": 134 },
    { "method": "ipc", "url": "ipc://todos:archive", "status": 500, "ms": 83 },
  ],
}
```

IPC has no status code; `200`/`500` are synthetic, mapped from whether the call succeeded or failed, precisely so that `reticle_network { status: 500 }` and `assert { kind: "net", status: 500 }` keep working. On Tauri you will see `status: 500` next to `statusText: "OK"` — that is not a bug: the transport really did answer 200, and the 500 is the command's own verdict. `ok` is authoritative, and on Electron `error` carries the message your main process returned:

```jsonc
// reticle_assert { predicate: { kind: "net", urlContains: "ipc://todos:archive", status: 500 } }
{
  "pass": true,
  "evidence": {
    "url": "ipc://todos:archive",
    "ok": false,
    "status": 500,
    "error": "archive is not implemented in the backend",
  },
}
```

Both example apps ship a planted false green — an Archive button that updates the UI optimistically and swallows the rejection. The screen says "archived", a screenshot agrees, a DOM assertion agrees. Only the IPC record disagrees. That is the case desktop support exists for.

## Troubleshooting

**`reticle status` shows no session.** Check the app's console (Electron: devtools, or forward `console-message` to your terminal — a desktop renderer has no visible console otherwise). A refused connect always logs why.

**Tauri: nothing connects and the app console shows a CSP violation.** The `connect-src` above is missing or does not include your daemon's port.

**Electron: `module not found: @reticlehq/electron/preload`.** The preload is sandboxed. Bundle it, or set `sandbox: false` — see [Electron](#electron).

**IPC calls do not appear, but the app works.** Electron: the shim's `require` must run _before_ your preload captures its own reference to `ipcRenderer`. Put it on the first line. Tauri: `invoke` imported from `@tauri-apps/api/core` is observed; a hand-rolled `postMessage` protocol is not, and neither is Tauri's `postMessage` transport fallback on platforms where the `ipc://` custom protocol is unavailable.

**Why not just patch `invoke` / `window.api` directly?** Because neither can be. Tauri defines `__TAURI_INTERNALS__.invoke` as `writable: false, configurable: false`, and Electron's `contextBridge` object is deeply frozen and installed non-configurably. Both were verified, not assumed — which is why the two runtimes use the two different mechanisms above rather than one uniform monkey-patch.
