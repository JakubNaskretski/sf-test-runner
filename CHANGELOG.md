# Changelog

All notable changes to the "sf-test-runner" extension are documented here.

## [0.7.0] - 2026-09-03

### Changed
- **Your target org is now your own.** Switching the org in another Skrety Salesforce extension no longer changes the org tests run against, and picking an org here no longer moves theirs. Prefer the old shared behavior? Turn on `sfTestRunner.syncOrgWithFamily` (default **off**) — it takes effect immediately, follows the shared org (`skrety.salesforce.targetOrg`) and publishes your picks to it. Clearing the shared org never blanks this extension's target.
- On the first start after updating you keep the org you were already using: the org shared with the family is adopted once as this extension's own.

## [0.6.0] - 2026-08-06

### Added
- **Run All Local Tests** — run the org's whole local suite (`--test-level RunLocalTests`, i.e. everything except managed-package tests) from the palette or the Test Results view’s “…” menu.
- **Re-run from the tree** — inline play buttons on each class and method in the Test Results view.
- **Production runs ask first** — a run against an org classified as production now needs a modal confirmation; backing out leaves no state behind. An org whose kind isn't known yet is treated as production.
- **Coverage as a number** — each run's overall line coverage appears in the completion toast and the Test Results view subtitle, with a per-class breakdown in the output channel.
- `DEV` org badge for Developer Edition orgs, which used to be badged `PROD` (they sit on a plain `.my.salesforce.com` host, so only the edition from `sf org list` distinguishes them).
- New settings: `sfTestRunner.showInlineCoverage` (paint the gutter, or report coverage as numbers only) and `sfTestRunner.autoShowOutput` (reveal the output channel when a run starts).
- **Coverage toggle in the status bar** — an eye item next to the org picker shows the active class's coverage percentage and flips `showInlineCoverage` with one click (`SF Tests: Toggle Inline Coverage`). Changing the setting mid-session now unpaints/repaints open editors immediately.

### Fixed
- A failed `sf org list`, coverage query, or recent-runs query is no longer read as an answer: an error envelope from the CLI is reported as the failure it is, instead of surfacing as "you have no orgs" (which could wipe a saved org selection), a class with no coverage, or an org with no recent runs.
- A background coverage lookup that fails stops retrying on every tab focus; a run, an explicit `Refresh Coverage from Org`, or an org switch re-arms it.
- Re-running from the Test Results tree refuses cross-org replays the same way **Re-run Failed** does.
- **Clear Coverage Decorations** stays cleared — the open-file auto-load no longer pulls the highlights straight back on the next tab switch.
- Coverage the extension auto-loads in the background no longer marks a class as having no coverage when the query itself failed; the failure is logged to the output channel rather than shown as a toast.
- On activation, the coverage auto-load now waits for the org to settle instead of firing alongside it and always no-opping.
- The editor title bar play button only appears for `.cls` files that actually contain tests, so the toolbar isn't offering a run that can only fail.
- The org-list failure toast now carries the CLI's own message and no longer reads as an empty list.

### Packaging
- `vscode:prepublish` builds in production mode.
- Test build output (`out-test/`, `tsconfig.test.json`) excluded from the packaged extension.

## [0.5.0] - 2026-07-17

### Added
- **The org picker opens instantly.** The org list is cached — including across window reloads — so picking a target org no longer waits on a `sf org list` call. The picker still refreshes in the background while open, so an org you just authenticated appears in the list by itself a moment later.
- New ↻ button on the org picker and a new `SF Tests: Refresh Org List` command in the palette to force-refresh the cached list at any time.

## [0.4.2] - 2026-07-13

### Fixed
- Test results and coverage that finish after an org switch no longer decorate the new org's context: cross-org coverage is discarded, the results view is labeled with the org it ran against, and **Re-run Failed** refuses to replay another org's failures — naming both orgs — instead of silently running them against the current one.
- On activation, when the shared org isn't in the local auth list the plugin keeps targeting it (matching its sibling plugins) instead of silently switching to the CLI default; rapid external org switches now apply in order (latest wins).

## [0.4.1] - 2026-07-12

### Fixed
- **Org list loads once, not per trigger** — selecting an org, activation auto-select and the shared-org watcher used to each spawn their own `sf org list` when they fired together; they now share a single in-flight call. Double-clicking the status-bar org item no longer stacks a second "loading orgs…" toast and picker.
- **No duplicate coverage queries** — Show/Refresh Coverage now skips its query when the automatic on-open loader is already fetching the same class.

## [0.4.0] - 2026-07-07

### Added
- **Load Recent Test Runs** — pick any recent async run from the org (started from a terminal, CI, or a run lost to a window reload) and load its results and coverage exactly like a live run.

## [0.3.0] - 2026-07-07

### Added
- Run a single test method from its codelens.
- **Re-run Failed Tests** — re-run only the failures of the last run.
- Click a failed result to jump to the failing line; failures also land in the Problems panel.
- Status-bar org badge (`PROD`/`SBX`/`SCR`) with a warning tint on production.
- Org selection is shared with the other Skrety Salesforce extensions.

### Fixed
- Test durations no longer show as `NaNms` (the CLI reports times as strings like `81 ms`).
- `@IsTest(SeeAllData=…)` no longer produces a phantom "Run Test Method | IsTest" codelens, and inline annotations keep the real method name.
- Opening a class with no stored coverage no longer re-queries the org on every tab switch.
- Coverage decorations now come straight from each run's own `--code-coverage` output — no follow-up org query needed.
- Cancelling a run shows a notice instead of an error (an already-queued org job may still finish).
- Long runs are no longer hard-killed at exactly the `--wait` ceiling.
- Windows: the `sf.cmd` launcher now starts on current VS Code builds (Node 20+ refuses `.cmd` spawns; the shim is bypassed safely), and hung CLI processes are force-killed reliably after a timeout.
- The command panel no longer shows fabricated exit codes or byte counts.

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
