# Changelog

All notable changes to the "sf-test-runner" extension are documented here.

## [0.1.0] - 2026-05-21

Initial release.

### Added
- Run Apex tests for the currently open class via codelens, editor title button, or command palette.
- Inline coverage gutter decorations (green = covered, red = uncovered) for Apex `.cls` files.
- Sidebar tree view of test results grouped by class, with pass/fail/runtime and jump-to-source.
- Status bar item showing the current target org.
- Reuses `sf` CLI auth — no separate OAuth flow.
- Configurable API version, poll interval, and target org via settings.
