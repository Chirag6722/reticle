### Added

- **`@reticlehq/init` is a package.** `reticle init` was 8,289 LOC inside the 174k-LOC server package, so a typo in a connect snippet republished the MCP server and every MCP user downloaded a scaffolder they run once. It now ships separately and the runtime depends on it.
- **`init` writes the connect file for Nuxt and React Router.** Both previously ended on a `⚠` telling you to hand-edit — Nuxt exited 1 — so neither could be gated. React Router framework mode is where #678 happened.
- **`registerCapabilities` is generated on every framework**, not only Vite and Next. Astro, SvelteKit, CRA, Nuxt and React Router connected and registered nothing.
- **`@reticlehq/core/telemetry` and `@reticlehq/core/artifacts`** subpath entry points. The root surface is unchanged.

### Changed

- **The install gate covers all ten supported frameworks**, one CI cell each across two OSes, up from five scaffolds in a single serial job.
- **CI costs roughly half.** macOS ran the whole Linux tier at a 10x multiplier and caught nothing unique across 53 failing runs; it now runs the path, spawn and port surface Linux cannot answer for. Superseded PR runs are cancelled, `.turbo` is cached, and the unit gate is no longer invalidated by every docs edit.
- **Dependency advisories: 30 to 8.** All highs and four of five criticals.

### Fixed

- **The SDK no longer breaks the app it observes.** Ten patched natives built their telemetry payload before calling the original, so a throw in redaction meant a customer's WebSocket frame or XHR never sent. The teardown loop was unguarded, `freezeClock` dropped `setTimeout`'s trailing arguments and had no watchdog, and four teardowns restored a native unconditionally, silently uninstalling a wrapper installed after `connect()`.
- **A framework you forget to wire is now a compile error** rather than a green install over an app that cannot connect.
