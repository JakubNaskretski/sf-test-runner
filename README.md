# Salesforce Test Runner

Run Apex tests from a sidebar built for the job: pick the target org, tick classes and methods across your workspace and the org, read parsed results with clickable failures, and see coverage in its own view and painted on your editor lines. Every `sf` CLI command we execute is listed in a collapsible log. Reuses your existing `sf` CLI auth — no separate OAuth flow.

## Features

The **SF Tests** activity-bar icon opens four views. Each is a collapsible section: fold the ones you are not using, resize them, or hide them from the container's ⋯ menu.

- **Tests** — the target org as a dropdown, ⟳ to refresh the org list and ＋ to log in to another org; a production org gets a warning bar above the tree. All/Selected tabs, a search box and a source filter sit above a tree of test classes with tri-state checkboxes down to the method. **Select tests for active class** ticks the tests for the class open in the editor, and a “with coverage” checkbox decides whether the run asks for `--code-coverage`. The run row is **Run Selected**, **All Local** (`--test-level RunLocalTests`, every test in the org except managed-package ones) and **All in Org** (managed packages included). While a run is on you see done/total, the elapsed time and a **Cancel** button.
- **Tests from the org, not only from disk** — **Fetch org tests** merges the org's test classes with the workspace scan. Classes only in the org are listed as `org-only` and are runnable; classes only on disk carry a `not deployed` badge and a warning before a run. The org's list is cached per org and stamped "as of".
- **Results** — one run bar (PASS/FAIL, counts, wall time, org, finish time, **Re-run failed**, **Copy**), an All/Failed filter, and a tree of test classes with `n/m passed` and time, each method with its outcome and duration. A failure expands in place with the assertion message and every parsed stack frame as a link that opens the file at that line; compile failures get their own badge. The tree fills in as methods finish.
- **Coverage** — after a coverage run: the overall percentage with the 75% production-deploy floor marked, and a worst-first table of the classes the run exercised (bar coloured by band, covered/total, uncovered count). A row opens the class; its cloud button loads that one class's stored coverage from the org's last run, whoever ran it, labelled as such. Covered and uncovered lines are painted in the editor with a gutter bar and overview-ruler marks, the run and org are named in the hover, and a status-bar eye shows the active file's percentage and toggles the painting. Coverage only ever comes from your own run or that explicit per-class load; it dims once you edit the file and is dropped when you switch orgs.
- **CodeLens** on test classes and methods — `▶ Run` and `Run with Coverage`, plus the last outcome.
- **Cancel aborts in the org** — queued classes are marked Aborted; the class already executing finishes.
- **Load Recent Test Runs** — pull in any recent async run of the org, including runs started from a terminal, CI, or lost to a window reload; it lands in the Results view like your own.
- **Production runs ask first** — a run against an org classified as production needs a modal confirmation before anything starts.
- **Command log** — every CLI invocation with its full command, duration and any error; **Copy Command** drops the exact invocation into your clipboard. Starts collapsed.
- **Your org is your own** — the choice made here is remembered by this extension and does not follow the org other tools select. Set `sfTestRunner.syncOrgWithFamily` to `true` to follow (and publish) the org shared with the other Skrety Salesforce extensions.

## Requirements

- VS Code 1.88 or newer.
- The [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) (`sf`) installed and on `PATH`.
- An authenticated org (`sf org login web`) — typically the same auth your other Salesforce VS Code extensions use.

## Commands

| Command | Description |
| --- | --- |
| `SF Tests: Run Selected Tests` | Run the ticked classes and methods. |
| `SF Tests: Run All Local Tests` | Every test in the org except managed-package ones. |
| `SF Tests: Run All Tests in Org (incl. managed)` | `--test-level RunAllTestsInOrg`. |
| `SF Tests: Cancel Test Run` | Stop the local command and abort the run in the org. |
| `SF Tests: Rescan Workspace for Tests` | Re-read the `.cls` files in the workspace. |
| `SF Tests: Fetch Test Classes from Org` | Merge the org's test classes into the tree. |
| `SF Tests: Select Target Org` / `Refresh Org List` / `Log In to an Org` | The org dropdown's actions, also from the palette. |
| `SF Tests: Select Tests for Active Class` | Tick the tests for the class open in the editor. |
| `SF Tests: Re-run Failed Tests` | Run again only what failed in the last run, against the same org. |
| `SF Tests: Copy Run Summary` | The run bar and every failure as text. |
| `SF Tests: Load Recent Test Runs` | Pick one of the org's recent async runs and load it into the Results view. |
| `SF Tests: Expand All Results` / `Collapse All Results` | Fold or unfold every class in the Results view. |
| `SF Tests: Toggle Coverage Painting` / `Clear Coverage` | The eye and the Clear button of the Coverage view. |
| `SF Tests: Load Coverage from Org` | The stored coverage of one class from the org's last run, whoever ran it. |
| `SF Tests: Clear Command History` / `Copy Command` / `Show Output Channel` | The command log's actions and the full text log. |
| `SF Tests: How It Works` | The **?** in the Tests view title: a short usage guide with a link to this README. |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `sfTestRunner.runWithCoverage` | `true` | Ask for code coverage when running tests (the "with coverage" chip mirrors this). |
| `sfTestRunner.paintCoverage` | `true` | Paint covered and uncovered lines in the editor after a coverage run. |
| `sfTestRunner.fetchOrgTestsOnOpen` | `false` | Query the org for its test classes when the panel lands on an org; off means the org is only contacted when you press **Fetch org tests**. |
| `sfTestRunner.testTimeoutMs` | `600000` | Ceiling (ms) for waiting on a run: it is started asynchronously and polled until it finishes or this much time passes, after which it is reported as still running in the org. |
| `sfTestRunner.autoShowOutput` | `true` | Reveal the SF Tests output channel when a run starts or a recent run is loaded. |
| `sfTestRunner.syncOrgWithFamily` | `false` | Follow and publish the Salesforce org shared across the Skrety SF plugins (`skrety.salesforce.targetOrg`). |

## How it talks to Salesforce

Every operation flows through one wrapper around the `sf` CLI. The exact commands you'll see in the log:

- **Starting a run** — `sf apex run test --tests <ClassName|Class.method> [--tests …] [--code-coverage] --result-format json --json --target-org <username>` (no `--wait`: the run id comes back at once). Whole-suite runs use `--test-level RunLocalTests` or `RunAllTestsInOrg` instead of `--tests`.
- **Progress** — `sf data query --use-tooling-api --json` on `ApexTestRunResult` (status and method counts) and `ApexTestResult` (finished methods) every few seconds.
- **Results and coverage** — `sf apex get test --test-run-id <id> --code-coverage --result-format json --target-org <username>` once the run is done; the same command loads a recent run.
- **Cancel** — the run's `ApexTestQueueItem` rows still queued are set to Aborted with one `sf api request rest -X PATCH` call per 200 rows.
- **Org test classes** — `sf data query --use-tooling-api` for `ApexClass` names, then the source of classes not in the workspace, in batches, to find the ones with tests.
- **Coverage from org** — `sf data query --query "SELECT … FROM ApexCodeCoverageAggregate WHERE …" --use-tooling-api --json`.
- **Org listing** — `sf org list --skip-connection-status --json`; **login** — `sf org login web --json`.

Because we never embed your access token directly, your `sf` CLI auth is the single source of truth. Re-auth with `sf org login web` and the extension picks it up immediately.

## Known limitations

- Workspace discovery is a regex scan of your `.cls` sources, not an Apex parser. A test the CLI ran but the scan did not find still appears in the Results view under its class. A class annotated `@IsTest` with no test methods in it — a data factory, a callout mock — is deliberately not listed, since running it could only fail.
- Org discovery reads class source in batches; on an org with thousands of classes not present in your workspace the first fetch takes a while. It is cached per org afterwards.
- A run only reports coverage for the classes it exercised — never for the test class itself, which is how Salesforce reports it. So after running `FooTest` you see the coverage in `Foo`.
- Classes only: triggers are not discovered as tests, and a trigger's coverage is shown in the table but not painted.
- Cancelling stops what is still queued; the class the org is executing at that moment finishes.
- Only runs started by this extension appear by themselves; use **Load Recent Test Runs** for anything else.

## License

MIT — see the bundled LICENSE file.
