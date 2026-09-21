#!/usr/bin/env node
/** Local-only pilot: sources are read from the configured repository;
 * every generated file stays in this pilot directory. No LLM/API is invoked. */
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { dirname, resolve, join, relative, isAbsolute, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const pilotDir = dirname(fileURLToPath(import.meta.url));
const cliArgs = process.argv.slice(2);
let configPath = join(pilotDir, 'config.json');
if (cliArgs[0] === '--config') {
  if (!cliArgs[1] || cliArgs[1].startsWith('--')) throw new Error('--config requires a configuration file path');
  configPath = resolve(cliArgs[1]);
  cliArgs.splice(0, 2);
}
const configDir = dirname(configPath);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
if (typeof config.repository !== 'string' || !isAbsolute(config.repository)) throw new Error('repository must be an absolute path');
if (typeof config.graphDirectory !== 'string' || !config.graphDirectory.trim()) throw new Error('graphDirectory must be a nonempty path');
if (config.sourceState !== undefined && (typeof config.sourceState !== 'string' || !config.sourceState.trim())) throw new Error('sourceState must be a nonempty path when specified');
if (config.abapVersion !== '7.50') throw new Error('This pilot currently supports ABAP 7.50 only.');
// Resolve existing ancestors too: a configured junction must not redirect
// generated artifacts into the source repository.
function physicalPath(path) {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  if (parent === path) throw new Error(`Path root does not exist: ${path}`);
  return join(physicalPath(parent), basename(path));
}
const repo = realpathSync(resolve(config.repository));
const graphDir = physicalPath(resolve(configDir, config.graphDirectory));
const relativeGraph = relative(repo, graphDir);
const isParent = relativeGraph === '..' || relativeGraph.startsWith('..' + sep);
if (relativeGraph === '' || (!isParent && !isAbsolute(relativeGraph))) throw new Error('Pilot graph must be outside the source repository');
for (const key of ['DO_NOT_TRACK', 'GRAFT_NO_GITIGNORE', 'GRAFT_NO_IGNORE', 'GRAFT_NO_UPKEEP', 'GRAFT_NO_SAVINGS', 'GRAFT_STRUCTURAL_ONLY']) process.env[key] = '1';
process.env.GRAFT_REFRESH = 'hash';
if (config.sourceState) {
  const statePath = physicalPath(resolve(configDir, config.sourceState));
  process.env.GRAFT_SOURCE_STATE = statePath;
  // Persist the contract for CLI/check clients that do not use this starter.
  const { writeJsonAtomic } = await import('../dist/util/state.js');
  const policyPath = join(graphDir, '.graph', 'source-policy.json');
  const policy = { sourceState: statePath, onlyDirs: ['src'] };
  if (!existsSync(policyPath) || readFileSync(policyPath, 'utf8').trim() !== JSON.stringify(policy, null, 2)) {
    writeJsonAtomic(policyPath, policy);
  }
}
const pilotVersion = '0.18.0-abap-pilot.31';
process.env.GRAFT_PILOT_VERSION = pilotVersion;
const [command = 'help', ...args] = cliArgs;
const help = `Graft ABAP Pilot — local sources, static analysis, no LLM

Commands:
  node pilot/run.mjs --config /absolute/config.json <command>
  node pilot/run.mjs build
  node pilot/run.mjs check
  node pilot/run.mjs find "Suchbegriff"
  node pilot/run.mjs callers "ZCL_MY_CLASS=>MY_METHOD" --depth 2
  node pilot/run.mjs callees "ZCL_MY_CLASS=>MY_METHOD"
  node pilot/run.mjs api "zcl_my_class.clas.abap"
  node pilot/run.mjs grep "MY_PATTERN"
  node pilot/run.mjs map
  node pilot/run.mjs diagnostics [kind]
  node pilot/run.mjs notices [query] [--kind <kind>] [--in <path>] [--limit <n>] [--offset <n>] [--revision <token>] [--evidence]
  node pilot/run.mjs unresolved [target] [--source <caller>] [--kind <kind>] [--reason <reason>] [--in <path>] [--limit <n>] [--offset <n>] [--revision <token>] [--evidence]
  node pilot/run.mjs verify
  node pilot/run.mjs evaluate
  node pilot/run.mjs viz
  node pilot/run.mjs mcp

callers/callees options:
  --depth <number|all>  --in <path>  --no-evidence
  --max-sites <1..20>  --max-targets <1..50>
  --evidence-target <symbol>  (repeat to select detailed chains)
  --exit-source <symbol>      (repeat to select earlier-exit sources)
  --no-exits                 (hide all earlier exits; keep other evidence)
Evidence shows source and enclosing controls; it does not evaluate execution.

Configuration: ${configPath}
Repository: ${repo}
Graph: ${graphDir}`;

function traceArguments(values, direction) {
  const result = { direction };
  const symbols = [];
  let noExits = false;
  for (let i = 0; i < values.length; i++) {
    const item = values[i];
    if (item === '--no-evidence') { result.evidence = false; continue; }
    if (item === '--no-exits') {
      if (result.exit_sources?.length) throw new Error('--no-exits cannot be combined with --exit-source');
      noExits = true;
      result.exit_sources = [];
      continue;
    }
    if (item === '--evidence-target' || item === '--exit-source') {
      const value = values[++i];
      if (!value?.trim() || value.startsWith('--')) throw new Error(`Missing value for ${item}`);
      if (item === '--exit-source' && noExits) throw new Error('--exit-source cannot be combined with --no-exits');
      const key = item === '--evidence-target' ? 'evidence_targets' : 'exit_sources';
      (result[key] ??= []).push(value.trim());
      continue;
    }
    if (['--depth', '--in', '--max-sites', '--max-targets'].includes(item)) {
      const value = values[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${item}`);
      if (item === '--in') result.in = value;
      else if (item === '--depth' && value === 'all') result.depth = 'all';
      else {
        const number = Number(value);
        const maximum = item === '--max-sites' ? 20 : item === '--max-targets' ? 50 : Number.MAX_SAFE_INTEGER;
        if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new Error(`Invalid value for ${item}: ${value}`);
        result[item === '--depth' ? 'depth' : item === '--max-sites' ? 'max_sites' : 'max_targets'] = number;
      }
    } else if (item.startsWith('--')) throw new Error(`Unknown trace option: ${item}`);
    else symbols.push(item);
  }
  result.symbol = symbols.join(' ');
  if (!result.symbol) throw new Error('A symbol is required');
  return result;
}

function unresolvedArguments(values, notices = false) {
  const result = {}, query = [];
  for (let i = 0; i < values.length; i++) {
    const item = values[i];
    if (item === '--evidence') { result.evidence = true; continue; }
    const keys = notices
      ? { '--kind': 'kind', '--in': 'in', '--limit': 'limit', '--offset': 'offset', '--revision': 'revision' }
      : { '--source': 'source', '--kind': 'target_kind', '--reason': 'reason', '--in': 'in', '--limit': 'limit', '--offset': 'offset', '--revision': 'revision' };
    if (keys[item]) {
      const value = values[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${item}`);
      result[keys[item]] = ['--limit', '--offset'].includes(item) ? Number(value) : value;
    } else if (item.startsWith('--')) throw new Error(`Unknown ${notices ? 'notices' : 'unresolved'} option: ${item}`);
    else query.push(item);
  }
  if (query.length) result.query = query.join(' ');
  return result;
}

async function main() {
  if (command === 'help' || command === '--help') { console.log(help); return; }
  // The existing graph remains usable with an explicit stale warning during an
  // interrupted export. Build/check/refresh enforce the source contract; do not
  // prevent an MCP process from starting just because src is temporarily absent.
  if (command === 'build') {
    const { buildGraph } = await import('../dist/graph/build.js');
    const started = performance.now();
    const result = await buildGraph(repo, { contextDir: graphDir, onlyDirs: ['src'] });
    const report = { observedAt: new Date().toISOString(), repository: repo, upstream: config.upstream,
      mode: 'static; no LLM; local export only', elapsedMs: Math.round(performance.now() - started), ...result };
    mkdirSync(pilotDir, { recursive: true });
    writeFileSync(join(pilotDir, 'build-result.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    if (result.errors.length) process.exitCode = 1;
    return;
  }
  if (!existsSync(join(graphDir, '.graph', 'wiring.json'))) throw new Error('Build the pilot first: node pilot/run.mjs build');
  if (command === 'mcp') {
    const { startMcpServer } = await import('../dist/mcp/server.js');
    await startMcpServer(repo, graphDir, pilotVersion);
    return;
  }
  if (command === 'diagnostics') {
    const { ensureFreshGraph } = await import('../dist/graph/refresh.js');
    const refresh = await ensureFreshGraph(repo, { contextDir: graphDir });
    const graph = JSON.parse(readFileSync(join(graphDir, '.graph', 'wiring.json'), 'utf8'));
    const report = graph.abap ?? JSON.parse(readFileSync(join(graphDir, '.graph', 'abap-diagnostics.json'), 'utf8'));
    const items = Array.isArray(report) ? report : report.diagnostics ?? [];
    const selected = args[0] ? items.filter(item => item.kind === args[0]) : items;
    const counts = {};
    for (const item of items) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
    console.log(JSON.stringify({ freshnessNote: refresh.note, counts, selected: selected.length, first50: selected.slice(0, 50) }, null, 2));
    return;
  }
  if (command === 'verify') {
    if (!existsSync(join(pilotDir, 'verify.mjs')) || !existsSync(join(pilotDir, 'expected-cases.json'))) throw new Error('Project verification data is not installed. Use scripts/smoke-abap-install.mjs for the generic installation check.');
    const { verifyPilot } = await import('./verify.mjs');
    const result = await verifyPilot(repo, graphDir, pilotDir);
    console.log(JSON.stringify(result, null, 2));
    if (result.failed) process.exitCode = 1;
    return;
  }
  if (command === 'viz') {
    const { ensureFreshGraph } = await import('../dist/graph/refresh.js');
    const refresh = await ensureFreshGraph(repo, { contextDir: graphDir });
    const { exportViz } = await import('../dist/viz/export.js');
    const result = exportViz({ contextDir: graphDir, viewerDir: join(pilotDir, '../dist/viewer'),
      outDir: configPath === join(pilotDir, 'config.json') ? join(pilotDir, 'visual') : join(graphDir, 'visual'), repoName: basename(repo),
      subtitle: refresh.note ?? 'ABAP 7.50 · lokaler Export · statische Teilabdeckung', tabs: ['code', 'outline'] });
    if (refresh.note) console.error(refresh.note);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === 'evaluate') {
    if (!existsSync(join(pilotDir, 'evidence-cases.json'))) throw new Error('Project evidence cases are not installed. Use scripts/smoke-abap-install.mjs for the generic installation check.');
    const { evaluateEvidence } = await import('./evaluate-project.mjs');
    const result = await evaluateEvidence(repo, graphDir, pilotDir);
    console.log(JSON.stringify(result, null, 2));
    if (result.failed) process.exitCode = 1;
    return;
  }
  const mapping = {
    check: ['graft_check_freshness', {}],
    find: ['graft_find_code', { query: args.join(' '), limit: 5 }],
    callers: ['graft_trace_calls', command === 'callers' ? traceArguments(args, 'in') : {}],
    callees: ['graft_trace_calls', command === 'callees' ? traceArguments(args, 'out') : {}],
    api: ['graft_file_api', { file: args.join(' ') }],
    grep: ['graft_find_all', { pattern: args.join(' '), ignore_case: true }],
    map: ['graft_repo_map', {}],
    unresolved: ['graft_unresolved_calls', command === 'unresolved' ? unresolvedArguments(args) : {}],
    notices: ['graft_diagnostics', command === 'notices' ? unresolvedArguments(args, true) : {}],
  };
  if (!mapping[command]) throw new Error(`Unknown command: ${command}\n${help}`);
  const { callTool } = await import('../dist/mcp/tools.js');
  const [name, input] = mapping[command];
  const result = await callTool(repo, name, input, graphDir);
  console.log(result.text);
  if (result.isError) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
