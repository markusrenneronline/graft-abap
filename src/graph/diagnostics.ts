import type { AbapDiagnosticV1, GraphV1 } from './types.js';
import { contentHash } from '../util/id.js';
import { normalizePathPrefix } from '../util/paths.js';
import { pathUnderPrefix } from './scopes.js';
import { inventoryRevision, inventoryRevisionLines } from './inventory-revision.js';

/** Identity depends on the recorded finding, never page position or evidence display. */
export function diagnosticId(item: AbapDiagnosticV1): string {
  // Preserve all pre-column IDs exactly; new occurrence notices add position.
  return `diagnostic:${contentHash(JSON.stringify([item.path, item.line ?? null, item.kind, item.message,
    ...(item.column === undefined ? [] : [item.column])])).slice(0, 16)}`;
}

/** Read only the co-published graph. Never attach today's source to an old diagnostic. */
export function queryDiagnostics(graph: GraphV1, args: Record<string, unknown>): string {
  const string = (key: string): string | undefined => {
    if (args[key] === undefined) return undefined;
    if (typeof args[key] !== 'string' || !args[key].trim()) throw new Error(`${key} must be a nonempty string`);
    return args[key].trim();
  };
  const query = string('query'), kind = string('kind'), path = string('in');
  const integer = (key: string, fallback: number, min: number, max: number): number => {
    const value = args[key] ?? fallback;
    if (args[key] === null || typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`${key} must be an integer from ${min} to ${max}`);
    return value;
  };
  const limit = integer('limit', 20, 1, 100), offset = integer('offset', 0, 0, Number.MAX_SAFE_INTEGER);
  if (args.evidence !== undefined && typeof args.evidence !== 'boolean') throw new Error('evidence must be a boolean');
  const all = [...(graph.abap?.diagnostics ?? [])].sort((a, b) => a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0)
    || (a.column ?? 0) - (b.column ?? 0) || a.kind.localeCompare(b.kind) || a.message.localeCompare(b.message));
  const revision = inventoryRevision('diagnostics', { available: !!graph.abap, items: all }, args.revision);
  const items = all.filter(item => (!kind || item.kind === kind)
    && (!path || pathUnderPrefix(item.path, normalizePathPrefix(path)))
    && (!query || diagnosticId(item) === query || `${item.kind}\n${item.message}`.toLowerCase().includes(query.toLowerCase())));
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  const page = items.slice(offset, offset + limit);
  return [
    `ABAP diagnostic inventory: ${items.length} matched of ${all.length} recorded; offset ${offset}, shown ${page.length}.`,
    ...inventoryRevisionLines(revision, args.revision, offset),
    ...[...counts].sort(([a], [b]) => a.localeCompare(b)).map(([label, count]) => `  ${label}: ${count}`),
    ...(!graph.abap ? ['This graph contains no ABAP diagnostic inventory.'] : []),
    ...(page.length ? page.flatMap(item => [
      `  ${item.path || '(analysis)'}${item.line ? `:L${item.line}${item.column ? `:${item.column}` : ''}` : ''} [${item.kind}] [${diagnosticId(item)}]`,
      `    ${item.message}`,
      ...(args.evidence === true ? item.source ? [
        `    Recorded source line: ${item.source.path}:${item.source.span}`,
        ...item.source.text.split(/\r?\n/).map(line => `      ${line}`),
      ] : ['    Source evidence unavailable in this graph.'] : []),
    ]) : ['No diagnostics on this page.']),
    ...(offset + page.length < items.length ? [`Next page: offset=${offset + page.length}, limit=${limit}, revision="${revision}"; keep the same filters.`] : []),
    'Recorded analysis notices only, not a complete inventory of unsupported ABAP or proof of source errors. A current graph can still have analysis gaps.',
    'For individual unresolved call occurrences use graft_unresolved_calls; diagnostic counts use a different grouping.',
  ].join('\n');
}
