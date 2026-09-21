#!/usr/bin/env node
// Offline evaluation of recorded experiments. Never calls an LLM or executes a trial.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, realpathSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const planHash = plan => `plan:${sha256(canonical(plan))}`;
const need = (ok, message) => { if (!ok) throw new Error(message); };
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const utcTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const same = (a, b) => canonical(a) === canonical(b);
const arms = ['baseline', 'graft'];
const metrics = ['elapsedMs', 'toolCalls', 'fileReads', 'toolRounds', 'sapReads', 'inputTokens', 'outputTokens', 'totalTokens'];

function fingerprintFiles(files) {
  need(files.length > 0, 'Source snapshot is empty');
  files.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return { algorithm: 'sha256-sorted-src-path-and-file-hashes-v1', files: files.length, sha256: sha256(JSON.stringify(files)) };
}

export function fingerprintSources(repository) {
  const root = join(realpathSync.native(repository), 'src'), files = [];
  need(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), 'src must be a real directory');
  const walk = (directory, prefix = '') => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      need(!item.isSymbolicLink(), 'Source snapshot must not traverse symbolic links');
      const path = prefix + item.name;
      if (item.isDirectory()) walk(join(directory, item.name), path + '/');
      else {
        need(item.isFile(), 'Source snapshot contains a non-file entry');
        files.push([path, sha256(readFileSync(join(directory, item.name)))]);
      }
    }
  };
  walk(root);
  return fingerprintFiles(files);
}

export async function fingerprintVerifiedSources(repository, statePath) {
  need(nonempty(statePath), 'Source state path is required');
  // Use the same producer contract as graph refresh. It checks all file bytes
  // between two reads of the state and rejects a changing generation. Derive
  // the digest from that verified inventory, not a separate unguarded reread.
  const { verifyExport } = await import('../dist/graph/source-state.js');
  const state = verifyExport(repository, statePath);
  const snapshot = fingerprintFiles(Object.entries(state.files).map(([path, hash]) => [path.slice('src/'.length), hash]));
  return { ...snapshot, sourceState: { status: state.status, generation: state.generation } };
}

export function artifactReader(root) {
  root = realpathSync.native(root);
  return path => {
    need(nonempty(path) && !isAbsolute(path) && !/[\\:\x00-\x1f]/.test(path)
      && path.split('/').every(part => part && part !== '.' && part !== '..'), 'Artifact path must be relative and contained');
    const target = realpathSync.native(join(root, path)), rel = relative(root, target);
    need(rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel), 'Artifact escapes evidence directory');
    need(lstatSync(target).isFile(), 'Artifact must be a file');
    return readFileSync(target);
  };
}

export function validatePlan(plan) {
  need(plan?.format === 1 && nonempty(plan.id), 'Invalid experiment plan');
  need(['draft', 'frozen'].includes(plan.status) && (plan.status === 'draft' ? plan.frozenAt === null : utcTime(plan.frozenAt)), 'Plan must be draft or frozen with a UTC freeze time');
  need(digest(plan.sourceFingerprint) && nonempty(plan.modelKey) && nonempty(plan.protocol), 'Plan requires source fingerprint, exact model/settings key and protocol');
  need(plan.sourcePolicy === undefined || ['content_only', 'producer_verified'].includes(plan.sourcePolicy), 'Invalid source policy');
  for (const arm of arms) need(nonempty(plan.conditions?.[arm]), `Missing ${arm} condition`);
  need(Array.isArray(plan.tasks) && plan.tasks.length && Array.isArray(plan.pairs) && plan.pairs.length, 'Plan needs tasks and planned pairs');
  const tasks = new Map();
  for (const task of plan.tasks) {
    need(nonempty(task.id) && !tasks.has(task.id) && nonempty(task.question), 'Invalid or duplicate task');
    need(['development', 'held_out'].includes(task.cohort), 'Task cohort must distinguish development from held_out');
    need(Array.isArray(task.criteria) && task.criteria.length && task.criteria.every(c => nonempty(c.id) && nonempty(c.description))
      && new Set(task.criteria.map(c => c.id)).size === task.criteria.length, 'Task needs unique predeclared review criteria');
    tasks.set(task.id, task);
  }
  const pairs = new Map();
  for (const pair of plan.pairs) {
    need(nonempty(pair.id) && !pairs.has(pair.id) && tasks.has(pair.task), 'Invalid or duplicate planned pair');
    need(Array.isArray(pair.order) && pair.order.length === 2 && arms.every(arm => pair.order.includes(arm)), 'Pair order must contain both arms');
    need(['cold', 'warm'].includes(pair.graphState), 'Pair must declare cold or warm graph state');
    pairs.set(pair.id, pair);
  }
  need([...tasks.keys()].every(id => plan.pairs.some(pair => pair.task === id)), 'Every task needs a planned pair');
  return { tasks, pairs };
}

function distribution(values) {
  if (!values.length) return { count: 0, total: null, median: null, min: null, max: null };
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  const total = values.reduce((a, b) => a + b, 0);
  need(Number.isSafeInteger(total), 'Aggregate metric exceeds safe integer range');
  return { count: values.length, total, median: sorted.length % 2 ? sorted[mid] : sorted[mid - 1] / 2 + sorted[mid] / 2,
    min: sorted[0], max: sorted.at(-1) };
}

/** Artifact hashes bind the supplied metrics/reviews to retained evidence. They
 * do not independently prove that a provider counter or human review is true. */
function recordedSourceStatus(plan, record, readVerified) {
  const strict = plan.sourcePolicy === 'producer_verified';
  const refs = record.sourceSnapshots;
  need(refs === undefined || refs === null || (typeof refs === 'object' && !Array.isArray(refs)
    && Object.keys(refs).every(key => ['before', 'after'].includes(key))), 'Invalid source snapshot references');
  const snapshots = ['before', 'after'].map(position => {
    const ref = refs?.[position];
    if (ref === undefined || ref === null) return null;
    const snapshot = JSON.parse(readVerified(ref, `source ${position}`).toString('utf8'));
    need(snapshot?.algorithm === 'sha256-sorted-src-path-and-file-hashes-v1' && count(snapshot.files)
      && snapshot.files > 0 && digest(snapshot.sha256), 'Invalid source snapshot');
    need(snapshot.sourceState === undefined || snapshot.sourceState === null
      || (snapshot.sourceState.status === 'ready' && nonempty(snapshot.sourceState.generation)), 'Invalid source snapshot producer state');
    return snapshot;
  });
  const [before, after] = snapshots;
  if (snapshots.some(snapshot => snapshot && snapshot.sha256 !== plan.sourceFingerprint)
    || (before && after && before.files !== after.files)
    || (before?.sourceState && after?.sourceState && before.sourceState.generation !== after.sourceState.generation)) return 'changed';
  if (before?.sourceState && after?.sourceState) return 'verified';
  return strict ? 'unverified' : 'content_only';
}

export function evaluateExperiment(plan, records, readArtifact) {
  const { tasks, pairs } = validatePlan(plan), expectedHash = planHash(plan);
  need(Array.isArray(records) && typeof readArtifact === 'function', 'Records and artifact reader required');
  need(!records.length || plan.status === 'frozen', 'Freeze the plan before recording runs');
  const indexed = new Map(), sessions = new Set();
  let verifiedArtifacts = 0;
  const readVerified = (artifact, kind) => {
    need(artifact && nonempty(artifact.path) && digest(artifact.sha256), `Missing ${kind} artifact`);
    const bytes = readArtifact(artifact.path);
    need(bytes.length > 0 && sha256(bytes) === artifact.sha256, `${kind} artifact content differs`);
    verifiedArtifacts++;
    return bytes;
  };
  for (const record of records) {
    const pair = pairs.get(record.pair), task = pair && tasks.get(pair.task);
    need(pair && arms.includes(record.arm), 'Record does not belong to a planned pair/arm');
    const key = `${record.pair}\0${record.arm}`;
    need(!indexed.has(key), 'Duplicate run for planned pair/arm');
    need(record.planHash === expectedHash && record.sourceFingerprint === plan.sourceFingerprint
      && record.sourceFingerprintAfter === plan.sourceFingerprint && record.modelKey === plan.modelKey,
      'Run plan, source fingerprint or model/settings differs');
    need(nonempty(record.sessionId) && !sessions.has(record.sessionId) && record.freshSession === true, 'Every run requires a distinct fresh session');
    sessions.add(record.sessionId);
    need(['completed', 'failed'].includes(record.outcome), 'Run outcome must be completed or failed');
    const start = Date.parse(record.startedAt), end = Date.parse(record.finishedAt);
    need(utcTime(record.startedAt) && utcTime(record.finishedAt) && end >= start && count(end - start)
      && start >= Date.parse(plan.frozenAt), 'Invalid run timestamps; use canonical UTC ISO strings after plan freeze');
    for (const metric of ['toolCalls', 'fileReads', 'toolRounds', 'sapReads']) need(record[metric] === null || count(record[metric]), `Invalid or missing ${metric}`);
    let trace;
    for (const kind of ['answer', 'trace']) {
      const bytes = readVerified(record.artifacts?.[kind], kind);
      if (kind === 'trace') trace = bytes.toString('utf8');
    }
    let inputTokens = null, outputTokens = null;
    if (record.usage !== null) {
      const usage = record.usage;
      need(usage?.source === 'provider_reported' && usage.accounting === 'input_including_cache_output_including_reasoning', 'Usage must be actual provider totals with the declared accounting');
      need(count(usage.inputTokens) && count(usage.outputTokens) && count(usage.inputTokens + usage.outputTokens), 'Invalid token totals');
      need(nonempty(usage.counterReference) && trace.includes(usage.counterReference), 'Usage requires a counter reference in the retained trace');
      inputTokens = usage.inputTokens; outputTokens = usage.outputTokens;
    }
    const review = record.review;
    let quality = record.outcome === 'failed' ? 'failed' : 'unreviewed';
    if (review !== null) {
      need(nonempty(review?.reviewer) && [true, false, null].includes(review.protocolCompliant), 'Invalid independent review');
      need(review.unsupportedClaims === null || count(review.unsupportedClaims), 'Invalid unsupported-claim count');
      need(review.criteria && same(Object.keys(review.criteria).sort(), task.criteria.map(c => c.id).sort())
        && Object.values(review.criteria).every(value => [true, false, null].includes(value)), 'Review must cover exactly the frozen criteria');
      if (record.outcome === 'completed' && review.protocolCompliant !== null && review.unsupportedClaims !== null
        && Object.values(review.criteria).every(value => value !== null)) {
        quality = review.protocolCompliant && review.unsupportedClaims === 0 && Object.values(review.criteria).every(Boolean) ? 'correct' : 'incorrect';
      }
    }
    const sourceStatus = recordedSourceStatus(plan, record, readVerified);
    // Keep failed work and its cost. A known source change invalidates a
    // completed trial; missing required evidence cannot certify success.
    if (record.outcome === 'completed' && sourceStatus === 'changed') quality = 'incorrect';
    if (quality === 'correct' && sourceStatus === 'unverified') quality = 'unreviewed';
    indexed.set(key, { arm: record.arm, quality, sourceStatus, start, end, metrics: { elapsedMs: end - start,
      ...Object.fromEntries(['toolCalls', 'fileReads', 'toolRounds', 'sapReads'].map(key => [key, record[key]])),
      inputTokens, outputTokens, totalTokens: inputTokens === null ? null : inputTokens + outputTokens } });
  }
  for (const pair of pairs.values()) {
    const first = indexed.get(`${pair.id}\0${pair.order[0]}`), second = indexed.get(`${pair.id}\0${pair.order[1]}`);
    need(!first || !second || first.end <= second.start, 'Observed run order overlaps or contradicts the frozen pair order');
  }
  const summarizePairs = selected => {
    const allRuns = arm => selected.map(pair => indexed.get(`${pair.id}\0${arm}`)).filter(Boolean);
    const quality = Object.fromEntries(arms.map(arm => {
      const runs = allRuns(arm);
      return [arm, { planned: selected.length, recorded: runs.length, missing: selected.length - runs.length,
        ...Object.fromEntries(['correct', 'incorrect', 'unreviewed', 'failed'].map(status => [status, runs.filter(run => run.quality === status).length])) }];
    }));
    const qualityPairs = selected.filter(pair => arms.every(arm => indexed.get(`${pair.id}\0${arm}`)?.quality === 'correct'));
    const paired = Object.fromEntries(metrics.map(metric => {
      const eligible = qualityPairs.filter(pair => arms.every(arm => indexed.get(`${pair.id}\0${arm}`).metrics[metric] !== null));
      const values = arm => eligible.map(pair => indexed.get(`${pair.id}\0${arm}`).metrics[metric]);
      const baseline = distribution(values('baseline')), graft = distribution(values('graft'));
      return [metric, { pairedCount: eligible.length, excludedForQualityOrMissingRun: selected.length - qualityPairs.length,
        excludedForMissingMetric: qualityPairs.length - eligible.length, baseline, graft,
        pairedDifferences: distribution(eligible.map(pair => indexed.get(`${pair.id}\0baseline`).metrics[metric] - indexed.get(`${pair.id}\0graft`).metrics[metric])),
        difference: eligible.length ? baseline.total - graft.total : null,
        reductionPercent: baseline.total > 0 ? 100 * (baseline.total - graft.total) / baseline.total : null }];
    }));
    const effort = Object.fromEntries(arms.map(arm => {
      const runs = allRuns(arm), correct = quality[arm].correct;
      return [arm, Object.fromEntries(metrics.map(metric => {
        const known = runs.filter(run => run.metrics[metric] !== null), summary = distribution(known.map(run => run.metrics[metric]));
        const complete = runs.length === selected.length && known.length === runs.length && quality[arm].unreviewed === 0;
        return [metric, { recorded: runs.length, known: known.length, observed: summary,
          complete, totalPerCorrectRun: complete && correct > 0 ? summary.total / correct : null }];
      }))];
    }));
    const sourceVerification = Object.fromEntries(arms.map(arm => [arm,
      Object.fromEntries(['verified', 'changed', 'unverified', 'content_only'].map(status =>
        [status, allRuns(arm).filter(run => run.sourceStatus === status).length]))]));
    return { plannedPairs: selected.length, sourceVerification,
      order: { baselineFirst: selected.filter(pair => pair.order[0] === 'baseline').length, graftFirst: selected.filter(pair => pair.order[0] === 'graft').length },
      quality, paired, effortIncludingFailedRuns: effort };
  };
  const strata = [];
  for (const cohort of ['development', 'held_out']) for (const graphState of ['cold', 'warm']) {
    const selected = plan.pairs.filter(pair => tasks.get(pair.task).cohort === cohort && pair.graphState === graphState);
    if (!selected.length) continue;
    strata.push({ cohort, graphState, ...summarizePairs(selected), tasks: [...new Set(selected.map(pair => pair.task))]
      .map(task => ({ task, ...summarizePairs(selected.filter(pair => pair.task === task)) })) });
  }
  return { format: 1, experiment: plan.id, planStatus: plan.status, planHash: expectedHash, recordsHash: sha256(canonical(records)), sourceFingerprint: plan.sourceFingerprint,
    modelKey: plan.modelKey, plannedPairs: pairs.size, recordedRuns: indexed.size,
    complete: indexed.size === pairs.size * 2 && [...indexed.values()].every(run => run.quality !== 'unreviewed'),
    sourcePolicy: plan.sourcePolicy ?? 'content_only', verifiedArtifacts, strata,
    scope: 'Recorded full-task trials, not an automated LLM experiment. Reviews and provider counter provenance require independent inspection. Paired resource differences use only both-correct pairs; all-run effort includes failures. No causal, cost or general productivity claim.' };
}

export function markdownReport(report) {
  const cell = value => String(value ?? 'unbekannt').replace(/[|\r\n]/g, ' ');
  const lines = ['# Graft-ABAP: gepaarte Nutzenmessung', '',
    `Experiment: ${cell(report.experiment)}. Planstatus: ${report.planStatus}. ${report.recordedRuns}/${report.plannedPairs * 2} Läufe erfasst. Auswertung vollständig bewertet: ${report.complete ? 'ja' : 'nein'}.`,
    `Plan: ${report.planHash}. Datensatz: ${report.recordsHash}.`, '',
    `Quellenprüfung laut Plan: ${report.sourcePolicy === 'producer_verified' ? 'gespeicherte Fingerprints mit bestätigter, unveränderter Exportgeneration erforderlich' : 'nur Inhaltsvergleich; Exportgeneration nicht verpflichtend geprüft'}.`, '',
    'Nur aufgezeichnete vollständige Aufgaben vergleichen. Keine Schätzung von Tokens aus Zeichen. Fehlende Angaben bleiben unbekannt. Der Hashvergleich bestätigt gespeicherte Artefakte, nicht die Wahrheit einer Bewertung oder eines Nutzungszählers.', ''];
  for (const stratum of report.strata) {
    lines.push(`## ${stratum.cohort} / ${stratum.graphState}`, '',
      `Geplant: ${stratum.plannedPairs} Paare; zuerst ohne Graft: ${stratum.order.baselineFirst}, zuerst mit Graft: ${stratum.order.graftFirst}.`, '',
      '| Arm | geplant | erfasst | korrekt | inkorrekt | unbewertet | abgebrochen | fehlend |', '|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const arm of arms) { const q = stratum.quality[arm]; lines.push(`| ${arm} | ${q.planned} | ${q.recorded} | ${q.correct} | ${q.incorrect} | ${q.unreviewed} | ${q.failed} | ${q.missing} |`); }
    lines.push('', 'Korrekt bedeutet hier auch gemäß Quellenregel zulässig. Bekannter Quellenwechsel macht einen abgeschlossenen Lauf inkorrekt; ein fehlender Pflichtbeleg lässt ihn unbewertet. Fehlversuche bleiben erfasst. Die Artefaktprüfung ersetzt keine unabhängige Prüfung ihrer Herkunft oder der Aufnahmezeitpunkte.', '',
      '| Arm | Exportgeneration bestätigt | Quellenwechsel | Pflichtbeleg fehlt | nur Inhaltsvergleich |', '|---|---:|---:|---:|---:|');
    for (const arm of arms) { const s = stratum.sourceVerification[arm]; lines.push(`| ${arm} | ${s.verified} | ${s.changed} | ${s.unverified} | ${s.content_only} |`); }
    lines.push('', 'Ressourcenvergleich nur für Paare mit zwei korrekten Antworten. Positive Reduktion bedeutet weniger Aufwand mit Graft; negative Werte bleiben sichtbar. Unterschiedliche Metriken können unterschiedliche Paarzahlen haben.', '',
      '| Größe | Paare | ohne Graft gesamt | mit Graft gesamt | Reduktion % | ausgeschlossen: Qualität/fehlender Lauf | ausgeschlossen: Messwert fehlt |', '|---|---:|---:|---:|---:|---:|---:|');
    for (const metric of metrics) { const m = stratum.paired[metric]; lines.push(`| ${metric} | ${m.pairedCount} | ${cell(m.baseline.total)} | ${cell(m.graft.total)} | ${m.reductionPercent === null ? 'unbekannt' : m.reductionPercent.toFixed(2)} | ${m.excludedForQualityOrMissingRun} | ${m.excludedForMissingMetric} |`); }
    lines.push('', 'Gesamtaufwand einschließlich Fehlversuchen, je bestandenem Lauf. Nur bei vollständigen Messwerten und abgeschlossener Bewertung definiert; kein gepaarter Qualitätsvergleich.', '',
      '| Größe | ohne Graft je korrekt | mit Graft je korrekt |', '|---|---:|---:|');
    for (const metric of metrics) lines.push(`| ${metric} | ${cell(stratum.effortIncludingFailedRuns.baseline[metric].totalPerCorrectRun)} | ${cell(stratum.effortIncludingFailedRuns.graft[metric].totalPerCorrectRun)} |`);
    lines.push('', 'Median, Minimum, Maximum und bekannte Messwertanzahl stehen zusätzlich je Aufgabe im JSON. Entwicklungsaufgaben und zurückgehaltene Aufgaben sowie kalte und warme Graphen werden getrennt ausgewiesen.', '');
  }
  return lines.join('\n') + '\n';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === 'fingerprint' && args.length === 2) console.log(JSON.stringify({ ...fingerprintSources(args[1]), sourceState: null }, null, 2));
    else if (args[0] === 'fingerprint' && args.length === 4 && args[2] === '--source-state')
      console.log(JSON.stringify(await fingerprintVerifiedSources(args[1], args[3]), null, 2));
    else if (args[0] === 'plan-hash' && args.length === 2) { const plan = JSON.parse(readFileSync(args[1], 'utf8')); validatePlan(plan); console.log(planHash(plan)); }
    else {
      need(args.length === 7 && args[0] === 'summarize' && args[1] === '--plan' && args[3] === '--runs' && args[5] === '--out',
        'Usage: fingerprint <export> [--source-state <state.json>] | plan-hash <plan.json> | summarize --plan <plan.json> --runs <runs.json> --out <new-report-directory>');
      const plan = JSON.parse(readFileSync(args[2], 'utf8')), records = JSON.parse(readFileSync(args[4], 'utf8'));
      const result = evaluateExperiment(plan, records, artifactReader(dirname(resolve(args[4]))));
      const output = resolve(args[6]);
      need(!existsSync(join(output, 'result.json')) && !existsSync(join(output, 'report.md')), 'Report already exists; use a new output directory');
      mkdirSync(output, { recursive: true });
      writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
      writeFileSync(join(output, 'report.md'), markdownReport(result), { flag: 'wx' });
      console.log(JSON.stringify({ complete: result.complete, recordedRuns: result.recordedRuns, plannedPairs: result.plannedPairs, output }, null, 2));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
