import { join } from 'node:path';
import { readJson } from '../util/state.js';
import type { NodeV1 } from './types.js';
import type { AbapDiagnostic } from './abap.js';
import { loadGraphCached } from './load.js';

/** A graph contains known static relations, never evidence that unindexed
 * dynamic/framework/SAP-standard relations do not exist. */
export function abapCoverageNote(outDir: string, opts: { trace?: boolean } = {}): string {
  const report = loadGraphCached(outDir)?.abap ?? readJson<{ files: number; diagnostics: unknown[] }>(join(outDir, '.graph', 'abap-diagnostics.json'));
  if (!report || !report.files) return '';
  const count = Array.isArray(report.diagnostics) ? report.diagnostics.length : 0;
  const version = process.env.GRAFT_PILOT_VERSION ? ` Version ${process.env.GRAFT_PILOT_VERSION}.` : '';
  const note = `[ABAP pilot]${version} Local export only; static relationships, ${count} analysis notices. External SAP dependencies, dynamic and framework calls may be missing. No callers does not prove unused code.`;
  return opts.trace
    ? `${note}\n[ABAP call paths] No runtime condition or value evaluation. Narrow default-versus-guard notices apply only to recorded sites and premises. Transitive results are structural candidates, not verified execution paths; a listed path can be infeasible for the concrete input. Check the conditions at each hop.`
    : note;
}

/** Warnings in the queried source bodies explain missing outgoing edges. They
 * are observations from the extractor, never synthetic call targets. */
export function abapTraceDiagnostics(outDir: string, symbols: NodeV1[], onlyKinds?: readonly string[]): string {
  const report = loadGraphCached(outDir)?.abap ?? readJson<{ diagnostics: AbapDiagnostic[] }>(join(outDir, '.graph', 'abap-diagnostics.json'));
  if (!Array.isArray(report?.diagnostics)) return '';
  const kinds = ['parse_error', 'metadata_error', 'unsupported_relationship', 'unsupported_statement', 'unresolved_construction', 'dynamic_call', 'remote_call', 'unresolved_receiver', 'external_call'];
  const items = report.diagnostics.filter(item => kinds.includes(item.kind) && (!onlyKinds || onlyKinds.includes(item.kind)) && item.line !== undefined && symbols.some(node => {
    if (node.path !== item.path) return false;
    const span = /^L(\d+)-L(\d+)$/.exec(node.span);
    return span && item.line! >= Number(span[1]) && item.line! <= Number(span[2]);
  })).sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || a.path.localeCompare(b.path) || a.line! - b.line!);
  if (!items.length) return '';
  const selected = items.slice(0, 12);
  return [
    `Unresolved/unsupported relationships inside the queried source (${items.length}; these are not graph edges):`,
    ...selected.map(item => `  ${item.path}:L${item.line}${item.column ? `:${item.column}` : ''} [${item.kind}] ${item.message}`),
    ...(items.length > selected.length ? [`  ${items.length - selected.length} additional notices omitted; use graft_diagnostics with the source path filter to inspect all recorded categories.`] : []),
  ].join('\n');
}
