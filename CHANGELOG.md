# Changelog

All notable changes to the "sf-test-runner" extension are documented here.

## [0.2.2] - 2026-06-19

### Added
- Branded extension icon — shown on the Marketplace listing and on the activity-bar.

## [0.2.1] - 2026-06-09

### Changed
- Internal packaging and tooling cleanup. No functional changes.

## [0.2.0] - 2026-05-21

### Changed
- Switched backend from `jsforce` + Tooling API polling to `sf` CLI shell-out (`sf apex run test --code-coverage --result-format json --wait …`). Aligns with the conventions used by the SOQL Editor / Apex Editor sibling plugins.
- Publisher ID corrected to `Skrety`.
- Org selection now lists every authenticated org from `sf org list` in a QuickPick (was a freeform text input).
- Target org selection is remembered across sessions.

### Added
- **`sf` command panel** — a second view in the activity bar showing every CLI invocation, collapsible to show the full command, duration, exit code, stdout/stderr sizes, and any error. Right-click an entry → **Copy Command**.
- `SF Tests: Show Output Channel`, `SF Tests: Clear Command History`, `SF Tests: Copy Command` commands.

### Removed
- `jsforce` dependency.
- `sfTestRunner.targetOrg`, `sfTestRunner.apiVersion`, `sfTestRunner.pollIntervalMs`, `sfTestRunner.pollTimeoutMs` settings (replaced by `sfTestRunner.testTimeoutMs` and CLI-native auth).

## [0.1.0] - 2026-05-21

Initial release.

### Added
- Run Apex tests for the currently open class via codelens, editor title button, or command palette.
- Inline coverage gutter decorations (green = covered, red = uncovered) for Apex `.cls` files.
- Sidebar tree view of test results grouped by class, with pass/fail/runtime and jump-to-source.
- Status bar item showing the current target org.
- Reuses `sf` CLI auth — no separate OAuth flow.
- Configurable API version, poll interval, and target org via settings.
