#!/usr/bin/env node
// Read-only local installation check. No refresh, repair, network or SAP call.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const pilot = dirname(fileURLToPath(import.meta.url));
const base = resolve(pilot, '..');
export function supportsNodeVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const major = Number(match[1]), minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 12);
}
function physical(path) {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return parent === path ? path : join(physical(parent), path.slice(parent.length).replace(/^[/\\]+/, ''));
}
export async function diagnoseInstallation(configPath = join(pilot, 'config.json')) {
  const checks = [];
  const check = (id, ok, detail, severity = 'error') => checks.push({ id, ok, detail, severity });
  const version = readFileSync(join(pilot, 'run.mjs'), 'utf8').match(/const pilotVersion = '([^']+)'/)?.[1] ?? 'unknown';
  check('node', supportsNodeVersion(process.versions.node), `Node ${process.version}; required >=22.12.0`);
  const compiled = ['graph/check.js', 'graph/source-state.js', 'ask/index-file.js', 'mcp/server.js'].every(p => existsSync(join(base, 'dist', p)));
  check('build', compiled, compiled ? 'Compiled runtime present' : 'Run npm ci --ignore-scripts, then npm run build');
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
    if (!config || typeof config.repository !== 'string' || !isAbsolute(config.repository)
      || typeof config.graphDirectory !== 'string' || !config.graphDirectory || config.abapVersion !== '7.50'
      || config.sourceState !== undefined && (typeof config.sourceState !== 'string' || !config.sourceState)) throw new Error('Expected absolute repository, graphDirectory and abapVersion 7.50; sourceState is optional');
    check('config', true, resolve(configPath));
  } catch (error) { check('config', false, String(error)); }
  if (config && checks.find(c => c.id === 'config').ok) {
    const root = physical(resolve(config.repository));
    const out = physical(resolve(dirname(configPath), config.graphDirectory));
    const rel = relative(root, out);
    const outside = !!rel && (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep));
    check('source', existsSync(join(root, 'src')), `${root}/src`);
    check('graph_location', outside, outside ? out : 'Graph must be outside the source repository');
    let state = config.sourceState ? resolve(dirname(configPath), config.sourceState) : undefined;
    try {
      const policy = join(out, '.graph/source-policy.json');
      const stored = existsSync(policy) ? JSON.parse(readFileSync(policy, 'utf8')) : {};
      if (state && stored.sourceState) {
        const a = physical(state), b = physical(resolve(stored.sourceState));
        check('source_policy', process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b,
          'Configured and persisted source-state paths must agree');
      }
      state ??= stored.sourceState;
      if (state && compiled) {
        const { verifyExport } = await import('../dist/graph/source-state.js');
        const status = verifyExport(root, state);
        check('export', true, `${status.status}; generation ${status.generation}; ${Object.keys(status.files).length} files`);
      } else check('export', false, state ? 'Export state cannot be checked before build' : 'No producer contract; completed exports cannot be verified', state ? 'error' : 'warning');
    } catch (error) { check('export', false, String(error)); }
    if (compiled && outside) {
      try {
        const { checkGraph, formatGraphCheckReport } = await import('../dist/graph/check.js');
        const result = await checkGraph(root, { contextDir: out });
        check('graph', result.ok, formatGraphCheckReport(result, { showPending: false }));
      } catch (error) { check('graph', false, String(error)); }
    }
    if (compiled) {
      try {
        const { TOOLS } = await import('../dist/mcp/tools.js');
        const trace = TOOLS.find(t => t.name === 'graft_trace_calls');
        check('mcp_runtime', !!trace && TOOLS.some(t => t.name === 'graft_unresolved_calls') && TOOLS.some(t => t.name === 'graft_diagnostics'),
          `${TOOLS.length} server tools; ${Object.keys(trace?.inputSchema.properties ?? {}).length} trace parameters. Client cache not inspected.`);
      } catch (error) { check('mcp_runtime', false, String(error)); }
    }
  }
  return { version, mode: 'read-only; no refresh, no SAP connection',
    ok: checks.every(c => c.ok || c.severity === 'warning'), warnings: checks.filter(c => !c.ok && c.severity === 'warning').length, checks };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--config')) {
    console.error('Usage: node pilot/doctor.mjs [--config /absolute/pilot/config.json]'); process.exitCode = 1;
  } else {
    const result = await diagnoseInstallation(args.length ? resolve(args[1]) : undefined);
    console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1;
  }
}
