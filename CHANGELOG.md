# Changelog

All notable changes to the "sf-test-runner" extension are documented here.

## [0.12.0] - 2026-09-18

- **Coverage leads with the classes the run was actually about.** A run reports every class its tests touched, so one test class could bury the class you cared about under forty others and the headline percentage averaged the lot. The view now resolves what each test class was aimed at and leads with those, grouped by how well it knows: **Declared** from Salesforce's `@IsTest(testFor='ApexClass:Foo')` annotation (API v66+, and it names triggers just as well), **By name** from the `FooTest`/`TestFoo`/`Foo_Test`/`FooTests` conventions — accepted only when that class really was covered — and **By truncated name** for a class whose name is too long to have a conventional test class, matched on a prefix and declining whenever two candidates fit. Each row's tooltip names the test classes that pointed at it.
- The headline and the bar now measure those targeted classes, with the 75% marker dimmed to say the deploy floor is an org-wide rule and not a verdict on the two classes in front of you; the whole-run average moves to the legend. A class a `testFor` declares but the run never reached is shown as **not exercised** rather than dropped. Everything else the run touched folds into **Also covered**, collapsed, with the lowest percentage on the summary line. A run with nothing identifiable falls back to the flat worst-first table.
- **Triggers are first-class in coverage.** The workspace scan walks `.trigger` files, so a covered trigger stops reporting "no local source" and opens its own file.
- The output channel no longer steals focus when a run starts — the Results view already shows it live. `sfTestRunner.autoShowOutput` now defaults off; set it to `true` for the old behaviour.

## [0.11.0] - 2026-09-18

- **A tidier Tests view.** The org dropdown no longer carries a separate kind badge — the DEV/SBX/PROD/SCR tag is on the option itself, and a production org still gets its warning bar. Rescan and Fetch org tests now split the toolbar row evenly, and the action area is two rows: **Select tests for active class** with the "with coverage" checkbox, then **Run Selected**, **All Local** and **All in Org** as one full-width run row. The ⋯ menu is gone — Run all tests in org is a plain button and Load recent run stays in the view title. The selection count moved up beside the class and test counts.
- **The coverage table leads with the class you were testing.** A run of `FooTest` puts `Foo` at the top; everything else the run happened to exercise folds into "Also covered by this run · N classes". Filtering searches the whole table, and a run whose test classes match none of the usual naming conventions (`FooTest`, `TestFoo`, `Foo_Test`, `FooTests`) still lists every row as before.
- **Coverage says where its numbers came from.** The header reads "From this run · 39% across 143 classes", "From the run you loaded · …" for a run pulled out of the org's history, or "Stored in the org · 82%" for the per-class load — and the legend spells out that a run's overall average covers only the classes that run exercised, not the org's coverage.
- Command titles no longer repeat "SF Tests" in view-title tooltips; the palette still groups them under **SF Tests**.

## [0.10.0] - 2026-09-18

- **?** in the Tests view title opens a short guide — picking the org, ticking and running tests, reading results and coverage, the CodeLens links — with an **Open README** button for the full documentation.

## [0.9.0] - 2026-09-17

### Changed
- **Apex tests are back in the SF Tests sidebar, as four views.** The Testing-view integration from 0.8.0 is gone; in its place the activity-bar container holds **Tests** (pick what to run), **Results** (read what happened), **Coverage** (the numbers and the paint toggle) and the **Command log**. Each is a collapsible section you can fold, resize, or hide from the container's ⋯ menu — selecting and reading are deliberately separate views, so you can give the Results view the room while a run is on.
- **Tests view.** The target org sits at the top as a dropdown with a DEV/SBX/PROD/SCR badge, a ⟳ to refresh the list and ＋ to log in to another org. Below it: All/Selected tabs, a search box, a source filter, and a tree of test classes with tri-state checkboxes down to the method. **Tests for active file** ticks the tests for the class open in the editor (the class itself if it is a test, otherwise its `<Name>Test`, `Test<Name>`, `<Name>_Test` or `<Name>Tests`). The buttons are **Run Selected**, **Run All Local**, and a ⋯ menu with **Run all tests in org (incl. managed)** and **Load recent run**; the "with coverage" chip decides whether the run asks for `--code-coverage`.
- **Tests from the org, not only from disk.** **Fetch org tests** lists the test classes the org has and merges them with the workspace scan: classes in both places are plain rows, classes only in the org are listed as `org-only` and runnable, classes only on disk carry a `not deployed` badge and a warning before a run (you can run anyway). The org's list is cached per org and stamped "as of"; `sfTestRunner.fetchOrgTestsOnOpen` (default off) refreshes it whenever the panel lands on an org.
- **Runs are asynchronous, with live progress.** The run is started without waiting and polled every few seconds: the Tests view shows done/total and the elapsed time, and the Results view fills its tree as methods finish. **Cancel** now aborts the run in the org — queued classes are marked Aborted, the class already executing finishes — instead of only stopping the local command.
- **Results view.** One run bar (PASS/FAIL, counts, wall time, org, finish time, **Re-run failed**, **Copy**), an All/Failed filter, and a tree of test classes showing `n/m passed` and time, with each method's outcome and duration underneath. Failures expand in place with the assertion message and every parsed stack frame as a link that opens the file at that line; compile failures get their own badge. Runs loaded with **Load Recent Test Runs** land in the same view.
- **Coverage view and painted lines.** After a coverage run the view shows the overall percentage with the 75% production-deploy floor marked, and a worst-first table of the classes the run exercised (bar coloured by band, covered/total, uncovered count). A row opens the class; its cloud button loads that one class's stored coverage from the org's last run, whoever ran it, labelled as such. Covered and uncovered lines are painted in the editor with a gutter bar and overview-ruler marks, the run and org named in the hover, and a status-bar eye shows the active file's percentage and toggles the painting. Coverage only ever comes from your own run or that explicit per-class load, is dimmed once you edit the file, and is dropped when you switch orgs.
- **CodeLens** on test classes and methods: `▶ Run` and `Run with Coverage`, plus the last outcome.
- `sfTestRunner.testTimeoutMs` is now the ceiling for polling a run rather than a `--wait` value. A run still going when it passes is reported as still running in the org; **Load Recent Test Runs** picks it up once it finishes.
- A run the CLI refuses (a class not in the org, expired auth, "No tests found") is reported as an error run in the Results view and the output channel — never as a green run.

### Added
- Settings `sfTestRunner.runWithCoverage` (default on), `sfTestRunner.paintCoverage` (default on) and `sfTestRunner.fetchOrgTestsOnOpen` (default off).
- Commands: Run Selected Tests, Run All Tests in Org (incl. managed), Cancel Test Run, Rescan Workspace for Tests, Fetch Test Classes from Org, Log In to an Org, Select Tests for Active File, Re-run Failed Tests, Copy Run Summary, Expand All Results, Collapse All Results, Toggle Coverage Painting, Clear Coverage.

### Removed
- The Testing-view integration: the Run / Run with Coverage profiles, the Test Coverage view entries and the gutter run icons. Use the sidebar views and the CodeLens links instead; keybindings pointed at the `testing.*` built-ins no longer reach this extension's tests.

### Upgrading
- Click the SF Tests activity-bar icon: the four views are there. If the Tests view is empty, press **Rescan** — discovery is lazy on purpose.
- Runs ask for coverage by default now (`sfTestRunner.runWithCoverage`); turn the chip off for a quicker run.
- Your target org and your selection of tests survive a window reload; the command log starts collapsed.

## [0.8.0] - 2026-09-17

### Changed
- **Apex tests now run through VS Code's native testing UI.** The extension registers a `TestController`, so your test classes and methods appear in the Testing view with run icons in the gutter, and running, re-running, re-running just the failures and running the current file are VS Code's own commands, working the way they do for every other test framework. Failures are attached to the failing line through the built-in test failure UI instead of the Problems panel.
- **Coverage belongs to a run.** A second run profile, **Run with Coverage**, asks the org for `--code-coverage` and attaches the result to that specific run (`TestRun.addCoverage`), which VS Code shows in its Test Coverage view and, on request, line by line in the editor. This is the structural version of the fix the previous release aimed at: coverage from somebody else's run can no longer appear, because coverage no longer exists as ambient state — only as a property of a run you started and that is labelled with the org it ran against. A plain run skips `--code-coverage` entirely, so it asks the org for less work than before.
- **Coverage you did not produce is now explicitly labelled.** `SF Tests: Refresh Coverage from Org` is renamed `SF Tests: Load Coverage from Org` and publishes the org's stored `ApexCodeCoverageAggregate` as a coverage-only run named "<class> coverage from org (last run, any user)". `Load Recent Test Runs` likewise publishes what it loaded as a named run.
- `SF Tests: Run All Local Tests` now always gathers coverage — a whole-org suite run is the case where the number is the point. The Testing view's root **Run All Tests** button maps to the same thing (`--test-level RunLocalTests`) rather than naming every discovered class on the command line.
- A run that the CLI refuses outright — a class that is not in the org, expired auth — now reports the CLI's own reason ("This class name's value is invalid: …") instead of the bare "produced no output (exit 1)" it used to show. Failing tests are unaffected: they exit 100 but carry a complete result, and that still counts as a run that happened.
- **Requires VS Code 1.88** (was 1.85), the release where the test coverage API was finalized.
- Switching org no longer clears the results on screen. Each run is labelled with the org it ran against and kept in VS Code's run history, so the previous org's marks stay visible until you run again.

### Removed
Every command and setting below was replaced by a built-in that does the same job; the old ones are gone from the palette.
- The extension's own **Test Results** tree view — use the Testing view.
- `SF Tests: Run Tests in Current Class`, `Run Test Method`, `Re-run Last Class`, `Re-run Failed Tests`, `Run Class Tests`, `Re-run This Method`, `Open Test Result` — use the gutter icons, the Testing view, or **Test: Run Tests in Current File** / **Test: Rerun Last Run** / **Test: Rerun Failed Tests**.
- `SF Tests: Toggle Inline Coverage` and `SF Tests: Clear Coverage Decorations`, plus the status-bar coverage eye and the `sfTestRunner.showInlineCoverage` setting — use **Test: Toggle Inline Coverage** and the Test Coverage view.
- `sfTestRunner.showCoverageOnOpen` — opening a class no longer queries the org for coverage at all. VS Code will flag the setting as unknown if it is still in your `settings.json`; delete the line.
- The run-completion notification (“All 12 tests passed … · coverage 87%”). Results are in the Testing view, coverage is in the Test Coverage view, and the per-class breakdown with the overall percentage stays in the SF Tests output channel.
- The refusal to re-run one org's failures against another (added in 0.4.2). Re-running is VS Code's own now and always targets the org currently selected; each run is labelled with the org it ran against, and a production target still needs the modal confirmation.

### Upgrading
- Your Apex tests move from the SF Tests sidebar to VS Code's Testing view; the `sf` command panel stays where it is. If the Testing view looks empty, open any Apex test class or hit the refresh button there — discovery is lazy on purpose, so a large SFDX repo is not scanned at startup.
- **The plain Run profile does not gather coverage.** The gutter play button runs it, so if you relied on every run producing coverage, use **Run with Coverage** (the dropdown next to the run button, or set it as the default profile from the Testing view's gear menu).
- Keybindings pointed at the removed `sfTestRunner.*` command ids stop working; repoint them at the `testing.*` built-ins (`testing.runCurrentFile`, `testing.runAtCursor`, `testing.reRunLastRun`, `testing.reRunFailTests`, `testing.toggleInlineCoverage`).
- A class annotated `@IsTest` that contains no test methods — a `TestDataFactory`, a callout mock — no longer appears as a runnable test. That is deliberate: running one could only ever fail.

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
