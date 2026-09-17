# Salesforce Test Runner

Run Apex tests in VS Code's own Test Explorer, with coverage attached to the run that produced it, and watch every `sf` CLI command we execute in a collapsible panel. Reuses your existing `sf` CLI auth — no separate OAuth flow.

## Features

- **Native Test Explorer** — your workspace's Apex test classes and their `@IsTest` methods appear in the Testing view, with run icons in the gutter next to the class declaration and each test method. Run, re-run, re-run-failed and run-last are VS Code's own, so they work exactly as they do for every other test framework you use.
- **Run with Coverage** — a second run profile asks the org for `--code-coverage` and attaches the result to *that run*. It shows up in the Test Coverage view and, when you switch it on, line by line in the editor. Coverage belongs to a run: there is no ambient coverage state that can show you somebody else's numbers, because there is nowhere for them to live except a run you started and VS Code labelled with your org.
- **Failures land where they happened** — the assertion message and Apex stack are attached to the failing line through VS Code's own test failure UI, so you get the inline message, the peek view and the Test Results panel without leaving the editor.
- **Run All Local Tests** — `--test-level RunLocalTests` (every test in the org except managed-package ones), with coverage, from the palette or the `sf` panel's “…” menu.
- **Load Recent Test Runs** — pull in any recent async run of the org, including runs started from a terminal, CI, or lost to a window reload. It is published as a real test run named for what it is.
- **Load Coverage from Org** — the one path to coverage you did not just produce: the org's stored `ApexCodeCoverageAggregate` for a class, i.e. the most recent run that touched it whoever started it. It arrives as a coverage-only run whose name says so.
- **Production runs ask first** — a run against an org classified as production needs a modal confirmation before anything starts.
- **`sf` command panel** — a view in the activity bar listing every CLI invocation. Each entry is collapsible to show the full command, args, duration, and any error message. Right-click → **Copy Command** to drop the exact invocation into your clipboard.
- **Org picker** in the status bar — click to choose between any org `sf org list` knows about, with a PROD/SBX/SCR/DEV badge (production gets a warning tint; Developer Edition orgs are badged DEV rather than PROD). The list is cached so the picker opens instantly, refreshes in the background, and can be force-refreshed with the ↻ button or `SF Tests: Refresh Org List`. The choice is this extension's own; set `sfTestRunner.syncOrgWithFamily` to `true` to follow (and publish) the org shared with the other Skrety Salesforce extensions.

## Requirements

- VS Code 1.88 or newer (the release where the test coverage API was finalized).
- The [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) (`sf`) installed and on `PATH`.
- An authenticated org (`sf org login web`) — typically the same auth your other Salesforce VS Code extensions use.

## Running tests

Everything about *running* is VS Code's own UI. Use the gutter icons in a test class, the Testing view, or the Command Palette: **Test: Run Tests in Current File**, **Test: Run Test at Cursor**, **Test: Rerun Last Run**, **Test: Rerun Failed Tests**, **Test: Toggle Inline Coverage**. Picking the **Run with Coverage** profile is what adds `--code-coverage` to the CLI call; a plain run skips it, so the org does less work.

The Testing view's root **Run All Tests** runs the org's local suite (`--test-level RunLocalTests`), the same as `SF Tests: Run All Local Tests` — for an org, "every test" is a level the CLI already has, and naming every discovered class instead would build a command line long enough to be truncated on Windows.

These commands are this extension's own, because they have no built-in equivalent:

| Command | Description |
| --- | --- |
| `SF Tests: Run All Local Tests` | Run every test in the org except managed-package ones (`--test-level RunLocalTests`), with coverage. |
| `SF Tests: Load Recent Test Runs` | Pick one of the org's recent async runs and load its results and coverage as a test run. |
| `SF Tests: Load Coverage from Org` | Read the stored `ApexCodeCoverageAggregate` for the current class — the org's last run, whoever started it — as a coverage-only run. |
| `SF Tests: Select Target Org` | List orgs from `sf org list` and pick one for subsequent runs. |
| `SF Tests: Refresh Org List` | Force a re-read of `sf org list` instead of using the cached list (same as the ↻ button in the picker). |
| `SF Tests: Clear Command History` | Wipe the `sf` command panel. |
| `SF Tests: Copy Command` | Copy the selected `sf` invocation to the clipboard (right-click in the panel). |
| `SF Tests: Show Output Channel` | Reveal the full text log of CLI calls. |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `sfTestRunner.testTimeoutMs` | `600000` | Hard timeout (ms) for `sf apex run test`. Also drives the `--wait` minutes flag. |
| `sfTestRunner.autoShowOutput` | `true` | Reveal the SF Tests output channel when a test run starts or a recent run is loaded. |
| `sfTestRunner.syncOrgWithFamily` | `false` | Follow and publish the Salesforce org shared across the Skrety SF plugins (`skrety.salesforce.targetOrg`). Off: this extension keeps its own org and ignores switches made in sibling plugins. |

## How it talks to Salesforce

Every operation flows through one wrapper around the `sf` CLI. The exact commands you'll see in the panel:

- **Test runs** — `sf apex run test --tests <ClassName|Class.method> [--tests …] [--code-coverage] --result-format json --wait <minutes> --target-org <username>` (`--code-coverage` only for the Run with Coverage profile).
- **Whole-suite runs** — the same command with `--test-level RunLocalTests` in place of `--tests`.
- **Loading a recent run** — `sf apex get test --test-run-id <id> --code-coverage --result-format json --target-org <username>`, after listing candidates with `sf data query --query "SELECT … FROM ApexTestRunResult ORDER BY StartTime DESC …" --use-tooling-api --json`.
- **Coverage from org** — `sf data query --query "SELECT … FROM ApexCodeCoverageAggregate WHERE …" --use-tooling-api --json --target-org <username>`
- **Org listing** — `sf org list --skip-connection-status --json`

Because we never embed your access token directly, your `sf` CLI auth is the single source of truth. Re-auth with `sf org login web` and the extension picks it up immediately.

## Known limitations

- Test discovery is a regex scan of your `.cls` sources, not an Apex parser. A test the CLI ran but the scan did not find still appears in the run's output, just not as its own row in the Test Explorer. A class annotated `@IsTest` with no test methods in it — a data factory, a callout mock — is deliberately not listed, since running it could only fail.
- A run only reports coverage for the classes it exercised — never for the test class itself, which is how Salesforce reports it. So after running `FooTest` you see the coverage in `Foo`.
- `Load Coverage from Org` and `Load Recent Test Runs` are the two paths that can show you numbers you did not produce. Both need you to ask, and both name their source in the run they create.
- Classes only (triggers are not discovered as tests, and trigger coverage is not surfaced).
- Only runs started by this extension appear by themselves; use `Load Recent Test Runs` for anything else.
- Switching the target org does not wipe the results already in the Testing view: each run stays labelled with the org it ran against, so an old run's pass/fail marks remain visible until you run again.

## License

MIT — see the bundled LICENSE file.
