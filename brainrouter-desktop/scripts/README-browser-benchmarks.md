# First-class browser E2E and performance qualification

These scripts drive the real BrainRouter Electron app and its main-owned
`WebContentsView` tabs. They use Electron/Chrome DevTools Protocol endpoints and
Node built-ins only: no Playwright, public website, third-party browser service,
or production account is involved.

## Reproducible commands

From the repository root:

```sh
npm run test:browser:e2e -w brainrouter-desktop
npm run bench:browser:compare -w brainrouter-desktop -- --runs 20
```

The E2E command measures blank-tab creation, browser-bridge dispatch, 1/20/50
native tabs, 1,000 warm switches with form/scroll retention, 100 create/close
cycles, crash state, and the Electron process tree at one and twenty tabs. The
comparison command launches a temporary-profile local Chrome or Edge on the
same machine and records warm loopback navigation, tab creation/switching, CPU,
and RSS for both runtimes.

Reports are written atomically with mode `0600` to:

- `.browser-benchmarks/browser-e2e-latest.json`
- `.browser-benchmarks/browser-comparison-latest.json`

Use `--report /absolute/path/report.json` to retain a timestamped CI artifact,
`--electron-app /path/to/BrainRouter.app` to test a packaged build, and
`--browser /path/to/chrome-or-edge` to override browser discovery. `--quick` is
diagnostic only; its reduced 50-tab/stability gates are explicitly marked
`skip` in the JSON instead of being presented as release evidence.

## Gate policy

Absolute BrainRouter gates that are reliable on ordinary hosts fail every run:

- blank-tab creation p95 <= 250 ms;
- warm tab switch p95 <= 100 ms;
- browser-command bridge dispatch p95 <= 50 ms;
- exact active-tab state retention and lifecycle invariants.

Hardware-sensitive Chrome/Edge ratios are recorded everywhere but enforced only
when either `BRAINROUTER_BROWSER_STABLE_RUNNER=1` or
`--enforce-comparison` is set. The qualifying runner must be idle, fixed-power,
thermally stable, and use the same local fixture and run count for both browsers.
That prevents a noisy generic CI worker from producing a false pass or failure.

```sh
BRAINROUTER_BROWSER_STABLE_RUNNER=1 \
  npm run bench:browser:compare -w brainrouter-desktop -- --runs 20 \
  --report "$PWD/browser-performance-${RUNNER_NAME:-local}.json"
```

If Chrome/Edge, process-tree sampling, or a standards asset is unavailable, the
corresponding gate is `skip` with a concrete reason. Speedometer 3 and
representative-page Web Vitals remain separately scheduled standards runs: the
loopback harness deliberately does not download their assets or invent scores.
The command exits non-zero whenever any enforced gate fails.
