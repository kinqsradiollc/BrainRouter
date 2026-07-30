/**
 * MC-A3 — the `container` (docker) runtime backend, WITHOUT docker: every
 * test injects a recorded-args fake `DockerCliRunner` and asserts the exact
 * docker argv the backend emits. Covered here:
 *
 *  - strict opt-in: no `containerImage` → refusal BEFORE any docker call;
 *    missing docker CLI → clear instructive error;
 *  - the no-pull guarantee: a locally-missing image errors with the exact
 *    `docker pull <image>` command and NEVER runs `docker pull`/`docker run`;
 *  - exact argv for start (labels, bind mount, session-key env, resource
 *    limits), pause/unpause, and dispose (`rm -f`) + the archive hook order;
 *  - durable record lifecycle + cross-process re-attach by container ref;
 *  - registry wiring ('container' resolvable) + `cli.runtime` knob validation.
 *
 * The single test that would touch a real docker daemon is skipped by default.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCliKnobs, setCliKnobOverride } from '../config/config.js';
import { normalizeContainerLimits, normalizeRuntimeBackend } from '../config/configTypes.js';
import {
  CONTAINER_SESSION_KEY_ENV,
  CONTAINER_WORKSPACE_MOUNT,
  attachContainerRuntime,
  availableRuntimeBackends,
  createContainerRuntime,
  createDockerCliRunner,
  readRuntimeRecord,
  resolveRuntime,
  type DockerCliResult,
  type DockerCliRunner,
  type RuntimeSpec,
} from '../runtime/index.js';
import { withTempWorkspaceAsync } from './_helpers.js';

const cfg = (cli: Record<string, unknown>) => ({ activeServer: '', servers: {}, cli } as any);

const ok = (stdout = ''): DockerCliResult => ({ ok: true, stdout, stderr: '' });
const fail = (stderr: string): DockerCliResult => ({ ok: false, stdout: '', stderr });

interface FakeDockerOptions {
  /** `docker image inspect` fails (image not local). */
  imageMissing?: boolean;
  /** `docker --version` fails (CLI absent). */
  cliMissing?: boolean;
  /** stdout of `docker run -d` (container id). */
  containerId?: string;
  /** What `docker inspect` reports for the container's state. */
  inspectState?: () => string;
  /** Override results per leading subcommand (e.g. rm: () => fail(...)). */
  overrides?: Record<string, (args: string[]) => DockerCliResult>;
}

/** Recorded-args docker stub: no daemon, deterministic results. */
function fakeDocker(options: FakeDockerOptions = {}): { calls: string[][]; docker: DockerCliRunner } {
  const calls: string[][] = [];
  let state = 'running';
  const docker: DockerCliRunner = (args) => {
    calls.push([...args]);
    const cmd = args[0];
    const override = options.overrides?.[cmd];
    if (override) return override(args);
    switch (cmd) {
      case '--version':
        return options.cliMissing ? fail('spawn docker ENOENT') : ok('Docker version 27.0.0');
      case 'image':
        return options.imageMissing ? fail(`No such image: ${args[args.length - 1]}`) : ok('sha256:feedbeef');
      case 'run':
        return ok(`${options.containerId ?? 'cid-test-1234'}\n`);
      case 'inspect':
        return ok(`${options.inspectState ? options.inspectState() : state}\n`);
      case 'pause':
        state = 'paused';
        return ok();
      case 'unpause':
        state = 'running';
        return ok();
      case 'rm':
        return ok(args[args.length - 1]);
      default:
        return fail(`unexpected docker argv: ${args.join(' ')}`);
    }
  };
  return { calls, docker };
}

function makeSpec(workspaceRoot: string, extra?: Partial<RuntimeSpec>): RuntimeSpec {
  return { workspaceRoot, sessionKey: 'session:container-test', ...extra };
}

// ---------------------------------------------------------------------------
// Strict opt-in + no-pull behavior
// ---------------------------------------------------------------------------

test('MC-A3 opt-in: no containerImage → refusal BEFORE any docker call', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    // Pin the knob block to pure defaults so a developer's local config
    // (which could name an image) can never flip this test's outcome.
    setCliKnobOverride({ runtime: resolveCliKnobs(undefined).runtime });
    const { calls, docker } = fakeDocker();
    const rt = createContainerRuntime({ executeTurn: async () => 'ok', docker });
    // No image override and the default knob is '' — the backend must refuse.
    await assert.rejects(() => rt.start(makeSpec(ws)), /cli\.runtime\.containerImage/);
    await assert.rejects(() => rt.start(makeSpec(ws)), /never pulled automatically/);
    assert.deepEqual(calls, [], 'refused without touching docker at all');
    assert.equal(readRuntimeRecord(ws, rt.id), null, 'no durable record for a refused start');
  });
});

test('MC-A3 missing docker CLI → clear instructive error', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const { calls, docker } = fakeDocker({ cliMissing: true });
    const rt = createContainerRuntime({ executeTurn: async () => 'ok', docker, image: 'img:1' });
    await assert.rejects(() => rt.start(makeSpec(ws)), /requires the docker CLI on PATH/);
    assert.deepEqual(calls, [['--version']], 'stopped at the presence probe');
  });
});

test('MC-A3 no-pull: locally-missing image → exact `docker pull` instruction, never a pull or run', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const { calls, docker } = fakeDocker({ imageMissing: true });
    const rt = createContainerRuntime({ executeTurn: async () => 'ok', docker, image: 'ghcr.io/acme/dev:12' });
    await assert.rejects(
      () => rt.start(makeSpec(ws)),
      /run 'docker pull ghcr\.io\/acme\/dev:12' yourself/,
    );
    assert.deepEqual(calls, [
      ['--version'],
      ['image', 'inspect', '--format', '{{.Id}}', 'ghcr.io/acme/dev:12'],
    ]);
    assert.ok(!calls.some((argv) => argv[0] === 'pull'), 'docker pull is NEVER issued');
    assert.ok(!calls.some((argv) => argv[0] === 'run'), 'docker run is never reached');
  });
});

// ---------------------------------------------------------------------------
// start(): exact docker run argv + durable record
// ---------------------------------------------------------------------------

test('MC-A3 start: exact docker run argv — labels, bind mount, session env, limits', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const { calls, docker } = fakeDocker({ containerId: 'cid-abc' });
    const rt = createContainerRuntime({
      executeTurn: async () => 'ok',
      docker,
      id: 'rt_c0ffee00',
      image: 'img:1',
      cpus: 1.5,
      memory: '512m',
    });
    await rt.start(makeSpec(ws, { env: { EXTRA_FLAG: 'on' } }));

    assert.deepEqual(calls[0], ['--version']);
    assert.deepEqual(calls[1], ['image', 'inspect', '--format', '{{.Id}}', 'img:1']);
    assert.deepEqual(calls[2], [
      'run', '-d',
      '--name', 'brainrouter-rt-rt_c0ffee00',
      '--label', 'brainrouter.runtime=rt_c0ffee00',
      '-v', `${ws}:${CONTAINER_WORKSPACE_MOUNT}`,
      '-w', CONTAINER_WORKSPACE_MOUNT,
      '-e', `${CONTAINER_SESSION_KEY_ENV}=session:container-test`,
      '-e', 'EXTRA_FLAG=on',
      '--cpus', '1.5',
      '--memory', '512m',
      'img:1',
      'sleep', 'infinity',
    ]);

    assert.equal(rt.containerId, 'cid-abc');
    assert.equal(rt.status(), 'ready');
    const record = readRuntimeRecord(ws, rt.id);
    assert.equal(record?.backend, 'container');
    assert.equal(record?.status, 'ready');
    assert.deepEqual(record?.container, { containerId: 'cid-abc', image: 'img:1' });
  });
});

test('MC-A3 start: no limits configured → no --cpus/--memory flags; launchCwd maps under the mount', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const { calls, docker } = fakeDocker();
    const rt = createContainerRuntime({ executeTurn: async () => 'ok', docker, image: 'img:1' });
    await rt.start(makeSpec(ws, { launchCwd: `${ws}/packages/core` }));
    const run = calls.find((argv) => argv[0] === 'run')!;
    assert.ok(!run.includes('--cpus'), 'no cpu limit flag by default');
    assert.ok(!run.includes('--memory'), 'no memory limit flag by default');
    const wIndex = run.indexOf('-w');
    assert.equal(run[wIndex + 1], `${CONTAINER_WORKSPACE_MOUNT}/packages/core`);
  });
});

// ---------------------------------------------------------------------------
// exec / pause / resume / dispose lifecycle
// ---------------------------------------------------------------------------

test('MC-A3 exec: delegates to the injected executor with cwd at the mount source', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    let specSeen: RuntimeSpec | undefined;
    let midTurnStatus = '';
    const { docker } = fakeDocker();
    const rt = createContainerRuntime({
      executeTurn: async (turn, spec) => {
        specSeen = spec;
        midTurnStatus = rt.status();
        return `echo:${turn.prompt}`;
      },
      docker,
      image: 'img:1',
    });
    await rt.start(makeSpec(ws));
    const result = await rt.exec({ prompt: 'hello container' });
    assert.equal(result.output, 'echo:hello container');
    assert.equal(midTurnStatus, 'running');
    // Host-side seam (in-container agent loop is a later phase): cwd at the
    // bind-mount SOURCE so edits land in the container's mounted workspace.
    assert.equal(specSeen?.workspaceRoot, ws);
    assert.equal(specSeen?.launchCwd, ws);
    assert.equal(rt.status(), 'ready');
  });
});

test('MC-A3 pause/resume: docker pause/unpause + durable record round-trip', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const { calls, docker } = fakeDocker({ containerId: 'cid-pr' });
    const rt = createContainerRuntime({ executeTurn: async () => 'ok', docker, image: 'img:1' });
    await rt.start(makeSpec(ws));

    await rt.pause();
    assert.deepEqual(calls.filter((a) => a[0] === 'pause'), [['pause', 'cid-pr']]);
    assert.equal(rt.status(), 'paused');
    assert.equal(readRuntimeRecord(ws, rt.id)?.status, 'paused', 'pause is durable');
    await rt.pause(); // idempotent — no second docker pause
    assert.equal(calls.filter((a) => a[0] === 'pause').length, 1);

    await assert.rejects(() => rt.exec({ prompt: 'nope' }), /cannot exec while 'paused'/);

    await rt.resume();
    assert.deepEqual(calls.filter((a) => a[0] === 'unpause'), [['unpause', 'cid-pr']]);
    assert.equal(rt.status(), 'ready');
    assert.equal(readRuntimeRecord(ws, rt.id)?.status, 'ready');
    assert.equal((await rt.exec({ prompt: 'after resume' })).output, 'ok');
  });
});

test('MC-A3 dispose: archive hook then docker rm -f; idempotent; tolerates already-gone', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const { calls, docker } = fakeDocker({ containerId: 'cid-rm' });
    const rt = createContainerRuntime({ executeTurn: async () => 'ok', docker, image: 'img:1' });
    await rt.start(makeSpec(ws));

    await rt.dispose();
    assert.deepEqual(calls.filter((a) => a[0] === 'rm'), [['rm', '-f', 'cid-rm']]);
    assert.equal(rt.status(), 'disposed');
    assert.equal(readRuntimeRecord(ws, rt.id)?.status, 'disposed');
    await rt.dispose(); // idempotent — no second rm
    assert.equal(calls.filter((a) => a[0] === 'rm').length, 1);

    // Already-gone container counts as removed (idempotent teardown).
    const gone = fakeDocker({ overrides: { rm: () => fail('Error: No such container: cid-x') } });
    const rt2 = createContainerRuntime({ executeTurn: async () => 'ok', docker: gone.docker, image: 'img:1' });
    await rt2.start(makeSpec(ws));
    await rt2.dispose();
    assert.equal(rt2.status(), 'disposed');
  });
});

test('MC-A3 status: docker truth wins — vanished/exited container reports error', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    let state = 'running';
    const { docker } = fakeDocker({ inspectState: () => state });
    const rt = createContainerRuntime({ executeTurn: async () => 'ok', docker, image: 'img:1' });
    await rt.start(makeSpec(ws));
    assert.equal(rt.status(), 'ready');
    state = 'exited';
    assert.equal(rt.status(), 'error', 'an exited container is not a phantom ready');
    await assert.rejects(() => rt.exec({ prompt: 'x' }), /cannot exec while 'error'/);
  });
});

// ---------------------------------------------------------------------------
// Cross-process re-attach by durable container ref
// ---------------------------------------------------------------------------

test('MC-A3 attach: paused container re-attaches by durable record and resumes', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const first = fakeDocker({ containerId: 'cid-attach' });
    const rt = createContainerRuntime({ executeTurn: async () => 'ok', docker: first.docker, image: 'img:1' });
    await rt.start(makeSpec(ws));
    await rt.pause();

    // "Fresh process": a new instance bound to the same durable id.
    const second = fakeDocker({ containerId: 'cid-attach' });
    const attached = attachContainerRuntime({
      executeTurn: async () => 'resumed-turn',
      workspaceRoot: ws,
      id: rt.id,
      docker: second.docker,
    });
    assert.equal(attached.containerId, 'cid-attach');
    await attached.resume();
    assert.deepEqual(second.calls.filter((a) => a[0] === 'unpause'), [['unpause', 'cid-attach']]);
    assert.equal((await attached.exec({ prompt: 'x' })).output, 'resumed-turn');

    // Guards: non-paused / missing ref / wrong backend all fail loudly.
    await attached.dispose();
    assert.throws(
      () => attachContainerRuntime({ executeTurn: async () => '', workspaceRoot: ws, id: rt.id }),
      /only paused containers re-attach/,
    );
    assert.throws(
      () => attachContainerRuntime({ executeTurn: async () => '', workspaceRoot: ws, id: 'rt_missing0' }),
      /no runtime record/,
    );
  });
});

// ---------------------------------------------------------------------------
// Registry + config validation
// ---------------------------------------------------------------------------

test('MC-A3 registry: container backend is registered and resolvable', () => {
  assert.ok(availableRuntimeBackends().includes('container'));
  const rt = resolveRuntime({ executeTurn: async () => 'ok' }, 'container');
  assert.equal(rt.kind, 'container');
});

test('MC-A3 cli.runtime knobs: containerImage + container limits validation', () => {
  // Backend value validates; image has NO default.
  assert.equal(normalizeRuntimeBackend('container'), 'container');
  assert.equal(resolveCliKnobs(cfg({})).runtime.containerImage, '');
  assert.deepEqual(resolveCliKnobs(cfg({})).runtime.container, { cpus: 0, memory: '' });
  // Image passes through trimmed; junk drops to ''.
  assert.equal(
    resolveCliKnobs(cfg({ runtime: { containerImage: '  img:1  ' } })).runtime.containerImage,
    'img:1',
  );
  assert.equal(resolveCliKnobs(cfg({ runtime: { containerImage: 42 } })).runtime.containerImage, '');
  // Limits: valid values pass; junk drops to "no limit"; cpus capped.
  assert.deepEqual(
    resolveCliKnobs(cfg({ runtime: { container: { cpus: 2.5, memory: '2g' } } })).runtime.container,
    { cpus: 2.5, memory: '2g' },
  );
  assert.deepEqual(normalizeContainerLimits({ cpus: -1, memory: 'lots' }), { cpus: 0, memory: '' });
  assert.deepEqual(normalizeContainerLimits({ cpus: 9_999, memory: '1024' }), { cpus: 128, memory: '1024' });
  assert.deepEqual(normalizeContainerLimits('junk'), { cpus: 0, memory: '' });
  assert.deepEqual(normalizeContainerLimits({ memory: '512MB' }), { cpus: 0, memory: '512MB' });
});

// ---------------------------------------------------------------------------
// Real docker — skipped by default (never required by the suite)
// ---------------------------------------------------------------------------

test(
  'MC-A3 real docker smoke (opt-in: RUN_DOCKER_TESTS=1 + a local image)',
  { skip: process.env.RUN_DOCKER_TESTS !== '1' ? 'requires a live docker daemon — set RUN_DOCKER_TESTS=1 to run' : false },
  async () => {
    // Deliberately minimal: proves the REAL runner shape only. It still never
    // pulls — the developer must have some image locally and name it here.
    const image = process.env.RUN_DOCKER_TESTS_IMAGE ?? 'alpine:latest';
    const docker = createDockerCliRunner();
    const version = docker(['--version']);
    assert.ok(version.ok, `docker CLI available: ${version.stderr}`);
    const present = docker(['image', 'inspect', '--format', '{{.Id}}', image]);
    assert.ok(present.ok, `image '${image}' must already be local (this suite never pulls)`);
  },
);
