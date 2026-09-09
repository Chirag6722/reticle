### Added

- **`@reticlehq/init` — the project scaffolder is now its own package.** Everything `reticle init` does at build time — framework detection, the config write, the build-config patches, the generated connect snippet, the agent rules, the MCP registration — moved out of `@reticlehq/server` and publishes on its own. Nothing in it observes a running app, and while it sat inside the daemon a typo in a generated snippet forced a republish of the MCP server, and every MCP user downloaded a scaffolder they run once or never. You do not install it: `@reticlehq/server` depends on it at the same version and the `reticle` CLI drives it, so `reticle init` behaves exactly as before.

### Changed

- **`@reticlehq/server` — `buildNodeIo(cwd)` now takes a host: `buildNodeIo(cwd, host)`.** Only relevant if you drive `runInit` as a library. The scaffolder no longer reaches into the daemon for the release version, the tracer, the telemetry reporter, the bridge pairing token or the declared install channel; all five arrive through an `InitHost` you pass in. `SILENT_HOST` is exported for callers with nothing to report. Every `init/*` module that was importable from `@reticlehq/server` now lives behind `@reticlehq/init`'s single entry point.
