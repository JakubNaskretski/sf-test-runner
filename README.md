# Salesforce Test Runner

Run Apex tests with inline coverage in the gutter, browse results in a sidebar tree, and watch every `sf` CLI command we execute in a collapsible panel. Reuses your existing `sf` CLI auth — no separate OAuth flow.

## Features

- **Run tests for the current class** via codelens above the class declaration, the editor title bar play button, or `SF Tests: Run Tests in Current Class` in the command palette.
- **Run a single test method** via the codelens on each `@IsTest` method, and **re-run only the failures** of the last run with `SF Tests: Re-run Failed Tests`.
- **Jump to the failing line** — clicking a failed result opens the class at the stack-trace line, and every failure also lands in the Problems panel.
- **Inline coverage gutter** on Apex `.cls` files — green for covered, red for uncovered. Applied straight from each run, and auto-loaded from the org when you open a class (toggleable via `sfTestRunner.showCoverageOnOpen`).
- **Test results tree view** in the activity bar — pass/fail/runtime per method, grouped by class. Click a method to see its failure message and stack trace in the output channel.
- **`sf` command panel** — a second view in the activity bar that lists every CLI invocation. Each entry is collapsible to show the full command, args, duration, and any error message. Right-click → **Copy Command** to drop the exact invocation into your clipboard.
- **Org picker** in the status bar — click to choose between any org `sf org list` knows about, with a PROD/SBX/SCR badge (production gets a warning tint). Selection is shared with the other Skrety Salesforce extensions.

## Requirements

- The [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) (`sf`) installed and on `PATH`.
- An authenticated org (`sf org login web`) — typically the same auth your other Salesforce VS Code extensions use.

## Commands

| Command | Description |
| --- | --- |
| `SF Tests: Run Tests in Current Class` | Run async tests for the currently open `.cls` via `sf apex run test`. |
| `SF Tests: Re-run Last Class` | Re-run whichever class you tested most recently in this session. |
| `SF Tests: Re-run Failed Tests` | Re-run only the failing methods from the last run. |
| `SF Tests: Refresh Coverage from Org` | Pull the most recent `ApexCodeCoverageAggregate` for the current class. |
| `SF Tests: Clear Coverage Decorations` | Remove gutter highlights. |
| `SF Tests: Select Target Org` | List orgs from `sf org list` and pick one for subsequent runs. |
| `SF Tests: Clear Command History` | Wipe the `sf` command panel. |
| `SF Tests: Copy Command` | Copy the selected `sf` invocation to the clipboard (right-click in the panel). |
| `SF Tests: Show Output Channel` | Reveal the full text log of CLI calls. |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `sfTestRunner.testTimeoutMs` | `600000` | Hard timeout (ms) for `sf apex run test`. Also drives the `--wait` minutes flag. |
| `sfTestRunner.showCoverageOnOpen` | `true` | Auto-load coverage when opening a `.cls` file. |

## How it talks to Salesforce

Every operation flows through one wrapper around the `sf` CLI. The exact commands you'll see in the panel:

- **Test runs** — `sf apex run test --class-names <ClassName> --code-coverage --result-format json --wait <minutes> --target-org <username>`
- **Coverage refresh** — `sf data query --query "SELECT … FROM ApexCodeCoverageAggregate WHERE …" --use-tooling-api --json --target-org <username>`
- **Org listing** — `sf org list --json`

Because we never embed your access token directly, your `sf` CLI auth is the single source of truth. Re-auth with `sf org login web` and the extension picks it up immediately.

## Known limitations

- After a run, the gutter shows that run's own coverage. The open-file auto-load and `Refresh Coverage from Org` read `ApexCodeCoverageAggregate`, which reflects the **most recent run that touched the class** in the org — whoever started it.
- Test results only appear for runs started by this extension — tests kicked off from a terminal or CI aren't discovered.
- Classes only (trigger coverage not surfaced in the gutter yet).

## License

MIT — see the bundled LICENSE file.
