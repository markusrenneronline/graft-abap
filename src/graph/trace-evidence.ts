/** Bounded, source-backed explanations for the structural trace walk. No I/O,
 * source reconstruction, condition evaluation, or all-path enumeration. */
import { WALK_RELATIONS } from "./relations.js";
import { analyzeCallChain, analyzeDefaultConditions } from "./abap-feasibility.js";
import { selectEvidenceIds } from "./trace-selection.js";
import { evidenceId } from "./evidence-id.js";
import { executionEvidence, executionWarnings } from './call-execution.js';
import { receiverEvidence } from './receiver-evidence.js';
import type { Direction } from "./traverse.js";
import type { CallSiteV1, EarlierExitV1, EdgeV1, GraphV1, LocalAssignmentV1, NodeV1, SourceExcerptV1 } from "./types.js";

export interface TraceEvidenceOptions {
  /** Reached targets whose selected shortest chain is shown. Default 10. */
  maxTargets?: number;
  /** Distinct occurrences shown for each shared call edge. Default 3. */
  maxSites?: number;
  /** Maximum returned string length. Complete evidence blocks are omitted
   * rather than cutting an excerpt or its delimiter. Default 24,000. */
  maxChars?: number;
  /** Only these reached targets get detailed chains. Undefined=all, []=none.
   * Compact traversal results and their concrete notices remain unchanged. */
  evidenceTargets?: string[];
  /** Only these caller symbols contribute earlier exits. Undefined=all,
   * []=none. Other source evidence is unaffected. */
  exitSources?: string[];
}

interface Hop {
  id: string;
  depth: number;
  parent?: Hop;
  edge?: EdgeV1;
}

interface Block {
  kind: "chain" | "step" | "declaration" | "exit" | "assignment";
  text: string;
}

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const edgeKey = (edge: EdgeV1): string => `${edge.source}\0${edge.relation}\0${edge.target}`;
const excerptKey = (excerpt: SourceExcerptV1): string => JSON.stringify([excerpt.path, excerpt.span, excerpt.text]);
const siteKey = (site: CallSiteV1): string => JSON.stringify([
  excerptKey(site),
  site.occurrence ? [site.occurrence.line, site.occurrence.column] : null,
  (site.controls ?? []).map(control => [control.kind, excerptKey(control), (control.priorBranches ?? []).map(excerptKey)]),
  site.earlierExits ?? null, site.arguments ?? null, site.argumentsComplete ?? null, site.unchangedParameters ?? null,
  site.localAssignments ?? null, site.execution ?? null, site.receiverType ?? null, site.construction ?? null,
]);

function limit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function distinctSites(sites: readonly CallSiteV1[]): CallSiteV1[] {
  const unique = new Map(sites.map(site => [siteKey(site), site]));
  return [...unique.values()].sort((a, b) =>
    compare(a.path, b.path) || firstLine(a.span) - firstLine(b.span) || compare(a.span, b.span) ||
    (a.occurrence?.line ?? 0) - (b.occurrence?.line ?? 0) ||
    (a.occurrence?.column ?? 0) - (b.occurrence?.column ?? 0) || compare(siteKey(a), siteKey(b)));
}

function firstLine(span: string): number {
  return Number(span.match(/\d+/)?.[0] ?? 0);
}

/** Preserve all recorded occurrences if an older producer supplied duplicate
 * edges. Sorting and deduplication only organize existing evidence. */
function walkEdges(graph: GraphV1): EdgeV1[] {
  const edges = new Map<string, EdgeV1>();
  const confidence = ["lsp_resolved", "lsp_dispatch", "extracted", "inferred"];
  for (const edge of graph.edges) {
    if (!WALK_RELATIONS.has(edge.relation)) continue;
    const key = edgeKey(edge);
    const previous = edges.get(key);
    const preferred = previous && confidence.indexOf(previous.confidence) < confidence.indexOf(edge.confidence)
      ? previous : edge;
    edges.set(key, {
      ...preferred,
      callSites: distinctSites([...(previous?.callSites ?? []), ...(edge.callSites ?? [])]),
    });
  }
  return [...edges.values()].sort((a, b) => compare(edgeKey(a), edgeKey(b)));
}

/** Same seed/depth rules as edgeWalk: depth 1 scans the actual seed (including
 * self-loops); deeper file queries start from the file and all its symbols,
 * premarking every seed so internal edges are not reported as reached targets. */
function shortestTargets(graph: GraphV1, seed: NodeV1, direction: Direction, depth: number): Hop[] {
  const maxDepth = Number.isNaN(depth) ? 1 : Math.floor(depth);
  const seeds = maxDepth > 1 && seed.kind === "file"
    ? [seed, ...graph.nodes.filter(node => node.kind !== "file" && node.path === seed.path)]
    : [seed];
  const roots: Hop[] = [...new Set(seeds.map(node => node.id))].sort(compare).map(id => ({ id, depth: 0 }));
  const adjacency = new Map<string, { id: string; edge: EdgeV1 }[]>();
  for (const edge of walkEdges(graph)) {
    const key = direction === "out" ? edge.source : edge.target;
    const id = direction === "out" ? edge.target : edge.source;
    const list = adjacency.get(key) ?? [];
    list.push({ id, edge });
    adjacency.set(key, list);
  }
  for (const list of adjacency.values()) list.sort((a, b) => compare(a.id, b.id) || compare(edgeKey(a.edge), edgeKey(b.edge)));

  const hits: Hop[] = [];
  // A single-hop walk includes self-recursion, matching callersOf/calleesOf.
  if (maxDepth <= 1) {
    const seen = new Set<string>();
    for (const { id, edge } of adjacency.get(seed.id) ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      hits.push({ id, depth: 1, parent: roots[0], edge });
    }
    return hits;
  }

  const seen = new Set(roots.map(root => root.id));
  const queue = [...roots];
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    if (current.depth >= maxDepth) continue;
    for (const { id, edge } of adjacency.get(current.id) ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      const next = { id, depth: current.depth + 1, parent: current, edge };
      hits.push(next);
      queue.push(next);
    }
  }
  return hits.sort((a, b) => a.depth - b.depth || compare(a.id, b.id));
}

/** Return actual source → target edges even when BFS ran backwards. */
function chainOf(hit: Hop, direction: Direction): EdgeV1[] {
  const edges: EdgeV1[] = [];
  for (let hop: Hop | undefined = hit; hop?.edge; hop = hop.parent) edges.push(hop.edge);
  return direction === "out" ? edges.reverse() : edges;
}

function chainWarnings(graph: GraphV1, chain: EdgeV1[], direction: Direction): string[] {
  return [...executionWarnings(chain), ...analyzeCallChain(graph, chain),
    ...(direction === 'out' && chain.length ? analyzeDefaultConditions(graph, chain[0]) : [])];
}

/** Same selected chains as the detailed formatter, without its display limits.
 * Compact lists contain execution boundaries and concrete omission notices; unknown-caller
 * assumptions stay in detailed evidence. */
export function traceChainWarnings(graph: GraphV1, seed: NodeV1, direction: Direction, depth: number): Map<string, string[]> {
  return new Map(shortestTargets(graph, seed, direction, depth).map(hit =>
    [hit.id, [...executionWarnings(chainOf(hit, direction)), ...analyzeCallChain(graph, chainOf(hit, direction))]]));
}

function excerpt(label: string, value: SourceExcerptV1): string {
  // Source strings may themselves contain Markdown fences. A longer delimiter
  // keeps them literal and leaves every printed excerpt explicitly bounded.
  let ticks = 3;
  for (const match of value.text.matchAll(/`+/g)) ticks = Math.max(ticks, match[0].length + 1);
  const fence = "`".repeat(ticks);
  const language = /\.abap$/i.test(value.path) ? "abap" : /\.xml$/i.test(value.path) ? "xml" : "text";
  return `${label}: ${value.path}:${value.span}\n${fence}${language}\n${value.text}${value.text.endsWith("\n") ? "" : "\n"}${fence}`;
}

export function formatTraceEvidence(
  graph: GraphV1,
  seed: NodeV1,
  direction: Direction,
  depth: number,
  opts: TraceEvidenceOptions = {},
): string {
  const maxTargets = limit(opts.maxTargets, 10);
  const maxSites = limit(opts.maxSites, 3);
  const maxChars = limit(opts.maxChars, 24_000);
  if (maxChars === 0) return "";
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  // Full identity and locations live in the shared step blocks. Repeating long
  // repository paths at every point of every chain crowds out source evidence.
  const chainLabel = (id: string): string => {
    const node = byId.get(id);
    return node ? node.kind === "file" ? node.path : `${node.owner ? `${node.owner}.` : ""}${node.name}` : id;
  };
  const targets = shortestTargets(graph, seed, direction, depth);
  const targetIds = selectEvidenceIds(graph, targets.map(hit => hit.id), opts.evidenceTargets, 'evidence_targets');
  const sourceIds = selectEvidenceIds(graph, targets.flatMap(hit => chainOf(hit, direction).filter(edge => edge.relation === 'calls').map(edge => edge.source)), opts.exitSources, 'exit_sources');
  const eligible = targetIds ? targets.filter(hit => targetIds.has(hit.id)) : targets;
  const selected = eligible.slice(0, maxTargets);
  const steps = new Map<string, { label: string; edge: EdgeV1 }>();
  const declarations = new Map<string, string>();
  const earlierExits = new Map<string, { label: string; value: EarlierExitV1 }>();
  const assignments = new Map<string, { label: string; value: LocalAssignmentV1; priorCandidate: boolean }>();
  const registerAssignment = (value: LocalAssignmentV1, priorCandidate = false): string => {
    const key = JSON.stringify(value);
    let shared = assignments.get(key);
    if (!shared) {
      shared = { label: `A${assignments.size + 1}`, value, priorCandidate };
      assignments.set(key, shared);
    } else if (!priorCandidate) shared.priorCandidate = false;
    return shared.label;
  };
  // The query's own defaults can govern its outgoing branch even when it never
  // appears as a callee in this walk.
  if (seed.declaration) declarations.set(seed.id, "D1");
  const blocks: Block[] = [];
  for (const [index, hit] of selected.entries()) {
    const chain = chainOf(hit, direction);
    let text = chainLabel(chain[0].source);
    for (const edge of chain) {
      const key = edgeKey(edge);
      let step = steps.get(key);
      if (!step) {
        step = { label: `S${steps.size + 1}`, edge };
        steps.set(key, step);
      }
      text += ` --${edge.relation} [${step.label}]--> ${chainLabel(edge.target)}`;
    }
    const notices = chainWarnings(graph, chain, direction).map(message => `[${message}]`);
    blocks.push({ kind: "chain", text: `Selected chain T${index + 1} (${hit.depth} hop${hit.depth === 1 ? "" : "s"}; reached ${chainLabel(hit.id)}):\n${text}${notices.length ? `\n${notices.join('\n')}` : ''}` });
  }

  let omittedSites = 0;
  let filteredExitSites = 0;
  for (const { label: step, edge } of steps.values()) {
    const from = byId.get(edge.source);
    const to = byId.get(edge.target);
    const lines = [
      `[${step}] ${edge.relation} (${edge.confidence})`,
      `Source: ${chainLabel(edge.source)} @ ${from ? `${from.path}:${from.span}` : "unresolved node; location unavailable"}.`,
      `Target: ${chainLabel(edge.target)} @ ${to ? `${to.path}:${to.span}` : "unresolved node; location unavailable"}.`,
    ];
    if (edge.relation === "calls") {
      let declaration = declarations.get(edge.target);
      if (!declaration) {
        declaration = `D${declarations.size + 1}`;
        declarations.set(edge.target, declaration);
      }
      lines.push(`Callee declaration: [${declaration}].`);
      const sites = edge.callSites ?? [];
      omittedSites += Math.max(0, sites.length - maxSites);
      if (sites.length === 0) lines.push("Call-site evidence unavailable in this graph; no source excerpt inferred.");
      else {
        lines.push(`Recorded call sites: showing ${Math.min(sites.length, maxSites)} of ${sites.length}.`);
        for (const [index, site] of sites.slice(0, maxSites).entries()) {
          if (site.occurrence) lines.push(`Invocation ${index + 1}: ${site.path}:L${site.occurrence.line}:C${site.occurrence.column}.`);
          lines.push(`Stable evidence ID: ${evidenceId('call', site, site.occurrence)}`);
          lines.push(excerpt(`Call site ${index + 1}`, site));
          const execution = executionEvidence(site);
          if (execution) lines.push(execution);
          if (site.receiverType) {
            const receiver = receiverEvidence(site.receiverType);
            lines.push(receiver.description, excerpt(receiver.sourceLabel, site.receiverType.source));
            for (const declaration of site.receiverType.via ?? []) lines.push(excerpt(receiver.hierarchyLabel, declaration));
            if (site.receiverType.inlineDeclaration) lines.push(excerpt('Inline reference declaration', site.receiverType.inlineDeclaration));
          }
          if (site.construction) lines.push(`Object construction: ${site.construction.className}; ${site.construction.implicitForwarding ? 'implicit forwarding to the first explicitly declared base constructor' : 'explicit constructor of this class'}. Successful construction is not proven.`);
          if (site.construction?.inferredType) {
            const type = site.construction.inferredType;
            lines.push(`Constructor type from assignment target ${type.target}; static type only, assignment and construction success not proven.`,
              excerpt('Assignment target type declaration', type.source));
            for (const declaration of type.via ?? []) lines.push(excerpt('Assignment target type hierarchy', declaration));
            if (type.inlineDeclaration) lines.push(excerpt('Assignment target inline declaration', type.inlineDeclaration));
          }
          if (!site.controls?.length) lines.push("No lexically enclosing control header at this call; earlier exits and data dependencies can still affect execution.");
          for (const control of site.controls ?? []) {
            for (const prior of control.priorBranches ?? []) lines.push(excerpt("Earlier branch header (not evaluated)", prior));
            lines.push(excerpt(`Enclosing control ${control.kind} (lexical context)`, control));
          }
          if (site.earlierExits === undefined) {
            lines.push('Earlier exits: evidence unavailable in this graph.');
          } else if (site.earlierExits.length === 0) {
            lines.push('Earlier exits (not evaluated): no earlier RETURN/EXIT/CHECK recorded in this processing block.');
          } else if (sourceIds && !sourceIds.has(edge.source)) {
            filteredExitSites++;
            lines.push('Earlier exits omitted by exit_sources filter; absence here is not evidence of unconditional execution.');
          } else {
            const labels = site.earlierExits.map(value => {
              const key = JSON.stringify(value);
              let shared = earlierExits.get(key);
              if (!shared) {
                shared = { label: `E${earlierExits.size + 1}`, value };
                earlierExits.set(key, shared);
              }
              return `[${shared.label}]`;
            });
            lines.push(`Earlier exits (not evaluated): ${labels.join(', ')}. Earlier syntax in the same processing block; not proof that any exit is reached.`);
          }
          if (site.localAssignments?.length) {
            const labels = site.localAssignments.map(value => {
              const label = registerAssignment(value);
              return `${value.variable} [${label}]${value.kind === 'call_output' ? ' (assigned via call output)' : ''}`;
            });
            lines.push(`Local assignment evidence (not evaluated): ${labels.join(', ')}. Source order only; conditional writes and loops may produce different runtime values.`);
          } else lines.push(site.localAssignments === undefined
            ? 'Local assignments: evidence unavailable in this graph.'
            : 'Local assignments: no eligible preceding direct assignment or call output recorded for the passed local variables.');
        }
      }
    } else lines.push("Structural relationship; call-site evidence does not apply.");
    blocks.push({ kind: "step", text: lines.join("\n") });
  }
  for (const [id, declaration] of declarations) {
    const source = id === seed.id ? seed.declaration : byId.get(id)?.declaration;
    const declarationLabel = id === seed.id && seed.declaration ? "Queried symbol declaration" : "Callee declaration";
    blocks.push({
      kind: "declaration",
      text: source
        ? `[${declaration}] ${chainLabel(id)}\nStable evidence ID: ${evidenceId('declaration', source)}\n${excerpt(`${declarationLabel} (defaults as written; no argument substitution)`, source)}`
        : `[${declaration}] ${chainLabel(id)}\nCallee declaration evidence unavailable in this graph.`,
    });
  }
  for (const { label, value } of earlierExits.values()) {
    const effect = value.effect === 'loop_exit' ? 'leaves the innermost loop' : value.effect === 'loop_iteration' ? 'skips the current loop iteration' : 'leaves the processing block';
    const lines = [`[${label}] Earlier exit (not evaluated): ${value.kind} ${effect}${value.kind === 'CHECK' ? ' if its condition is false' : ' if reached'}.`, `Stable evidence ID: ${evidenceId('exit', value)}`, excerpt('Earlier exit source', value)];
    for (const control of value.controls ?? []) {
      for (const prior of control.priorBranches ?? []) lines.push(excerpt('Earlier exit prior branch (not evaluated)', prior));
      lines.push(excerpt(`Earlier exit control ${control.kind} (not evaluated)`, control));
    }
    blocks.push({ kind: 'exit', text: lines.join('\n') });
  }
  for (const { label, value, priorCandidate } of assignments.values()) {
    const heading = value.kind === 'call_output'
      ? `Assigned via call output (not evaluated): ${value.variable}${value.output ? `; ${value.output.direction}${value.output.parameter ? ` ${value.output.parameter}` : ''}` : ''}. Call success and output value are unknown.`
      : `${priorCandidate ? 'Earlier direct assignment candidate' : 'Last preceding direct assignment'} (not evaluated): ${value.variable}.`;
    const lines = [`[${label}] ${heading}`, `Stable evidence ID: ${evidenceId('assignment', value)}`, excerpt('Local assignment source', value)];
    for (const control of value.controls ?? []) {
      for (const prior of control.priorBranches ?? []) lines.push(excerpt('Local assignment prior branch (not evaluated)', prior));
      lines.push(excerpt(`Local assignment control ${control.kind} (not evaluated)`, control));
    }
    if (value.priorAssignments?.length) {
      const labels = value.priorAssignments.map(prior => `[${registerAssignment(prior, true)}]`);
      lines.push(`Earlier assignment candidates outside the latest control (not evaluated): ${labels.join(', ')}. These are earlier source writes, not a proven fallback value or complete branch coverage.`);
    }
    blocks.push({ kind: 'assignment', text: lines.join('\n') });
  }

  const header = [
    `Trace evidence (${direction === "in" ? "incoming" : "outgoing"}; structural graph).`,
    "One deterministic shortest chain per reached target is selected; alternative paths are not enumerated. Shared steps and declarations are printed once.",
    "Short labels (S/D/E/A) are local to this response; Stable evidence ID identifies the same recorded source across queries and filters, not a runtime event.",
    "Excerpts show recorded source and lexical context. They do not evaluate runtime conditions, propagate arguments, or prove execution; absent control evidence does not mean unconditional execution. Notices only compare recorded omitted literal defaults with simple guards on unchanged parameters at specific sites.",
    `Reached targets: ${targets.length}; eligible for evidence: ${eligible.length}; selected by target limit: ${selected.length}.`,
    ...(opts.evidenceTargets === undefined ? [] : [`Evidence target selection: ${opts.evidenceTargets.join(', ') || '(none)'}. Compact traversal results are unchanged.`]),
    ...(opts.exitSources === undefined ? [] : [`Earlier-exit source selection: ${opts.exitSources.join(', ') || '(none)'}. Other evidence is unchanged.`]),
    ...(targets.length ? [] : ["No reached targets for this walk."]),
  ].join("\n");
  const omitted = { chain: 0, step: 0, declaration: 0, exit: 0, assignment: 0 };
  const footer = (): string =>
    `Omitted: ${eligible.length - selected.length} target(s) by target limit; ${omittedSites} call site(s) by per-step site limit; ${omitted.chain} selected chain(s), ${omitted.step} step detail(s), ${omitted.declaration} declaration(s), ${omitted.exit} earlier exit(s), ${omitted.assignment} local assignment(s) by character limit; ${targets.length - eligible.length} target(s) by evidence_targets; ${filteredExitSites} call-site exit section(s) by exit_sources. Unprinted labels refer to omitted blocks, not missing proof.`;
  // Reserve for the largest possible omission counters so the actual footer
  // always fits. Entire blocks remain balanced, including source-code fences.
  const reserve = footer().length + String(blocks.length).length * 5;
  if (header.length + reserve + 2 > maxChars) {
    const short = `Trace evidence omitted: character limit (${maxChars}); ${targets.length} reached target(s).`;
    return short.length <= maxChars ? short : "Evidence omitted by character limit.".slice(0, maxChars);
  }
  // Reserve the budget for source/default evidence before the more verbose
  // chain labels. Retained blocks are still presented in their readable order:
  // chains, shared steps, declarations. The footer accounts for every omission.
  const priority = { declaration: 0, step: 1, assignment: 2, exit: 3, chain: 4 };
  const retained = new Set<Block>();
  let used = header.length + reserve + 2;
  for (const block of [...blocks].sort((a, b) => priority[a.kind] - priority[b.kind])) {
    if (used + block.text.length + 2 <= maxChars) {
      retained.add(block);
      used += block.text.length + 2;
    }
    else omitted[block.kind]++;
  }
  let output = header;
  for (const block of blocks) if (retained.has(block)) output += `\n\n${block.text}`;
  return `${output}\n\n${footer()}`;
}
