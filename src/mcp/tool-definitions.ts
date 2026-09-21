/** MCP descriptions only: importing this module must not load the analysis engine. */
import { UNRESOLVED_KINDS, UNRESOLVED_REASONS } from '../graph/unresolved-calls.js';
import { INVENTORY_REVISION_PATTERN } from '../graph/inventory-revision.js';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: object;
}

export const TOOLS: ToolDef[] = [
  {
    name: 'graft_find_code',
    description:
      'Query the repo context graph in plain words. Returns ranked nodes with exact file:line spans and the relevant source inlined — usually the full answer, no file reads needed.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'what you want to understand, in plain words' },
        limit: { type: 'number', description: 'max results (default 5)' },
        full: {
          type: 'boolean',
          description: 'inline whole definition spans instead of the default ≤8-line crux excerpts',
        },
        in: {
          type: 'string',
          description: 'narrow to nodes under this path prefix, filtered before scoring (segment-aware, like scopeOf)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'graft_file_api',
    description:
      "Signatures-only view of one file — every definition's signature + line span, ~10× cheaper than reading the file ($0, no LLM).",
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'repo-relative path (or unique basename) of the file' },
      },
      required: ['file'],
    },
  },
  {
    name: 'graft_check_freshness',
    description: 'Report whether the local graph is in sync with the local source files (drift check; does not compare a live SAP system).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'graft_trace_calls',
    description:
      'Known structural edges for a symbol, over call/reference/import/implements/extends (no LLM). Defaults to direct callers/dependents. Set direction:"out" for callees/dependencies; depth>1 or depth:"all" traverses indexed edges. ABAP adds exact call sites, controls, earlier exits, preceding local assignments and declaration defaults for one selected shortest chain per reached symbol. Conservative default/guard notices also appear in compact lists. These are lexical evidence and conditional notices, not runtime execution or complete path analysis. External/dynamic/framework callers may be absent.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'bare name, qualified (Class.method), or package-qualified (pkg.Fn); a file path also works' },
        direction: {
          type: 'string',
          enum: ['in', 'out'],
          description: '"in" (default) = callers/dependents; "out" = callees/dependencies',
        },
        depth: {
          anyOf: [
            { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
            { type: 'string', pattern: '^[1-9][0-9]*$' },
            { type: 'string', enum: ['all', 'full'] },
          ],
          description: 'transitive walk depth; positive safe integer or decimal integer string such as "2" (same safe range, no whitespace or leading zeros). Omitted = 1; "all"/"full" = connected closure of indexed relationships. Invalid values are errors, never a fallback to 1. Effective depth appears in the result.',
        },
        in: { type: 'string', description: 'narrow matches to nodes at or under this repo-relative path prefix, e.g. server/src' },
        evidence: { type: 'boolean', description: 'include ABAP source evidence and selected chains (default true); false keeps the compact list and concrete omitted-argument notices. Unknown-caller default assumptions appear only in evidence.' },
        max_sites: { type: 'integer', minimum: 1, maximum: 20, description: 'maximum displayed source occurrences per evidence step (default 3); omitted occurrences are counted' },
        max_targets: { type: 'integer', minimum: 1, maximum: 50, description: 'maximum reached symbols with displayed evidence chains (default 10); omitted targets are counted' },
        evidence_targets: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 50, description: 'ABAP only: show detailed chains only for these reached symbol names/qualified names/full ids; compact list stays complete. Omitted=all; []=no chains. Applied before max_targets.' },
        exit_sources: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 50, description: 'ABAP only: show earlier exits only from these caller symbols in the traversal; other source evidence stays. Omitted=all; []=no earlier exits. Unknown or unavailable selectors are errors.' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'graft_find_all',
    description:
      'Regex search over the graph\'s indexed files, hits grouped by innermost enclosing symbol and ranked by incoming-edge count (coupling) — which hit matters, not just where it is.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'regex pattern (or literal string with fixed: true)' },
        in: { type: 'string', description: 'narrow to files at or under this repo-relative path prefix, e.g. server/src' },
        ignore_case: { type: 'boolean', description: 'case-insensitive match' },
        fixed: { type: 'boolean', description: 'treat pattern as a literal string, not a regex' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'graft_unresolved_calls',
    description: 'Inventory ABAP call sites whose targets could not be resolved. Filter by target text, caller, kind, reason or path; stable pagination exposes every recorded occurrence. These are source references, not resolved graph edges or proof that a target is absent in SAP.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'case-insensitive substring of the recorded target, or exact reference id' },
        source: { type: 'string', description: 'caller bare/qualified name, full node id or exact source file path' },
        target_kind: { type: 'string', enum: [...UNRESOLVED_KINDS] },
        reason: { type: 'string', enum: [...UNRESOLVED_REASONS] },
        in: { type: 'string', description: 'source path prefix, segment-aware' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'page size, default 20' },
        offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: 'zero-based page offset, default 0' },
        evidence: { type: 'boolean', description: 'include the exact invocation text; default false' },
        revision: { type: 'string', pattern: INVENTORY_REVISION_PATTERN, description: 'copy the inventory revision from page 1 to reject continuation after content changes; keep the same filters. Omitted accepts the current inventory.' },
      },
    },
  },
  {
    name: 'graft_diagnostics',
    description: 'Page through recorded ABAP analysis notices, including unsupported syntax and unresolved types. Filter by category, message or source path. Optional source lines were captured with the graph. Notices do not prove source errors, SAP absence or complete analysis coverage.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'case-insensitive substring of kind/message, or exact diagnostic id' },
        kind: { type: 'string', description: 'exact diagnostic category; omit to list categories and their matched counts' },
        in: { type: 'string', description: 'source path prefix, segment-aware' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'page size, default 20' },
        offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: 'zero-based page offset, default 0' },
        evidence: { type: 'boolean', description: 'include the original recorded source line when available; default false' },
        revision: { type: 'string', pattern: INVENTORY_REVISION_PATTERN, description: 'copy the inventory revision from page 1 to reject continuation after content changes; keep the same filters. Omitted accepts the current inventory.' },
      },
    },
  },
  {
    name: 'graft_repo_map',
    description:
      'Token-budgeted repo orientation — directory clusters, per-directory hubs, and global hotspots computed purely from the wiring graph ($0, no LLM). Use this to get oriented in an unfamiliar repo before diving into files.',
    inputSchema: {
      type: 'object',
      properties: {
        max_dirs: { type: 'number', description: 'max directory entries shown, rest counted into dropped (default 16)' },
      },
    },
  },
];
