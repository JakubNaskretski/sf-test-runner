# Salesforce Test Runner

Run Apex tests, see inline coverage in the gutter, and browse results in a sidebar tree.
Reuses your existing `sf` CLI auth — no separate OAuth flow.

## Features

- **Run tests for the current class** via codelens above the class declaration, the editor title bar play button, or `SF Tests: Run Tests in Current Class` in the command palette.
- **Inline coverage gutter** on Apex `.cls` files — green for covered lines, red for uncovered. Auto-loads when you open a class (toggleable).
- **Test results tree view** in the activity bar — pass/fail/runtime per method, grouped by class. Click a method to see its failure message and stack trace in the output channel.
- **Async Tooling API** under the hood — tests are enqueued, polled, then results plus the latest aggregate coverage are fetched.

## Requirements

- The [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) (`sf`) installed and on `PATH`.
- An authenticated org (`sf org login web`) — typically the same auth your other Salesforce VS Code extensions use.

## Commands

| Command | Description |
| --- | --- |
| `SF Tests: Run Tests in Current Class` | Enqueue async tests for the currently open `.cls`. |
| `SF Tests: Refresh Coverage from Org` | Pull the most recent `ApexCodeCoverageAggregate` for the current class. |
| `SF Tests: Clear Coverage Decorations` | Remove gutter highlights. |
| `SF Tests: Select Target Org` | Set the alias/username used for subsequent runs. |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `sfTestRunner.targetOrg` | `""` | Org alias or username. Blank = use `sf` default-org. |
| `sfTestRunner.apiVersion` | `"60.0"` | Salesforce API version. |
| `sfTestRunner.pollIntervalMs` | `2000` | How often to poll `ApexTestRunResult` during an async run. |
| `sfTestRunner.pollTimeoutMs` | `600000` | Hard timeout for an async run (10 min default). |
| `sfTestRunner.showCoverageOnOpen` | `true` | Auto-load coverage when opening a `.cls` file. |

## How auth works

On every operation the extension runs `sf org display --target-org <alias> --json --verbose` and uses the returned `accessToken` + `instanceUrl` to create a `jsforce.Connection`. So as long as your `sf` CLI is logged in, this extension is logged in — no separate setup.

## Known limitations (v0.1.0)

- Coverage is read from `ApexCodeCoverageAggregate`, which reflects the **most recent test run that touched the class** — not necessarily the run you just kicked off if it touched a different class.
- No support yet for running a single method (whole class only).
- No support yet for trigger coverage in the gutter (classes only).

## License

[MIT](./LICENSE)
