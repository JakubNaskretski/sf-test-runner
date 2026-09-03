# Salesforce Test Runner

Run Apex tests with inline coverage in the gutter, browse results in a sidebar tree, and watch every `sf` CLI command we execute in a collapsible panel. Reuses your existing `sf` CLI auth — no separate OAuth flow.

## Features

- **Run tests for the current class** via codelens above the class declaration, the editor title bar play button (shown only for `.cls` files that actually contain tests), or `SF Tests: Run Tests in Current Class` in the command palette.
- **Run a single test method** via the codelens on each `@IsTest` method, and **re-run only the failures** of the last run with `SF Tests: Re-run Failed Tests`.
- **Run the whole local suite** with `SF Tests: Run All Local Tests` (`--test-level RunLocalTests` — every test in the org except managed-package ones), from the palette or the Test Results view’s “…” menu.
- **Re-run straight from the tree** — inline play buttons on each class and method in the Test Results view.
- **Load Recent Test Runs** — pull in the results of any recent async run, including runs started from a terminal, CI, or lost to a window reload.
- **Jump to the failing line** — clicking a failed result opens the class at the stack-trace line, and every failure also lands in the Problems panel.
- **Inline coverage gutter** on Apex `.cls` files — green for covered, red for uncovered. Applied straight from each run, and auto-loaded from the org when you open a class (toggleable via `sfTestRunner.showCoverageOnOpen`, painting itself via `sfTestRunner.showInlineCoverage`).
- **Coverage as a number, not just colour** — each run reports its overall line coverage in the completion toast, in the Test Results view subtitle, and per class in the output channel.
- **Coverage toggle in the status bar** — an eye item next to the org picker shows the active class's coverage percentage and switches the inline painting on/off with one click (`SF Tests: Toggle Inline Coverage`).
- **Production runs ask first** — a run against an org classified as production needs a modal confirmation before anything starts.
- **Test results tree view** in the activity bar — pass/fail/runtime per method, grouped by class. Click a method to see its failure message and stack trace in the output channel.
- **`sf` command panel** — a second view in the activity bar that lists every CLI invocation. Each entry is collapsible to show the full command, args, duration, and any error message. Right-click → **Copy Command** to drop the exact invocation into your clipboard.
- **Org picker** in the status bar — click to choose between any org `sf org list` knows about, with a PROD/SBX/SCR/DEV badge (production gets a warning tint; Developer Edition orgs are badged DEV rather than PROD). The list is cached so the picker opens instantly, refreshes in the background, and can be force-refreshed with the ↻ button or `SF Tests: Refresh Org List`. The choice is this extension's own; set `sfTestRunner.syncOrgWithFamily` to `true` to follow (and publish) the org shared with the other Skrety Salesforce extensions.

## Requirements

- The [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) (`sf`) installed and on `PATH`.
- An authenticated org (`sf org login web`) — typically the same auth your other Salesforce VS Code extensions use.

## Commands

| Command | Description |
| --- | --- |
| `SF Tests: Run Tests in Current Class` | Run async tests for the currently open `.cls` via `sf apex run test`. |
| `SF Tests: Re-run Last Class` | Re-run whichever class you tested most recently in this session. |
| `SF Tests: Re-run Failed Tests` | Re-run only the failing methods from the last run. |
| `SF Tests: Run All Local Tests` | Run every test in the org except managed-package ones (`--test-level RunLocalTests`). |
| `SF Tests: Run Class Tests` | Re-run a class from its inline button in the Test Results tree. |
| `SF Tests: Re-run This Method` | Re-run a single method from its inline button in the Test Results tree. |
| `SF Tests: Load Recent Test Runs` | Pick one of the org's recent async runs and load its results/coverage. |
| `SF Tests: Refresh Coverage from Org` | Pull the most recent `ApexCodeCoverageAggregate` for the current class. |
| `SF Tests: Clear Coverage Decorations` | Remove gutter highlights. |
| `SF Tests: Toggle Inline Coverage` | Flip the `showInlineCoverage` setting — same as clicking the status bar eye. |
| `SF Tests: Select Target Org` | List orgs from `sf org list` and pick one for subsequent runs. |
| `SF Tests: Refresh Org List` | Force a re-read of `sf org list` instead of using the cached list (same as the ↻ button in the picker). |
| `SF Tests: Clear Command History` | Wipe the `sf` command panel. |
| `SF Tests: Copy Command` | Copy the selected `sf` invocation to the clipboard (right-click in the panel). |
| `SF Tests: Show Output Channel` | Reveal the full text log of CLI calls. |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `sfTestRunner.testTimeoutMs` | `600000` | Hard timeout (ms) for `sf apex run test`. Also drives the `--wait` minutes flag. |
| `sfTestRunner.showCoverageOnOpen` | `true` | Auto-load coverage when opening a `.cls` file. |
| `sfTestRunner.showInlineCoverage` | `true` | Paint covered/uncovered lines in the gutter and editor. When off, coverage is still reported as numbers (run summary, output channel, Refresh Coverage) but nothing is highlighted. |
| `sfTestRunner.autoShowOutput` | `true` | Reveal the SF Tests output channel when a test run starts or a recent run is loaded. Opening a test result always reveals it. |
| `sfTestRunner.syncOrgWithFamily` | `false` | Follow and publish the Salesforce org shared across the Skrety SF plugins (`skrety.salesforce.targetOrg`). Off: this extension keeps its own org and ignores switches made in sibling plugins. |

## How it talks to Salesforce

Every operation flows through one wrapper around the `sf` CLI. The exact commands you'll see in the panel:

- **Test runs** — `sf apex run test --class-names <ClassName> --code-coverage --result-format json --wait <minutes> --target-org <username>`
- **Whole-suite runs** — the same command with `--test-level RunLocalTests` in place of `--class-names`.
- **Loading a recent run** — `sf apex get test --test-run-id <id> --code-coverage --result-format json --target-org <username>`, after listing candidates with `sf data query --query "SELECT … FROM ApexTestRunResult ORDER BY StartTime DESC …" --use-tooling-api --json`.
- **Coverage refresh** — `sf data query --query "SELECT … FROM ApexCodeCoverageAggregate WHERE …" --use-tooling-api --json --target-org <username>`
- **Org listing** — `sf org list --skip-connection-status --json`

Because we never embed your access token directly, your `sf` CLI auth is the single source of truth. Re-auth with `sf org login web` and the extension picks it up immediately.

## Known limitations

- After a run, the gutter shows that run's own coverage. The open-file auto-load and `Refresh Coverage from Org` read `ApexCodeCoverageAggregate`, which reflects the **most recent run that touched the class** in the org — whoever started it.
- Results appear automatically only for runs started by this extension; use `Load Recent Test Runs` to pull in anything else.
- Classes only (trigger coverage not surfaced in the gutter yet).
- `Clear Coverage Decorations` stays cleared until you ask for coverage again (a run, `Refresh Coverage from Org`, or an org switch) — it isn't undone by the open-file auto-load.

## License

MIT — see the bundled LICENSE file.
