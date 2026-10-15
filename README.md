# playwright-shard-balancer

Duration-balanced sharding for Playwright. Every shard finishes at about the same time, so a sharded run takes the even split of the work instead of the slowest count-based shard.

- No orchestration job. CI keeps `npx playwright test --shard=k/n`. Each shard reads the same timings file and computes the same plan through Playwright's `preprocess` reporter hook (Playwright 1.62+).
- Keeps Playwright's own test groups whole: a file without `fullyParallel`, a serial describe, tests that share a [lock](https://playwright.dev/docs/test-parallel#test-locks). Splits by test where Playwright would.
- Plans for the slowest shard's wall time: workers per shard, and the setup projects each shard has to run.
- Matches a brute-force optimum on every small suite in its tests, and reaches the lower bound on a 10,000-group suite in well under a second. Deterministic: the same test list, timings file, shard count and `workers` option give the same plan on every machine.
- Fails open by default: a missing or broken timings file gives Playwright's built-in split. Strict mode fails the shard instead, so no shard can split the suite differently from the others; the GitHub Action turns it on once timings exist.
- Proves the run. `check` fails the build when a test ran twice, ran nowhere, or did not run, and writes predicted against actual shard times to the job summary.
- Answers "how many shards?". `simulate` replays your suite at any shard count, overhead included, before you change CI.
- `plan` writes `--test-list` files for Playwright 1.56 to 1.61, or for CI that prefers one planning job.

## Quick start

```sh
npm install -D playwright-shard-balancer
```

Add the reporter next to your other reporters:

```ts
// playwright.config.ts
export default defineConfig({
  reporter: [
    ['html'],
    ['playwright-shard-balancer', { timings: 'shard-timings.json', record: 'shard-records/run-{shard}.json' }],
  ],
});
```

Teach it your durations from any full run, then see what balancing would save:

```sh
npx playwright test --reporter=json > report.json
npx playwright-shard-balancer update --timings shard-timings.json report.json

PLAYWRIGHT_JSON_OUTPUT_NAME=list.json npx playwright test --list --reporter=json > /dev/null
npx playwright-shard-balancer simulate --timings shard-timings.json --list list.json --shards 2-8 --overhead 90s --target 10m
```

For each shard count it prints the slowest shard with Playwright's split and with balancing, and the best possible. With `--target`, it names the fewest shards that finish in time.

Shard as usual with `npx playwright test --shard=k/n`. Each shard logs one line: its files, tests and estimate, the range across all shards, the largest group, and the timings and plan shas.

Then keep the timings fresh from CI. See [CI](#ci).

## How it works

1. Every shard loads the full test list, as Playwright does before it shards.
2. The reporter groups tests the way Playwright's own scheduler does, estimates each group from the timings, and splits the groups into `n` shards.
3. It removes the other shards' tests and turns Playwright's built-in split off for the run.

All shards compute the same plan independently. The log line shows the timings sha and the plan sha, and `check` compares them across shards.

**Estimates.** A test costs the median of its last 5 passing durations, retries included. A new test costs the median of its describe, else its file, else its project, else the suite. A test skipped before it runs costs nothing. Failed and interrupted runs are not sampled, because a failure often runs to the timeout.

**Groups.** Tests in a file that is not in parallel mode stay together. In parallel mode (`fullyParallel` or `describe.configure({ mode: 'parallel' })`) each test can go to any shard, except that a serial describe stays together. Tests that share a lock go to one shard, since shards run at the same time. Setup and teardown projects are never split: they run on every shard whose tests need them, and their time counts on each of those shards.

**Splitting.** Largest-first and Karmarkar-Karp starts, each refined by moves and swaps, then a branch-and-bound search with a fixed node budget. With more than one worker per shard, a second pass packs each shard for wall time. When projects need different setup projects, it also tries giving each family its own shards, and keeps whichever plan finishes first.

## Config

| Option | Default | Meaning |
|---|---|---|
| `timings` | `shard-timings.json` | Timings file, relative to the config file. |
| `record` | none | Where each run writes its record for `update` and `check`. `{shard}` becomes the shard number. Relative to the config file. |
| `granularity` | `auto` | `auto` follows Playwright's groups. `file` keeps every file whole. |
| `workers` | `1` | Workers per shard that the plan packs for. Set it to your CI's fixed per-shard `workers`. The plan does not read `config.workers`, because Playwright resolves that from each machine's CPUs. |
| `strict` | `false` | Fail the run instead of falling back to the built-in split. Also on with `PLAYWRIGHT_SHARD_BALANCER_STRICT=1`. |

## CI

### GitHub Actions

```yaml
jobs:
  e2e:
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3, 4]
    steps:
      # checkout, setup-node, npm ci, playwright install
      - uses: qa-gary-parker/playwright-shard-balancer/actions/restore@v0
      - run: npx playwright test --shard=${{ matrix.shard }}/${{ strategy.job-total }}
      - if: ${{ !cancelled() }}
        uses: actions/upload-artifact@v7
        with:
          name: shard-record-${{ matrix.shard }}
          path: shard-records/

  shard-timings:
    needs: e2e
    if: ${{ !cancelled() }}
    steps:
      - uses: actions/download-artifact@v8
        with:
          pattern: shard-record-*
          path: shard-records
          merge-multiple: true
      - uses: qa-gary-parker/playwright-shard-balancer/actions/finish@v0
```

The full workflow is in [examples/github-actions.yml](examples/github-actions.yml).

- `restore` takes the newest timings from the cache and pins that copy to the workflow run. Every shard, and every re-run of a failed shard, plans from the same bytes. On a first run it pins an empty file, so every shard uses the built-in split. Once the pinned file has timings, it turns strict mode on.
- `finish` runs `check` (job summary included), merges the durations with `update`, and saves the result for the next run. It runs the project's installed CLI, or `npx` otherwise.

### Other CI

The reporter needs only the timings file on each shard. Restore one copy per pipeline, pass it to every shard, and run `update` and `check` on the collected records afterwards. GitLab, CircleCI and Buildkite give the shard as `CI_NODE_INDEX`/`CI_NODE_TOTAL`, `CIRCLE_NODE_INDEX`/`CIRCLE_NODE_TOTAL` or `BUILDKITE_PARALLEL_JOB`/`BUILDKITE_PARALLEL_JOB_COUNT`; pass it as `--shard`.

## Commands

```
playwright-shard-balancer update   --timings <timings.json> <report.json | run-record.json>...
playwright-shard-balancer simulate --timings <timings.json> --list <list.json> --shards <n | a-b> [--workers <n>] [--granularity file|test] [--overhead <90s>] [--target <12m>] [--out <file>]
playwright-shard-balancer plan     --timings <timings.json> --list <list.json> --shards <n> --out-dir <dir> [--workers <n>] [--granularity file|test]
playwright-shard-balancer check    <run-record.json>... [--list <list.json>] [--summary <file.md>]
```

- `update` merges durations from Playwright JSON reports or run records. An input it has already merged is skipped, so a re-uploaded artifact is not counted twice. Merge blob reports first with `npx playwright merge-reports --reporter json`.
- `simulate` prints, per shard count, the slowest shard with the built-in split and with balancing, and the lower bound. It splits by test for a `fullyParallel` suite and by file otherwise, unless `--granularity` says. `--workers` matches your CI's workers per shard. `--overhead` adds per-shard CI time (install, browsers) to `elapsed_ms` and `machine_ms`. `--target` picks the fewest shards that finish in time.
- `plan` writes `shard-<k>.txt` for `npx playwright test --test-list shard-<k>.txt`, plus `plan.json`. A `--test-list` line selects by title prefix and by the file that defines a test, so `plan` refuses a list where that would run a test twice: `--repeat-each` copies, titles that contain `›`, tests defined in a shared helper file, and a test whose title path starts another's. `--granularity test` needs a list from Playwright 1.63+, which marks serial describes.
- `check` exits 1 when a shard record is missing, the shards used different timings or plans, some shards fell back to the built-in split and others did not, a test ran in two shards, a test ran in none, or a test did not run (interrupted, max failures, or a failed setup project). `--list` names the missing tests. `--summary` appends a markdown table; pass `$GITHUB_STEP_SUMMARY`.

Exit codes: 0 done, 1 error or failed check, 2 bad arguments.

## Files

`shard-timings.json` is written by `update`; sorted keys, so it diffs cleanly if you commit it:

```json
{
 "version": 1,
 "applied": ["4be1c0d2a9f3"],
 "tests": {
  "[chromium] › auth/login.spec.ts › login › signs in": { "samples": [4120, 3980, 4310], "seen": "2026-10-15" }
 }
}
```

A key is `[project] › spec file › titles`, which is also the test's `--test-list` line unless a shared helper defines it. Entries unseen for 30 days are dropped. A setup test that every shard ran gives one sample per update.

A run record holds the shard, the strategy (`balanced`, or `builtin` with the reason), the timings, plan and test-set shas, each shard's predicted time, the measured times, and each test's outcome and duration.

## Compared with other tools

As of 2026-10-15, from each tool's published source and docs.

| | this | @flakiness/playwright 2.0.2 | @nsxbet/playwright-orchestrator 2.0.1 |
|---|---|---|---|
| Extra CI job | no | no | yes (orchestrate) |
| Playwright | 1.62+ (1.56+ with `plan`) | 1.62+ | 1.56+ |
| Serial describes kept whole | yes | yes | no |
| Lock groups kept on one shard | yes | not found | not found |
| Setup projects counted per shard | yes | yes | no |
| Workers per shard in the plan | yes | no | no |
| Algorithm | LPT and KK, refined, then bounded search | LPT with setup families | branch and bound up to 50 tests, else LPT |
| Duration estimate | median of last 5 | max across runs | EMA |
| New test | describe, file, project, suite median | 1 s | file average, else suite average, else 30 s |
| Missing timings | built-in split, or run fails in strict mode | run fails | built-in split |
| Every-test-ran-once check | yes | no | no |
| Shard-count advice | yes | no | no |
| Predicted against actual | job summary | log | no |

## Caveats

- A `--reporter` flag on the command line replaces the config's reporters, which turns balancing off. If a shard has no `playwright-shard-balancer:` log line, the reporter did not run.
- `auto` groups read Playwright internals: `_parallelMode` for parallel and serial groups, and `_locks` for lock groups. If a release removes `_parallelMode`, the reporter keeps whole files. If it removes `_locks` on Playwright 1.63+, lock groups may split. Either way the log line says so.
- The JSON list that `simulate` and `plan` read does not show `describe.configure({ mode: 'default' })` inside a parallel file, or locks. Use `--granularity file` there, or the reporter.
- Workers in a shard take groups in Playwright's load order; the plan's wall-time estimate assumes that order.
- `plan` cannot split `--repeat-each` copies or titles that contain `›`. It refuses such lists.
- Predicted times leave out Playwright's start-up; the job summary shows both test time and the whole run.

## License

MIT
