import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sha256, planHash, fingerprintSources, fingerprintVerifiedSources, artifactReader, validatePlan, evaluateExperiment, markdownReport } from '../scripts/evaluate-abap-benefit.mjs';
import { beginExport, completeExport } from '../src/graph/source-state.js';

const fixture = (pairCount = 1) => {
  const plan: any = { format: 1, id: 'synthetic-test-only', status: 'frozen', frozenAt: '2026-09-16T23:00:00.000Z', sourceFingerprint: sha256('fixture sources'), modelKey: 'provider/model/revision/settings',
    protocol: 'Same tools except Graft; fresh sessions; full-task usage; synthetic test, not a real benefit observation.',
    conditions: { baseline: 'Search and read, no Graft', graft: 'Same tools plus Graft fixture' },
    tasks: [{ id: 'one', question: 'Synthetic question', cohort: 'development', criteria: [{ id: 'source', description: 'Answer agrees with the independent fixture source' }] }],
    pairs: Array.from({ length: pairCount }, (_, index) => ({ id: `pair-${index}`, task: 'one', graphState: 'warm', order: index % 2 ? ['graft', 'baseline'] : ['baseline', 'graft'] })) };
  const artifacts = new Map<string, Buffer>();
  const records: any[] = [];
  for (const [index, pair] of plan.pairs.entries()) for (const [position, arm] of pair.order.entries()) {
    const prefix = `${pair.id}-${arm}`, start = Date.UTC(2026, 8, 17) + index * 10000 + position * 1000;
    const answer = Buffer.from(`PRIVATE FIXTURE ANSWER ${prefix}`), trace = Buffer.from(`PRIVATE FIXTURE TRACE ${prefix} counter-${prefix}`);
    artifacts.set(`${prefix}.answer.txt`, answer); artifacts.set(`${prefix}.trace.txt`, trace);
    records.push({ pair: pair.id, arm, planHash: planHash(plan), sourceFingerprint: plan.sourceFingerprint, sourceFingerprintAfter: plan.sourceFingerprint, modelKey: plan.modelKey,
      sessionId: prefix, freshSession: true, outcome: 'completed', startedAt: new Date(start).toISOString(),
      finishedAt: new Date(start + (arm === 'baseline' ? 200 : 100)).toISOString(), toolCalls: arm === 'baseline' ? 5 : 3,
      fileReads: arm === 'baseline' ? 4 : 2, toolRounds: 2, sapReads: 0,
      usage: { source: 'provider_reported', accounting: 'input_including_cache_output_including_reasoning',
        inputTokens: arm === 'baseline' ? 100 : 60, outputTokens: arm === 'baseline' ? 20 : 10, counterReference: `counter-${prefix}` },
      artifacts: { answer: { path: `${prefix}.answer.txt`, sha256: sha256(answer) }, trace: { path: `${prefix}.trace.txt`, sha256: sha256(trace) } },
      review: { reviewer: 'independent-fixture-reviewer', protocolCompliant: true, unsupportedClaims: 0, criteria: { source: true } } });
  }
  const read = (path: string) => { assert.ok(artifacts.has(path), `missing fixture artifact ${path}`); return artifacts.get(path)!; };
  return { plan, records, artifacts, read, evaluate: () => evaluateExperiment(plan, records, read) };
};

test('paired full-task metrics and independently reviewed correctness are reported separately', () => {
  const f = fixture(), report = f.evaluate(), s = report.strata[0];
  assert.equal(report.complete, true); assert.equal(report.verifiedArtifacts, 4);
  assert.equal(s.quality.baseline.correct, 1); assert.equal(s.quality.graft.correct, 1);
  assert.equal(s.paired.elapsedMs.reductionPercent, 50);
  assert.equal(s.paired.totalTokens.baseline.total, 120); assert.equal(s.paired.totalTokens.graft.total, 70);
  assert.equal(s.paired.totalTokens.difference, 50);
  assert.equal(s.paired.fileReads.reductionPercent, 50);
  assert.equal(s.effortIncludingFailedRuns.baseline.totalTokens.totalPerCorrectRun, 120);
  assert.equal(s.tasks[0].paired.elapsedMs.baseline.median, 200);
  assert.doesNotMatch(JSON.stringify(report) + markdownReport(report), /PRIVATE FIXTURE|counter-pair|answer\.txt/);
});

test('an unrun plan reports unknown savings rather than fabricated zero-cost or success', () => {
  const f = fixture(), report = evaluateExperiment(f.plan, [], f.read), s = report.strata[0];
  assert.equal(report.complete, false); assert.equal(report.recordedRuns, 0);
  assert.equal(s.quality.baseline.missing, 1); assert.equal(s.quality.graft.correct, 0);
  assert.equal(s.paired.totalTokens.reductionPercent, null); assert.equal(s.paired.elapsedMs.baseline.total, null);
  assert.equal(s.effortIncludingFailedRuns.baseline.elapsedMs.totalPerCorrectRun, null);
  assert.match(markdownReport(report), /0\/2 Läufe/); assert.match(markdownReport(report), /unbekannt/);
});

test('missing provider usage and read counters remain unknown without suppressing known time data', () => {
  const f = fixture(); f.records[1].usage = null; f.records[1].fileReads = null;
  const s = f.evaluate().strata[0];
  assert.equal(s.paired.elapsedMs.pairedCount, 1); assert.equal(s.paired.totalTokens.pairedCount, 0);
  assert.equal(s.paired.totalTokens.excludedForMissingMetric, 1); assert.equal(s.paired.fileReads.reductionPercent, null);
  assert.equal(s.effortIncludingFailedRuns.graft.totalTokens.known, 0);
  assert.equal(s.effortIncludingFailedRuns.graft.totalTokens.totalPerCorrectRun, null);
});

test('failed attempts are visible in quality and total effort per successful run', () => {
  const f = fixture(2), failed = f.records.find(r => r.pair === 'pair-1' && r.arm === 'baseline');
  failed.outcome = 'failed'; failed.review = null;
  const s = f.evaluate().strata[0];
  assert.equal(s.quality.baseline.failed, 1); assert.equal(s.paired.elapsedMs.pairedCount, 1);
  assert.equal(s.paired.elapsedMs.excludedForQualityOrMissingRun, 1);
  assert.equal(s.effortIncludingFailedRuns.baseline.elapsedMs.totalPerCorrectRun, 400);
  assert.equal(s.effortIncludingFailedRuns.graft.elapsedMs.totalPerCorrectRun, 100);
});

test('false claims, wrong answers and protocol violations never count as a faster correct answer', () => {
  for (const change of [(r: any) => r.review.unsupportedClaims = 1, (r: any) => r.review.criteria.source = false,
    (r: any) => r.review.protocolCompliant = false]) {
    const f = fixture(); change(f.records[1]); const s = f.evaluate().strata[0];
    assert.equal(s.quality.graft.incorrect, 1); assert.equal(s.paired.elapsedMs.reductionPercent, null);
    assert.equal(s.effortIncludingFailedRuns.graft.elapsedMs.totalPerCorrectRun, null);
  }
});

test('unreviewed or partially reviewed answers do not enter paired savings or final effort ratios', () => {
  for (const change of [(r: any) => r.review = null, (r: any) => r.review.criteria.source = null,
    (r: any) => r.review.protocolCompliant = null, (r: any) => r.review.unsupportedClaims = null]) {
    const f = fixture(); change(f.records[1]); const report = f.evaluate(), s = report.strata[0];
    assert.equal(report.complete, false); assert.equal(s.quality.graft.unreviewed, 1);
    assert.equal(s.paired.totalTokens.pairedCount, 0); assert.equal(s.effortIncludingFailedRuns.graft.elapsedMs.totalPerCorrectRun, null);
  }
});

test('zero denominators stay undefined and negative resource differences remain negative', () => {
  const f = fixture(); f.records[0].fileReads = 0; f.records[1].usage.inputTokens = 200;
  const s = f.evaluate().strata[0];
  assert.equal(s.paired.fileReads.reductionPercent, null); assert.equal(s.paired.fileReads.difference, -2);
  assert.equal(s.paired.totalTokens.reductionPercent, -75);
});

test('source, model/settings and frozen-plan mismatches are explicit errors', () => {
  for (const key of ['sourceFingerprint', 'sourceFingerprintAfter', 'modelKey', 'planHash']) {
    const f = fixture(); f.records[1][key] += 'changed'; assert.throws(f.evaluate, /differs/);
  }
  const f = fixture(); f.plan.tasks[0].criteria[0].description += 'changed'; assert.throws(f.evaluate, /differs/);
  assert.equal(planHash({ b: 1, a: { d: 2, c: 3 } }), planHash({ a: { c: 3, d: 2 }, b: 1 }));
});

test('draft plans and observations predating the frozen plan cannot be treated as completed experiments', () => {
  const f = fixture(); f.plan.status = 'draft'; f.plan.frozenAt = null;
  assert.throws(f.evaluate, /Freeze/);
  const empty = evaluateExperiment(f.plan, [], f.read); assert.equal(empty.planStatus, 'draft'); assert.equal(empty.complete, false);
  const late = fixture(); late.plan.frozenAt = '2026-09-18T00:00:00.000Z'; late.records.forEach(r => r.planHash = planHash(late.plan));
  assert.throws(late.evaluate, /timestamps/);
});

test('duplicate, foreign and reused-session observations cannot masquerade as independent repetitions', () => {
  for (const change of [(f: any) => f.records.push(f.records[0]), (f: any) => f.records[1].pair = 'unknown',
    (f: any) => f.records[1].sessionId = f.records[0].sessionId, (f: any) => f.records[1].freshSession = false]) {
    const f = fixture(); change(f); assert.throws(f.evaluate, /Duplicate|planned|fresh/);
  }
});

test('artifact content changes invalidate a recorded answer or trace', () => {
  for (const kind of ['answer', 'trace']) {
    const f = fixture(); f.artifacts.set(f.records[0].artifacts[kind].path, Buffer.from('changed'));
    assert.throws(f.evaluate, /artifact content differs/);
  }
});

test('estimated, missing, unsafe or untraceable token counters are rejected', () => {
  for (const change of [(r: any) => r.usage.source = 'estimated', (r: any) => r.usage.accounting = 'input_excluding_cache',
    (r: any) => r.usage.inputTokens = -1, (r: any) => r.usage.inputTokens = 1.5,
    (r: any) => r.usage.inputTokens = Number.MAX_SAFE_INTEGER, (r: any) => delete r.usage,
    (r: any) => r.usage.counterReference = 'not in retained trace']) {
    const f = fixture(); change(f.records[1]); assert.throws(f.evaluate, /Usage|token/);
  }
});

test('counter omissions, unfinished timestamps and unknown review criteria are rejected', () => {
  for (const change of [(r: any) => delete r.fileReads, (r: any) => r.toolCalls = -1,
    (r: any) => r.startedAt = '2026-09-17', (r: any) => r.finishedAt = 'unfinished',
    (r: any) => r.review.criteria.extra = true, (r: any) => r.review.reviewer = '']) {
    const f = fixture(); change(f.records[1]); assert.throws(f.evaluate, /Invalid|criteria|review/);
  }
});

test('overlapping or reversed arms cannot silently contradict the planned order', () => {
  const f = fixture(); f.records[1].startedAt = f.records[0].startedAt;
  assert.throws(f.evaluate, /order overlaps/);
});

test('development/held-out tasks and cold/warm states remain distinct and retain task-level statistics', () => {
  const f = fixture(4);
  f.plan.tasks.push({ ...structuredClone(f.plan.tasks[0]), id: 'two', cohort: 'held_out' });
  f.plan.pairs[1].graphState = 'cold'; f.plan.pairs[2].task = 'two'; f.plan.pairs[3].task = 'two'; f.plan.pairs[3].graphState = 'cold';
  f.records.forEach(r => r.planHash = planHash(f.plan));
  const report = f.evaluate(); assert.equal(report.strata.length, 4);
  for (const s of report.strata) { assert.equal(s.plannedPairs, 1); assert.equal(s.tasks.length, 1); assert.equal(s.tasks[0].paired.totalTokens.pairedCount, 1); }
});

test('incomplete plans, duplicate criteria and unsupported graph states are rejected', () => {
  for (const change of [(p: any) => p.pairs = [], (p: any) => p.tasks[0].criteria.push(p.tasks[0].criteria[0]),
    (p: any) => p.pairs[0].graphState = 'unspecified', (p: any) => p.pairs[0].order = ['graft', 'graft'],
    (p: any) => p.tasks[0].cohort = 'unknown']) {
    const f = fixture(); change(f.plan); assert.throws(() => validatePlan(f.plan));
  }
});

test('source fingerprints include raw contents, relative names and XML while ignoring files outside src', () => {
  const root = mkdtempSync(join(tmpdir(), 'graft-benefit-snapshot-'));
  try {
    mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/a.abap'), 'REPORT a.'); writeFileSync(join(root, 'src/a.xml'), '<a/>');
    const initial = fingerprintSources(root); assert.equal(initial.files, 2);
    writeFileSync(join(root, 'notes.txt'), 'not exported source'); assert.deepEqual(fingerprintSources(root), initial);
    writeFileSync(join(root, 'src/a.xml'), '<b/>'); assert.notEqual(fingerprintSources(root).sha256, initial.sha256);
    writeFileSync(join(root, 'src/a.xml'), '<a/>'); renameSync(join(root, 'src/a.abap'), join(root, 'src/b.abap'));
    assert.notEqual(fingerprintSources(root).sha256, initial.sha256);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('artifact reader rejects traversal, absolute paths and links outside the evidence directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'graft-benefit-artifacts-'));
  try {
    mkdirSync(join(root, 'evidence')); mkdirSync(join(root, 'outside')); writeFileSync(join(root, 'outside/trace.txt'), 'fixture');
    symlinkSync(join(root, 'outside'), join(root, 'evidence/link'), 'junction');
    const read = artifactReader(join(root, 'evidence'));
    for (const path of ['../outside/trace.txt', join(root, 'outside/trace.txt'), 'link/trace.txt']) assert.throws(() => read(path), /contained|escapes/);
    assert.throws(() => fingerprintSources(join(root, 'evidence')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('offline CLI renders an unrun experiment and refuses to overwrite an existing report', () => {
  const root = mkdtempSync(join(tmpdir(), 'graft-benefit-cli-'));
  try {
    const f = fixture(); writeFileSync(join(root, 'plan.json'), JSON.stringify(f.plan)); writeFileSync(join(root, 'runs.json'), '[]');
    const script = join(dirname(fileURLToPath(import.meta.url)), '../scripts/evaluate-abap-benefit.mjs');
    const args = [script, 'summarize', '--plan', join(root, 'plan.json'), '--runs', join(root, 'runs.json'), '--out', join(root, 'report')];
    const first = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(readFileSync(join(root, 'report/result.json'), 'utf8')).complete, false);
    const again = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true });
    assert.equal(again.status, 1); assert.match(again.stderr, /already exists/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('offline CLI evaluates complete retained evidence and rejects tampered traces before writing a report', () => {
  const root = mkdtempSync(join(tmpdir(), 'graft-benefit-complete-cli-'));
  try {
    const f = fixture(); writeFileSync(join(root, 'plan.json'), JSON.stringify(f.plan)); writeFileSync(join(root, 'runs.json'), JSON.stringify(f.records));
    for (const [path, data] of f.artifacts) writeFileSync(join(root, path), data);
    const script = join(dirname(fileURLToPath(import.meta.url)), '../scripts/evaluate-abap-benefit.mjs');
    const args = [script, 'summarize', '--plan', join(root, 'plan.json'), '--runs', join(root, 'runs.json'), '--out'];
    const first = spawnSync(process.execPath, [...args, join(root, 'valid')], { encoding: 'utf8', windowsHide: true });
    assert.equal(first.status, 0, first.stderr);
    const report = JSON.parse(readFileSync(join(root, 'valid/result.json'), 'utf8'));
    assert.equal(report.complete, true); assert.equal(report.strata[0].paired.totalTokens.difference, 50);
    assert.equal(report.strata[0].paired.elapsedMs.pairedDifferences.median, 100);
    writeFileSync(join(root, f.records[1].artifacts.trace.path), 'tampered fixture trace');
    const changed = spawnSync(process.execPath, [...args, join(root, 'invalid')], { encoding: 'utf8', windowsHide: true });
    assert.equal(changed.status, 1); assert.match(changed.stderr, /trace artifact content differs/);
    assert.equal(existsSync(join(root, 'invalid/result.json')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function protectedSnapshotFixture() {
  const base = mkdtempSync(join(tmpdir(), 'graft-benefit-protected-'));
  const root = join(base, 'repo'), state = join(base, 'export.json');
  mkdirSync(join(root, 'src/nested'), { recursive: true });
  writeFileSync(join(root, 'src/z.prog.abap'), 'REPORT z.\r\n');
  writeFileSync(join(root, 'src/nested/a.xml'), '<abapGit/>\n');
  const generation = beginExport(root, root, state).generation;
  completeExport(root, state, generation);
  const script = fileURLToPath(new URL('../scripts/evaluate-abap-benefit.mjs', import.meta.url));
  const args = [script, 'fingerprint', root, '--source-state', state];
  return { base, root, state, generation, args,
    run: (prefix: string[] = []) => spawnSync(process.execPath, [...prefix, ...args], { encoding: 'utf8', windowsHide: true }),
    cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('verified fingerprint preserves the content hash, includes XML and never writes sources or producer state', async () => {
  const f = protectedSnapshotFixture();
  try {
    const before = readFileSync(f.state), unguarded = fingerprintSources(f.root);
    const result = await fingerprintVerifiedSources(f.root, f.state);
    assert.deepEqual(result, { ...unguarded, sourceState: { status: 'ready', generation: f.generation } });
    assert.equal(result.files, 2);
    assert.deepEqual(readFileSync(f.state), before); assert.deepEqual(fingerprintSources(f.root), unguarded);
    const cli = f.run(); assert.equal(cli.status, 0, cli.stderr); assert.deepEqual(JSON.parse(cli.stdout), result);
    const plain = spawnSync(process.execPath, f.args.slice(0, 3), { encoding: 'utf8', windowsHide: true });
    assert.equal(plain.status, 0, plain.stderr); assert.deepEqual(JSON.parse(plain.stdout), { ...unguarded, sourceState: null });
  } finally { f.cleanup(); }
});

test('updating exports fail without a fingerprint even before any source changes', async () => {
  const f = protectedSnapshotFixture();
  try {
    beginExport(f.root, f.root, f.state);
    await assert.rejects(fingerprintVerifiedSources(f.root, f.state), /still updating/);
    const cli = f.run(); assert.equal(cli.status, 1); assert.equal(cli.stdout, ''); assert.match(cli.stderr, /still updating/);
  } finally { f.cleanup(); }
});

test('ready status cannot hide changed XML, missing files, additional files or renamed paths', async () => {
  for (const change of [
    (f: any) => writeFileSync(join(f.root, 'src/nested/a.xml'), '<changed/>'),
    (f: any) => rmSync(join(f.root, 'src/z.prog.abap')),
    (f: any) => writeFileSync(join(f.root, 'src/extra.abap'), 'REPORT extra.'),
    (f: any) => renameSync(join(f.root, 'src/z.prog.abap'), join(f.root, 'src/renamed.abap')),
  ]) {
    const f = protectedSnapshotFixture();
    try { change(f); await assert.rejects(fingerprintVerifiedSources(f.root, f.state), /incomplete or modified/); }
    finally { f.cleanup(); }
  }
});

test('missing, malformed, foreign or empty export state never falls back to an unguarded fingerprint', async () => {
  for (const change of [
    (f: any) => rmSync(f.state),
    (f: any) => writeFileSync(f.state, '{'),
    (f: any) => { const state = JSON.parse(readFileSync(f.state, 'utf8')); state.root += '-another'; writeFileSync(f.state, JSON.stringify(state)); },
    (f: any) => { const state = JSON.parse(readFileSync(f.state, 'utf8')); state.files = { '../outside': sha256('') }; writeFileSync(f.state, JSON.stringify(state)); },
    (f: any) => { rmSync(join(f.root, 'src'), { recursive: true }); mkdirSync(join(f.root, 'src')); const generation = beginExport(f.root, f.root, f.state).generation; completeExport(f.root, f.state, generation); },
  ]) {
    const f = protectedSnapshotFixture();
    try {
      change(f); await assert.rejects(fingerprintVerifiedSources(f.root, f.state));
      const cli = f.run(); assert.equal(cli.status, 1); assert.equal(cli.stdout, '');
    } finally { f.cleanup(); }
  }
  await assert.rejects(fingerprintVerifiedSources('.', ''), /state path is required/);
});

test('verified fingerprint rejects linked source directories instead of following them', async () => {
  const f = protectedSnapshotFixture();
  try {
    renameSync(join(f.root, 'src/nested'), join(f.base, 'outside'));
    symlinkSync(join(f.base, 'outside'), join(f.root, 'src/nested'), 'junction');
    await assert.rejects(fingerprintVerifiedSources(f.root, f.state), /symbolic link/);
  } finally { f.cleanup(); }
});

test('identical source bytes in a later completed export retain their hash but expose a new generation', async () => {
  const f = protectedSnapshotFixture();
  try {
    const before = await fingerprintVerifiedSources(f.root, f.state);
    const next = beginExport(f.root, f.root, f.state).generation; completeExport(f.root, f.state, next);
    const after = await fingerprintVerifiedSources(f.root, f.state);
    assert.equal(after.sha256, before.sha256); assert.notEqual(after.sourceState.generation, before.sourceState.generation);
  } finally { f.cleanup(); }
});

test('a producer transition during inventory reading rejects the CLI observation, including same-content ready generations', () => {
  for (const status of ['updating', 'ready']) {
    const f = protectedSnapshotFixture();
    try {
      // Deterministic interleaving in an isolated process. The production code
      // has no test hooks: instrument the first source read using Node builtins.
      const hook = join(f.base, 'producer-transition.mjs');
      writeFileSync(hook, `import fs from 'node:fs';\nimport { syncBuiltinESMExports } from 'node:module';\n` +
        `const read = fs.readFileSync; let changed = false;\n` +
        `fs.readFileSync = function(path, ...args) {\n` +
        ` const result = read.call(this, path, ...args);\n` +
        ` if (!changed && String(path) === ${JSON.stringify(join(f.root, 'src/nested/a.xml'))}) {\n` +
        `  changed = true; const state = JSON.parse(read(${JSON.stringify(f.state)}, 'utf8'));\n` +
        `  state.generation += '-next'; state.status = ${JSON.stringify(status)};\n` +
        `  fs.writeFileSync(${JSON.stringify(f.state)}, JSON.stringify(state));\n }\n return result;\n};\nsyncBuiltinESMExports();\n`);
      const cli = f.run(['--import', pathToFileURL(hook).href]);
      assert.equal(cli.status, 1, cli.stdout + cli.stderr); assert.equal(cli.stdout, '');
      assert.match(cli.stderr, /generation changed while reading/);
      assert.equal(JSON.parse(readFileSync(f.state, 'utf8')).generation, f.generation + '-next', 'interleaving must actually occur');
    } finally { f.cleanup(); }
  }
});

test('fingerprint CLI rejects misspelled, incomplete and duplicate source-state options', () => {
  const f = protectedSnapshotFixture();
  try {
    for (const suffix of [['--source-state'], ['--source-states', f.state], ['--source-state', f.state, '--source-state', f.state]]) {
      const cli = spawnSync(process.execPath, [...f.args.slice(0, 3), ...suffix], { encoding: 'utf8', windowsHide: true });
      assert.equal(cli.status, 1); assert.equal(cli.stdout, ''); assert.match(cli.stderr, /Usage/);
    }
  } finally { f.cleanup(); }
});

function attachSourceSnapshots(f: ReturnType<typeof fixture>, policy = 'producer_verified') {
  f.plan.sourcePolicy = policy;
  const put = (record: any, position: string, changes: any = {}) => {
    const snapshot = { algorithm: 'sha256-sorted-src-path-and-file-hashes-v1', files: 2, sha256: f.plan.sourceFingerprint,
      sourceState: { status: 'ready', generation: 'private-generation-' + record.sessionId }, ...changes };
    const path = `${record.sessionId}.${position}.snapshot.json`, bytes = Buffer.from(JSON.stringify(snapshot));
    f.artifacts.set(path, bytes); record.sourceSnapshots ??= {}; record.sourceSnapshots[position] = { path, sha256: sha256(bytes) };
  };
  for (const record of f.records) { record.planHash = planHash(f.plan); put(record, 'before'); put(record, 'after'); }
  return put;
}

test('producer-verified plans consume saved fingerprint artifacts with matching generations per run', () => {
  const f = fixture(); attachSourceSnapshots(f);
  const report = f.evaluate(), s = report.strata[0];
  assert.equal(report.verifiedArtifacts, 8); assert.equal(report.sourcePolicy, 'producer_verified');
  assert.equal(report.complete, true); assert.equal(s.paired.totalTokens.pairedCount, 1);
  for (const arm of ['baseline', 'graft']) assert.deepEqual(s.sourceVerification[arm], { verified: 1, changed: 0, unverified: 0, content_only: 0 });
  assert.equal(s.tasks[0].sourceVerification.baseline.verified, 1);
  assert.doesNotMatch(JSON.stringify(report) + markdownReport(report), /private-generation|snapshot\.json/);
  assert.match(markdownReport(report), /Exportgeneration erforderlich/);
});

test('a generation change with identical bytes invalidates a completed run but retains its measured effort', () => {
  const f = fixture(2), put = attachSourceSnapshots(f), bad = f.records[1];
  put(bad, 'after', { sourceState: { status: 'ready', generation: 'new-generation' } });
  const s = f.evaluate().strata[0];
  assert.equal(s.quality.graft.incorrect, 1); assert.equal(s.quality.graft.correct, 1);
  assert.equal(s.sourceVerification.graft.changed, 1); assert.equal(s.paired.totalTokens.pairedCount, 1);
  assert.equal(s.paired.totalTokens.excludedForQualityOrMissingRun, 1);
  assert.equal(s.effortIncludingFailedRuns.graft.totalTokens.observed.total, 140);
  assert.equal(s.effortIncludingFailedRuns.graft.totalTokens.totalPerCorrectRun, 140);
});

test('saved source evidence contradicting a declared unchanged fingerprint is visible as a source change', () => {
  for (const changes of [{ sha256: sha256('changed source') }, { files: 3 }]) {
    const f = fixture(), put = attachSourceSnapshots(f); put(f.records[1], 'after', changes);
    const s = f.evaluate().strata[0];
    assert.equal(s.sourceVerification.graft.changed, 1); assert.equal(s.quality.graft.incorrect, 1);
    assert.equal(s.paired.elapsedMs.reductionPercent, null);
  }
});

test('missing required snapshots and unguarded fingerprints cannot become independently certified successes', () => {
  for (const change of [
    (r: any, _put: any) => delete r.sourceSnapshots,
    (r: any, _put: any) => r.sourceSnapshots.after = null,
    (r: any, put: any) => put(r, 'after', { sourceState: null }),
  ]) {
    const f = fixture(), put = attachSourceSnapshots(f); change(f.records[1], put);
    const report = f.evaluate(), s = report.strata[0];
    assert.equal(report.complete, false); assert.equal(s.sourceVerification.graft.unverified, 1);
    assert.equal(s.quality.graft.unreviewed, 1); assert.equal(s.paired.elapsedMs.pairedCount, 0);
    assert.equal(s.effortIncludingFailedRuns.graft.elapsedMs.observed.total, 100);
    assert.equal(s.effortIncludingFailedRuns.graft.elapsedMs.totalPerCorrectRun, null);
  }
});

test('failed trials with missing source observations remain failed and keep their effort', () => {
  const f = fixture(), put = attachSourceSnapshots(f);
  f.records[1].outcome = 'failed'; f.records[1].review = null; f.records[1].sourceSnapshots.after = null;
  const s = f.evaluate().strata[0];
  assert.equal(s.quality.graft.failed, 1); assert.equal(s.quality.graft.unreviewed, 0);
  assert.equal(s.sourceVerification.graft.unverified, 1); assert.equal(s.effortIncludingFailedRuns.graft.totalTokens.observed.total, 70);
  put(f.records[1], 'after', { sha256: sha256('changed') });
  const changed = f.evaluate().strata[0];
  assert.equal(changed.quality.graft.failed, 1); assert.equal(changed.sourceVerification.graft.changed, 1);
});

test('legacy content-only plans are explicitly labelled and cannot ignore contradictory snapshots', () => {
  const f = fixture(); let report = f.evaluate();
  assert.equal(report.sourcePolicy, 'content_only'); assert.equal(report.strata[0].sourceVerification.graft.content_only, 1);
  assert.match(markdownReport(report), /Exportgeneration nicht verpflichtend geprüft/);
  const put = attachSourceSnapshots(f, 'content_only');
  put(f.records[1], 'after', { sourceState: { status: 'ready', generation: 'changed' } });
  report = f.evaluate(); assert.equal(report.strata[0].quality.graft.incorrect, 1);
});

test('source policy is validated and bound to the frozen plan hash', () => {
  const f = fixture(); f.plan.sourcePolicy = 'producer_verified';
  assert.throws(f.evaluate, /Run plan/);
  for (const policy of [null, '', 'optional', true]) { f.plan.sourcePolicy = policy; assert.throws(() => validatePlan(f.plan), /source policy/); }
});

test('tampered or malformed source proof files fail validation instead of silently downgrading', () => {
  const f = fixture(); attachSourceSnapshots(f);
  f.artifacts.set(f.records[1].sourceSnapshots.after.path, Buffer.from('tampered'));
  assert.throws(f.evaluate, /source after artifact content differs/);
  for (const changes of [{ algorithm: 'other' }, { files: 0 }, { sha256: 'bad' }, { sourceState: { status: 'updating', generation: 'g' } },
    { sourceState: { status: 'ready', generation: '' } }]) {
    const f = fixture(), put = attachSourceSnapshots(f); put(f.records[1], 'after', changes); assert.throws(f.evaluate, /Invalid source snapshot/);
  }
  for (const refs of [[], 'path', { start: null }]) { const f = fixture(); attachSourceSnapshots(f); f.records[1].sourceSnapshots = refs; assert.throws(f.evaluate, /snapshot references/); }
});

test('offline CLI consumes actual guarded fingerprint output as source evidence and excludes a changed generation', async () => {
  const p = protectedSnapshotFixture();
  try {
    const f = fixture(), first = p.run(); assert.equal(first.status, 0, first.stderr);
    const before = JSON.parse(first.stdout);
    f.plan.sourceFingerprint = before.sha256; attachSourceSnapshots(f);
    for (const record of f.records) {
      record.sourceFingerprint = before.sha256; record.sourceFingerprintAfter = before.sha256;
      for (const position of ['before', 'after']) {
        const ref = record.sourceSnapshots[position], bytes = Buffer.from(first.stdout);
        f.artifacts.set(ref.path, bytes); ref.sha256 = sha256(bytes);
      }
    }
    const generation = beginExport(p.root, p.root, p.state).generation; completeExport(p.root, p.state, generation);
    const next = p.run(); assert.equal(next.status, 0, next.stderr);
    const after = f.records[1].sourceSnapshots.after, bytes = Buffer.from(next.stdout);
    f.artifacts.set(after.path, bytes); after.sha256 = sha256(bytes);
    for (const [path, data] of f.artifacts) writeFileSync(join(p.base, path), data);
    writeFileSync(join(p.base, 'plan.json'), JSON.stringify(f.plan)); writeFileSync(join(p.base, 'runs.json'), JSON.stringify(f.records));
    const cli = spawnSync(process.execPath, [p.args[0], 'summarize', '--plan', join(p.base, 'plan.json'), '--runs', join(p.base, 'runs.json'), '--out', join(p.base, 'report')], { encoding: 'utf8', windowsHide: true });
    assert.equal(cli.status, 0, cli.stderr);
    const report = JSON.parse(readFileSync(join(p.base, 'report/result.json'), 'utf8'));
    assert.equal(report.strata[0].sourceVerification.graft.changed, 1); assert.equal(report.strata[0].paired.elapsedMs.pairedCount, 0);
    assert.equal(report.strata[0].effortIncludingFailedRuns.graft.totalTokens.observed.total, 70);
  } finally { p.cleanup(); }
});
