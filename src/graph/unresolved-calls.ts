import type { GraphV1, UnresolvedCallV1 } from './types.js';
import { normalizePathPrefix } from '../util/paths.js';
import { pathUnderPrefix } from './scopes.js';
import { receiverEvidence } from './receiver-evidence.js';
import { inventoryRevision, inventoryRevisionLines } from './inventory-revision.js';

const normalized = (name: string): string => name.toUpperCase().replace(/=>|->|~/g, '.');

export function unresolvedCallMatches(graph: GraphV1, query: string, path?: string): UnresolvedCallV1[] {
  const wanted = normalized(query);
  return (graph.unresolvedCalls ?? []).filter(ref => {
    if (path && !pathUnderPrefix(ref.site.path, normalizePathPrefix(path))) return false;
    const target = normalized(ref.targetName);
    return ref.id === query || target === wanted || (!wanted.includes('.') && target.split('.').at(-1) === wanted);
  });
}

export function formatUnresolvedCalls(graph: GraphV1, refs: UnresolvedCallV1[], evidence = true, limit = 20): string {
  if (!refs.length) return '';
  const names = new Map(graph.nodes.map(node => [node.id, node.owner ? `${node.owner}=>${node.name}` : node.name]));
  const lines = [`Unresolved call references (${refs.length}; recorded in source, not resolved graph edges):`,
    'A missing export target does not prove that the target is absent in SAP. No transitive path is inferred.'];
  for (const ref of refs.slice(0, limit)) {
    lines.push(`  ${names.get(ref.source) ?? ref.source} → ${ref.targetName} [${ref.targetKind}; ${ref.reason}]${ref.site.execution ? ` [execution: ${ref.site.execution}]` : ''} ${ref.site.path}:${ref.site.span} [${ref.id}]`);
    if (evidence) lines.push(...ref.site.text.split(/\r?\n/).map(line => `    ${line}`));
    if (evidence && ref.site.receiverType) {
      const receiver = ref.site.receiverType;
      const labels = receiverEvidence(receiver);
      lines.push(`    ${labels.description}`,
        `    ${labels.sourceLabel}: ${receiver.source.path}:${receiver.source.span}`,
        ...receiver.source.text.split(/\r?\n/).map(line => `    ${line}`));
      for (const declaration of receiver.via ?? []) lines.push(`    ${labels.hierarchyLabel}: ${declaration.path}:${declaration.span}`,
        ...declaration.text.split(/\r?\n/).map(line => `    ${line}`));
      if (receiver.inlineDeclaration) lines.push(`    Inline reference declaration: ${receiver.inlineDeclaration.path}:${receiver.inlineDeclaration.span}`,
        ...receiver.inlineDeclaration.text.split(/\r?\n/).map(line => `    ${line}`));
    }
  }
  if (refs.length > limit) lines.push(`  ${refs.length - limit} more references omitted; use graft_unresolved_calls with source/query and offset to inspect all occurrences.`);
  return lines.join('\n');
}

export const UNRESOLVED_KINDS = ['method', 'function', 'form', 'program', 'transaction'] as const;
export const UNRESOLVED_REASONS = ['missing_or_ambiguous', 'missing_target', 'ambiguous_target', 'resolution_incomplete', 'unresolved_receiver', 'remote', 'dynamic_target', 'missing_transaction_metadata'] as const;

/** An explicit, paged inventory of source occurrences, never invented edges. */
export function queryUnresolvedCalls(graph: GraphV1, args: Record<string, unknown>): string {
  const string = (key: string): string | undefined => {
    if (args[key] === undefined) return undefined;
    if (typeof args[key] !== 'string' || !args[key].trim()) throw new Error(`${key} must be a nonempty string`);
    return args[key].trim();
  };
  const query = string('query'), source = string('source'), path = string('in');
  const kind = string('target_kind'), reason = string('reason');
  if (kind && !UNRESOLVED_KINDS.includes(kind as typeof UNRESOLVED_KINDS[number])) throw new Error(`target_kind must be one of ${UNRESOLVED_KINDS.join(', ')}`);
  if (reason && !UNRESOLVED_REASONS.includes(reason as typeof UNRESOLVED_REASONS[number])) throw new Error(`reason must be one of ${UNRESOLVED_REASONS.join(', ')}`);
  const integer = (key: string, fallback: number, min: number, max: number): number => {
    if (args[key] === undefined) return fallback;
    const value = args[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer from ${min} to ${max}`);
    return value;
  };
  const limit = integer('limit', 20, 1, 100), offset = integer('offset', 0, 0, Number.MAX_SAFE_INTEGER);
  if (args.evidence !== undefined && typeof args.evidence !== 'boolean') throw new Error('evidence must be a boolean');
  const nodes = new Map(graph.nodes.map(n => [n.id, n]));
  const all = [...(graph.unresolvedCalls ?? [])].sort((a, b) => a.site.path.localeCompare(b.site.path) || (a.site.occurrence?.line ?? 0) - (b.site.occurrence?.line ?? 0)
    || (a.site.occurrence?.column ?? 0) - (b.site.occurrence?.column ?? 0) || a.id.localeCompare(b.id));
  const callers = [...new Set(all.map(ref => ref.source))].sort().map(id => {
    const node = nodes.get(id);
    return node ? { id, name: node.name, owner: node.owner, path: node.path } : { id, missing: true };
  });
  const revision = inventoryRevision('unresolved-calls', { items: all, callers }, args.revision);
  const refs = all.filter(ref => {
    if (query && !normalized(ref.targetName).includes(normalized(query)) && ref.id !== query) return false;
    if (path && !pathUnderPrefix(ref.site.path, normalizePathPrefix(path))) return false;
    if (kind && ref.targetKind !== kind || reason && ref.reason !== reason) return false;
    if (source) {
      const node = nodes.get(ref.source);
      if (!node || ![node.id, node.path, node.name, node.owner ? `${node.owner}=>${node.name}` : node.name]
        .some(name => normalized(name) === normalized(source))) return false;
    }
    return true;
  });
  const counts = new Map<string, number>();
  for (const ref of refs) counts.set(`${ref.targetKind}/${ref.reason}`, (counts.get(`${ref.targetKind}/${ref.reason}`) ?? 0) + 1);
  const page = refs.slice(offset, offset + limit);
  return [
    `Unresolved call inventory: ${refs.length} matched of ${all.length} recorded; offset ${offset}, shown ${page.length}.`,
    ...inventoryRevisionLines(revision, args.revision, offset),
    ...[...counts].sort(([a], [b]) => a.localeCompare(b)).map(([label, count]) => `  ${label}: ${count}`),
    page.length ? formatUnresolvedCalls(graph, page, args.evidence === true, limit) : 'No references on this page.',
    ...(offset + page.length < refs.length ? [`Next page: offset=${offset + page.length}, limit=${limit}, revision="${revision}"; keep the same filters.`] : []),
    'This inventories unresolved source occurrences only. Resolved graph edges and other diagnostic categories are separate.',
  ].join('\n');
}
