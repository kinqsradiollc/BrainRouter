import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  diagnoseWorkspaceManifestCompatibility,
  loadWorkspaceManifestWithDiagnostics,
  workspaceManifestPath,
} from '../workspace/manifest.js';
import { inspectDomainPersonas } from '../workspace/domainPersonas.js';
import {
  recordWorkspaceCompatibilityDiagnostics,
  summarizeCompatibilityTelemetry,
  type WorkspaceCompatibilityDiagnostic,
} from '../workspace/compatibilityDiagnostics.js';
import {
  setTelemetrySink,
} from '../telemetry/recorder/telemetry.js';
import type { TelemetryEvent } from '../telemetry/events/contracts.js';
import type { TelemetrySink } from '../telemetry/events/telemetryPort.js';
import { resolveWorkspaceProfileOrchestrationDefaults } from '../workspace/profileOrchestrationDefaults.js';

function memorySink(): TelemetrySink & { events: TelemetryEvent[] } {
  const events: TelemetryEvent[] = [];
  return {
    events,
    record: (event) => events.push(event),
    list: () => [...events],
    clear: () => { events.length = 0; },
  };
}

function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-compat-diagnostics-'));
}

function writeJsonPersona(dir: string, id: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
    schemaVersion: 1,
    kind: 'persona',
    id,
    displayName: 'Engineer',
    description: 'Engineering persona.',
    instructions: ['Build the smallest coherent implementation.'],
    priorities: ['correctness'],
  }));
}

function writeMarkdownPersona(dir: string, id: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.md`),
    `---\nname: ${id}\ndescription: Legacy engineering persona.\n---\nLegacy instructions.\n`,
  );
}

test('legacy manifest compatibility reports translation and implicit pairing', () => {
  const diagnostics = diagnoseWorkspaceManifestCompatibility({
    version: 1,
    profile: 'engineering',
    agents: {
      default: 'frontend-builder',
      enabled: ['frontend-builder', 'worker'],
    },
  });
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.code),
    [
      'legacy_manifest_agents',
      'legacy_orchestration_defaults',
      'implicit_same_id_pairing',
      'legacy_frontend_persona',
    ],
  );
  assert.equal(diagnostics.find((item) => item.code === 'implicit_same_id_pairing')?.severity, 'warning');
});

test('normal manifest v2 alias produces no compatibility diagnostic', () => {
  const diagnostics = diagnoseWorkspaceManifestCompatibility({
    version: 2,
    agents: { default: 'engineer', enabled: ['engineer'] },
    persona: { default: 'engineer', enabled: ['engineer'] },
    orchestration: {
      mode: 'adaptive',
      availableRoles: ['worker'],
      disabledRoles: [],
      maxParallel: 2,
    },
  });
  assert.deepEqual(diagnostics, []);
});

test('manifest load returns local diagnostics and records metadata-only events', () => {
  const workspace = tempWorkspace();
  const sink = memorySink();
  setTelemetrySink(sink);
  try {
    fs.mkdirSync(path.dirname(workspaceManifestPath(workspace)), { recursive: true });
    fs.writeFileSync(workspaceManifestPath(workspace), JSON.stringify({
      version: 1,
      profile: 'engineering',
      agents: { default: 'engineer', enabled: ['engineer'] },
    }));
    const loaded = loadWorkspaceManifestWithDiagnostics(workspace);
    assert.equal(loaded.manifest?.version, 2);
    assert.deepEqual(
      loaded.diagnostics.map((diagnostic) => diagnostic.code),
      [
        'legacy_manifest_agents',
        'legacy_orchestration_defaults',
        'implicit_same_id_pairing',
      ],
    );
    assert.deepEqual(
      sink.events.map((event) => event.name),
      [
        'compatibility_reader_used',
        'compatibility_reader_used',
        'compatibility_ambiguity_detected',
      ],
    );
    assert.equal(sink.events.every((event) => event.workspaceRoot === undefined), true);
  } finally {
    setTelemetrySink(null);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('persona inspection reports legacy use and deterministic collision provenance', () => {
  const workspace = tempWorkspace();
  const sink = memorySink();
  setTelemetrySink(sink);
  try {
    writeJsonPersona(path.join(workspace, 'personas'), 'engineer');
    writeMarkdownPersona(path.join(workspace, 'agents'), 'engineer');
    const catalog = inspectDomainPersonas(workspace, {
      pluginPersonaFiles: [],
      pluginAgentFiles: [],
      bundledPersonasDir: path.join(workspace, 'empty-json'),
      bundledDir: path.join(workspace, 'empty-markdown'),
    });

    assert.equal(catalog.personas[0]?.qualifiedName, 'workspace:engineer');
    assert.deepEqual(
      catalog.diagnostics.map((diagnostic) => diagnostic.code),
      ['legacy_markdown_persona', 'persona_collision'],
    );
    assert.deepEqual(
      sink.events.map((event) => event.name),
      ['compatibility_reader_used', 'compatibility_ambiguity_detected'],
    );
  } finally {
    setTelemetrySink(null);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('compatibility telemetry excludes paths and content and supports a measured gate summary', () => {
  const workspace = tempWorkspace();
  const sink = memorySink();
  setTelemetrySink(sink);
  try {
    const diagnostic: WorkspaceCompatibilityDiagnostic = {
      code: 'legacy_markdown_persona',
      surface: 'persona',
      severity: 'info',
      source: 'workspace',
      filePath: '/secret/project/agents/engineer.md',
      message: 'secret prompt content',
      count: 2,
    };
    recordWorkspaceCompatibilityDiagnostics(workspace, [diagnostic]);
    assert.equal(sink.events.length, 1);
    const serialized = JSON.stringify(sink.events[0]);
    assert.doesNotMatch(serialized, /secret|engineer\.md/);
    assert.deepEqual(sink.events[0].props, {
      surface: 'persona',
      code: 'legacy_markdown_persona',
      source: 'workspace',
      count: 2,
    });

    const summary = summarizeCompatibilityTelemetry(sink.events);
    assert.equal(summary.readerEvents, 1);
    assert.equal(summary.ambiguityEvents, 0);
    assert.deepEqual(summary.byCode, { legacy_markdown_persona: 2 });
    assert.equal(typeof summary.lastSeenAt, 'string');
  } finally {
    setTelemetrySink(null);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('P23-10 TypeScript orchestration fallback records one content-free reader event', () => {
  const sink = memorySink();
  setTelemetrySink(sink);
  try {
    const defaults = resolveWorkspaceProfileOrchestrationDefaults('engineering', {
      findPlan: () => undefined,
    });
    assert.equal(defaults.source, 'typescript-compatibility');
    assert.equal(defaults.planId, null);
    assert.deepEqual(sink.events.map((event) => event.props), [{
      surface: 'manifest',
      code: 'typescript_orchestration_defaults',
      source: 'bundled',
      count: 1,
    }]);
    assert.equal(sink.events[0]?.workspaceRoot, undefined);

    const summary = summarizeCompatibilityTelemetry(sink.events);
    assert.equal(summary.readerEvents, 1);
    assert.equal(summary.byCode.typescript_orchestration_defaults, 1);
  } finally {
    setTelemetrySink(null);
  }
});
