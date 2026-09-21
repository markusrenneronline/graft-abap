/**
 * The MCP tools, as pure functions over the existing engine.
 * `callTool` never throws — hosts get soft errors as isError content.
 */
import { Graft } from '../engine.js';
import { formatAsk, skeleton, formatSkeleton } from '../ask/ask.js';
import { formatCheckReport } from '../context/check.js';
import { formatGraphCheckReport } from '../graph/check.js';
import { loadGraphCached } from '../graph/load.js';
import { ensureFreshChildren, ensureFreshGraph, refreshNote } from '../graph/refresh.js';
import { contextDirFor } from '../context/node-file.js';
import { resolveSymbol, edgeWalk, type Direction, type EdgeHit } from '../graph/traverse.js';
import { formatUnresolvedCalls, unresolvedCallMatches, queryUnresolvedCalls } from '../graph/unresolved-calls.js';
import { callersSavings, headerOf, hitLine, looseNoteFor } from '../graph/traverse-cli.js';
import { withSavings, setInputRate } from '../context/savings.js';
import { sessionInputRate } from '../claude/session-metrics.js';
import { grepGraph } from '../search/grep.js';
import { formatGrepResult, zeroHitNote } from '../search/grep-cli.js';
import { buildRepoMap, formatRepoMap } from '../graph/map.js';
import {
  federateAsk,
  federateCallers,
  federateCheck,
  federateGrep,
  federateMap,
  readWorkspace,
} from '../graph/workspace.js';
import type { NodeV1 } from '../graph/types.js';
import { canonicalToolName } from './tool-names.js';
import { abapCoverageNote, abapTraceDiagnostics } from '../graph/abap-coverage.js';
import { formatTraceEvidence, traceChainWarnings } from '../graph/trace-evidence.js';
import { parseEvidenceSelectors } from '../graph/trace-selection.js';
import { createHash } from 'node:crypto';
import { queryDiagnostics } from '../graph/diagnostics.js';
import { TOOLS } from './tool-definitions.js';
export { TOOLS, type ToolDef } from './tool-definitions.js';

const NO_GRAPH = 'no graph found — run `graft build` first';

/** Normalize once before either the repository or workspace handler. Only an
 * omitted value defaults to 1; old clients may send integer depths as strings. */
function parseTraceDepth(value: unknown): number {
  if (value === undefined) return 1;
  if (value === 'all' || value === 'full') return Number.POSITIVE_INFINITY;
  const number = typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : value;
  if (typeof number === 'number' && Number.isSafeInteger(number) && number >= 1) return number;
  throw new Error('graft_trace_calls: depth must be a positive safe integer (1–9007199254740991), a decimal integer string such as "2" (no whitespace or leading zeros), or "all"/"full". Omit depth for 1.');
}

function unknownSymbolText(query: string): string {
  return `no symbol "${query}" in the graph — check spelling or run \`graft build\``;
}



/** Render every resolved match's header + edge report (or the loud zero-edge
 * note), one block per match, joined with a blank line — the same grouping
 * `graft callers` uses for multi-match symbols. `showDepth` tags each hit with
 * its BFS depth (for transitive `depth>1` walks). */
function renderMatches(
  direction: Direction,
  showDepth: boolean,
  matches: NodeV1[],
  hitsFor: (n: NodeV1) => EdgeHit[],
  warningsFor: (n: NodeV1, hit: EdgeHit) => string[] = () => [],
): string {
  return matches
    .map((m) => {
      const hits = hitsFor(m);
      const lines = [headerOf(m)];
      if (hits.length === 0) lines.push(looseNoteFor(direction, m.name, matches.length));
      else for (const h of hits) lines.push(hitLine(direction, h, showDepth) + warningsFor(m, h).map(message => ` [${message}]`).join(''));
      return lines.join('\n');
    })
    .join('\n\n');
}

/** When the MCP server is rooted at a workspace parent, the ask/callers/grep/
 * map/check tools federate across the children — identical to the CLI. Returns
 * null for tools that don't federate (skeleton is per-file), so the caller
 * falls through to the normal single-graph path. */
async function callWorkspaceTool(
  root: string,
  dirOverride: string | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean } | null> {
  if (name === 'graft_unresolved_calls' || name === 'graft_diagnostics') return { text: `Query ${name} on an individual repository; workspace-wide pagination is not supported.`, isError: true };
  if (name === 'graft_trace_calls' && (args.evidence_targets !== undefined || args.exit_sources !== undefined)) {
    return { text: 'ABAP evidence selectors require a single repository graph; query the repository directly instead of its workspace parent.', isError: true };
  }
  switch (name) {
    case 'graft_find_code': {
      const query = String(args.query ?? '');
      if (!query) return { text: 'graft_find_code requires a query', isError: true };
      const limit = typeof args.limit === 'number' ? args.limit : 5;
      const inArg = typeof args.in === 'string' && args.in ? args.in : undefined;
      const r = federateAsk(root, dirOverride, query, { limit, source: true, full: args.full === true, in: inArg });
      return { text: formatAsk(r), isError: false };
    }
    case 'graft_trace_calls': {
      const symbol = String(args.symbol ?? args.file ?? '');
      if (!symbol) return { text: 'graft_trace_calls requires a symbol', isError: true };
      const { text, found } = federateCallers(root, dirOverride, symbol, {
        direction: args.direction === 'out' ? 'out' : 'in',
        depth: args.depth as number, // normalized by callTool, including all/full → Infinity
        in: typeof args.in === 'string' && args.in ? args.in : undefined,
      });
      return { text, isError: !found };
    }
    case 'graft_find_all': {
      const pattern = String(args.pattern ?? '');
      if (!pattern) return { text: 'graft_find_all requires a pattern', isError: true };
      const { result, coverage } = federateGrep(root, dirOverride, pattern, {
        ignoreCase: typeof args.ignore_case === 'boolean' ? args.ignore_case : undefined,
        fixed: typeof args.fixed === 'boolean' ? args.fixed : undefined,
      });
      const text = result.totalHits === 0 ? zeroHitNote(result) : formatGrepResult(result);
      return { text: coverage ? `${text}\n${coverage}` : text, isError: false };
    }
    case 'graft_repo_map': {
      const maxDirs = typeof args.max_dirs === 'number' && Number.isFinite(args.max_dirs) && args.max_dirs > 0 ? args.max_dirs : undefined;
      return { text: federateMap(root, dirOverride, { maxDirs }), isError: false };
    }
    case 'graft_check_freshness': {
      const { text } = await federateCheck(root, dirOverride);
      return { text, isError: false };
    }
    default:
      return null;
  }
}

/** Tools whose whole job is to REPORT drift. Rebuilding first would make
 * `graft_check_freshness` answer about a graph it just fixed, i.e. always "OK". */
const NO_REFRESH_TOOLS = new Set(['graft_check_freshness']);

/**
 * The pre-0.8.1 tool names, still accepted, live in the dependency-free
 * `tool-names.ts` (shared with the engine-free session hooks). The names were the
 * reason for renaming: when a host defers graft's schemas it shows the model the
 * *names alone* — no descriptions — so `graft_ask` had to compete with `Grep` on
 * 9 characters. The new names say what they do; the aliases keep old callers
 * (skills, saved prompts, notes) from 404-ing. Re-exported here so existing
 * importers of `canonicalToolName` from this module keep working.
 */
export { canonicalToolName };

export async function callTool(
  root: string,
  requestedName: string,
  args: Record<string, unknown>,
  dirOverride?: string,
): Promise<{ text: string; isError: boolean }> {
  try {
    const name = canonicalToolName(requestedName);
    const traceDepth = name === 'graft_trace_calls' ? parseTraceDepth(args.depth) : undefined;
    if (traceDepth !== undefined) args = { ...args, depth: traceDepth };
    const ws = readWorkspace(root, dirOverride);
    // Freshness first: an answer that cites file:line has to be about the code as
    // it is right now, including edits nobody has committed (or even saved through
    // this agent). ~3ms when nothing moved; a structural, $0 rebuild when it did.
    // Same reason as the CLI's `noteQuery`: price this session's tokens once,
    // here, so the formatters downstream can put a dollar figure in the nudge.
    setInputRate(sessionInputRate(root));
    let note: string | null = null;
    if (!NO_REFRESH_TOOLS.has(name)) {
      const r = ws
        ? await ensureFreshChildren(root, ws.children, { contextDir: dirOverride })
        : await ensureFreshGraph(root, { contextDir: dirOverride });
      note = refreshNote(r);
    }
    const fed = ws ? await callWorkspaceTool(root, dirOverride, name, args) : null;
    const res = fed ?? (await callSingleTool(root, name, args, dirOverride));
    const coverage = ws ? '' : abapCoverageNote(contextDirFor(root, dirOverride), { trace: name === 'graft_trace_calls' });
    const depthNote = traceDepth !== undefined && !res.isError
      ? `[Trace] effective depth: ${traceDepth === Number.POSITIVE_INFINITY ? 'all' : traceDepth}` : '';
    const prefix = [note, coverage, depthNote].filter(Boolean).join('\n');
    return prefix ? { ...res, text: `${prefix}\n${res.text}` } : res;
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), isError: true };
  }
}

/** The single-graph path: every tool, answered from one repo's graph. */
async function callSingleTool(
  root: string,
  name: string,
  args: Record<string, unknown>,
  dirOverride?: string,
): Promise<{ text: string; isError: boolean }> {
  switch (name) {
      case 'graft_find_code': {
        const query = String(args.query ?? '');
        if (!query) return { text: 'graft_find_code requires a query', isError: true };
        const limit = typeof args.limit === 'number' ? args.limit : 5;
        const engine = new Graft({ contextDir: dirOverride });
        const inArg = typeof args.in === 'string' && args.in ? args.in : undefined;
        const r = engine.ask(root, query, { limit, source: true, full: args.full === true, in: inArg });
        return { text: formatAsk(r), isError: false };
      }
      case 'graft_file_api': {
        const file = String(args.file ?? '');
        if (!file) return { text: 'graft_file_api requires a file', isError: true };
        const r = skeleton(root, file, { contextDir: dirOverride });
        return { text: formatSkeleton(r), isError: !r.entries.length && !!r.note };
      }
      case 'graft_check_freshness': {
        const engine = new Graft({ contextDir: dirOverride });
        const g = await engine.checkGraph(root);
        const traceSchema = TOOLS.find(tool => tool.name === 'graft_trace_calls')!.inputSchema as { properties: Record<string, unknown> };
        const schemaNote = process.env.GRAFT_PILOT_VERSION
          ? `\n[Trace tool schema] SHA-256 ${createHash('sha256').update(JSON.stringify(traceSchema)).digest('hex')}; parameters: ${Object.keys(traceSchema.properties).join(', ')}. This describes the running server, not the client's cached schema.` : '';
        if (process.env.GRAFT_STRUCTURAL_ONLY === '1') {
          return { text: formatGraphCheckReport(g, { showPending: false }) + schemaNote, isError: g.missing || !!g.errors?.length };
        }
        const r = engine.check(root);
        const parts = [formatCheckReport(r)];
        if (!g.missing) parts.push(formatGraphCheckReport(g));
        return { text: parts.join('\n\n') + schemaNote, isError: false };
      }
      case 'graft_trace_calls': {
        // One tool covers callers (direction:in, the default), callees
        // (direction:out), and blast radius (depth>1). edgeWalk handles the
        // file-seed aggregation that the old graft_blast_radius did: for a
        // file at depth>1 it walks the file node AND every symbol defined in
        // it, so dependents that call into a symbol (targeting the SYMBOL id,
        // never the FILE id) aren't silently dropped.
        const evidenceTargets = parseEvidenceSelectors(args.evidence_targets, 'evidence_targets');
        const exitSources = parseEvidenceSelectors(args.exit_sources, 'exit_sources');
        const symbol = String(args.symbol ?? args.file ?? '');
        if (!symbol) return { text: 'graft_trace_calls requires a symbol', isError: true };
        const w = loadGraphCached(contextDirFor(root, dirOverride));
        if (!w) return { text: NO_GRAPH, isError: true };
        if (!w.meta?.languages?.includes('abap') && (evidenceTargets !== undefined || exitSources !== undefined)) {
          return { text: 'evidence_targets and exit_sources require an ABAP graph.', isError: true };
        }
        const inOpt = typeof args.in === 'string' && args.in ? { in: args.in } : {};
        const matches = resolveSymbol(w, symbol, inOpt);
        const direction: Direction = args.direction === 'out' ? 'out' : 'in';
        const unresolved = direction === 'in' ? unresolvedCallMatches(w, symbol, inOpt.in) : [];
        if (matches.length === 0) {
          return unresolved.length ? { text: formatUnresolvedCalls(w, unresolved, args.evidence !== false), isError: false }
            : { text: unknownSymbolText(symbol), isError: true };
        }
        // `depth: "all"` (or a huge number) walks the full transitive closure —
        // every connected source — terminating when no new node is reached.
        const depth = args.depth as number; // normalized by callTool
        const results = matches.map((m) => ({ symbol: m, hits: edgeWalk(w, m, direction, depth) }));
        const byId = new Map(results.map((r) => [r.symbol.id, r.hits]));
        const notices = new Map(matches.map(m => [m.id, w.meta?.languages?.includes('abap')
          ? traceChainWarnings(w, m, direction, depth) : new Map<string, string[]>()]));
        let body = renderMatches(direction, depth > 1, matches, (m) => byId.get(m.id) ?? [],
          (m, hit) => notices.get(m.id)?.get(hit.id) ?? []);
        const gaps = direction === 'in' ? unresolved : (w.unresolvedCalls ?? []).filter(ref => matches.some(node => node.id === ref.source));
        if (gaps.length) body += `\n\n${formatUnresolvedCalls(w, gaps, args.evidence !== false)}`;
        if (direction === 'out' && w.meta?.languages?.includes('abap')) {
          // A skipped NEW is not necessarily a method call and thus has no
          // unresolved-call row. Retain that structural gap in compact mode.
          const diagnostics = abapTraceDiagnostics(contextDirFor(root, dirOverride), matches,
            args.evidence === false ? ['unresolved_construction'] : undefined);
          if (diagnostics) body += `\n\n${diagnostics}`;
        }
        if (args.evidence !== false && w.meta?.languages?.includes('abap')) {
          const bounded = (value: unknown, fallback: number, max: number): number =>
            typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(1, Math.floor(value))) : fallback;
          const sections = matches.map(m => formatTraceEvidence(w, m, direction, depth, {
            maxSites: bounded(args.max_sites, 3, 20), maxTargets: bounded(args.max_targets, 10, 50),
            evidenceTargets, exitSources,
          })).filter(Boolean);
          if (sections.length) body += `\n\n${sections.join('\n\n')}`;
        }
        if (args.evidence === false && (evidenceTargets !== undefined || exitSources !== undefined)) {
          body += '\nEvidence selectors are inactive because evidence=false; compact results are unchanged.';
        }
        const text = withSavings(body, callersSavings(w, results));
        return { text, isError: false };
      }
      case 'graft_find_all': {
        const pattern = String(args.pattern ?? '');
        if (!pattern) return { text: 'graft_find_all requires a pattern', isError: true };
        const w = loadGraphCached(contextDirFor(root, dirOverride));
        if (!w) return { text: NO_GRAPH, isError: true };
        const result = grepGraph(w, root, pattern, {
          ignoreCase: typeof args.ignore_case === 'boolean' ? args.ignore_case : undefined,
          fixed: typeof args.fixed === 'boolean' ? args.fixed : undefined,
          in: typeof args.in === 'string' && args.in ? args.in : undefined,
        });
        if (result.totalHits === 0) return { text: zeroHitNote(result), isError: false };
        return { text: formatGrepResult(result), isError: false };
      }
      case 'graft_repo_map': {
        const w = loadGraphCached(contextDirFor(root, dirOverride));
        if (!w) return { text: NO_GRAPH, isError: true };
        const maxDirs = typeof args.max_dirs === 'number' && Number.isFinite(args.max_dirs) && args.max_dirs > 0 ? args.max_dirs : undefined;
        const map = buildRepoMap(w, { maxDirs });
        return { text: formatRepoMap(map), isError: false };
      }
      case 'graft_diagnostics':
      case 'graft_unresolved_calls': {
        const w = loadGraphCached(contextDirFor(root, dirOverride));
        if (!w) return { text: NO_GRAPH, isError: true };
        return { text: name === 'graft_diagnostics' ? queryDiagnostics(w, args) : queryUnresolvedCalls(w, args), isError: false };
      }
    default:
      return { text: `unknown tool: ${name}`, isError: true };
  }
}
