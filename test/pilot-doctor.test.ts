import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGraph } from '../src/graph/build.js';
import { beginExport, completeExport } from '../src/graph/source-state.js';
// The standalone operator check intentionally exercises the built runtime.
// @ts-ignore plain JavaScript operator entry point
import { diagnoseInstallation, supportsNodeVersion } from '../pilot/doctor.mjs';

test('doctor rejects Node versions below the locked CLI dependency minimum', () => {
  for (const version of ['20.19.0', '22.0.0', '22.9.0', '22.11.99', '22.12.0-rc.1', 'unknown']) assert.equal(supportsNodeVersion(version), false, version);
  for (const version of ['22.12.0', '22.23.2', '24.19.0', '26.7.0']) assert.equal(supportsNodeVersion(version), true, version);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(pkg.engines.node, '>=22.12.0');
  assert.equal(lock.packages[''].engines.node, pkg.engines.node);
  assert.equal(lock.packages['node_modules/commander'].engines.node, pkg.engines.node);
});

test('doctor checks a protected installation and diagnoses interrupted export without altering it', async () => {
  const base = mkdtempSync(join(tmpdir(), 'graft-doctor-'));
  try {
    const root = join(base, 'repo'), out = join(base, 'graph'), state = join(base, 'state.json'), config = join(base, 'config.json');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/ztest.prog.abap'), 'REPORT ztest.');
    completeExport(root, state, beginExport(root, root, state).generation);
    mkdirSync(join(out, '.graph'), { recursive: true });
    writeFileSync(join(out, '.graph/source-policy.json'), JSON.stringify({ sourceState: state, onlyDirs: ['src'] }));
    writeFileSync(config, JSON.stringify({ repository: root, graphDirectory: out, abapVersion: '7.50', sourceState: state }));
    await buildGraph(root, { contextDir: out, onlyDirs: ['src'] });
    const before = readFileSync(join(out, '.graph/wiring.json'), 'utf8');
    assert.equal((await diagnoseInstallation(config)).ok, true);
    beginExport(root, root, state);
    const result = await diagnoseInstallation(config);
    assert.equal(result.ok, false); assert.ok(result.checks.some((c: { id: string; ok: boolean }) => c.id === 'export' && !c.ok));
    assert.equal(JSON.parse(readFileSync(state, 'utf8')).status, 'updating');
    assert.equal(readFileSync(join(out, '.graph/wiring.json'), 'utf8'), before);
    writeFileSync(config, '{}');
    assert.equal((await diagnoseInstallation(config)).ok, false);
    assert.equal((await diagnoseInstallation(join(base, 'absent.json'))).ok, false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
