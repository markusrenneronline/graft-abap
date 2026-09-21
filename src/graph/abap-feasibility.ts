/** A deliberately narrow default-versus-guard check for recorded ABAP sites.
 * This is not path feasibility, data-flow propagation, or a runtime evaluator.
 * Missing metadata always means unknown; only an omitted named argument with
 * a supported declared default can participate in an adjacent-edge notice. */
import type { AbapParameterV1, CallSiteV1, ControlContextV1, EdgeV1, GraphV1, NodeV1, SourceExcerptV1 } from "./types.js";

interface Literal { value: string; raw: string }
interface Parameter { name: string; literal: Literal }
interface Equality { keyword: "IF" | "ELSEIF"; parameter: string; literal: Literal }
interface Contradiction { parameter: Parameter; control: ControlContextV1; condition: string }

const upper = (text: string): string => text.trim().toUpperCase();
const summary = (text: string): string => text.trim().replace(/\s+/g, " ");
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/** No type metadata is available here. Restrict quoted literals to one
 * nonnumeric character or blank, avoiding longer-value truncation and numeric
 * conversion guesses. Named constants other than ABAP_TRUE/FALSE stay unknown. */
function literal(raw: string | undefined): Literal | undefined {
  if (raw === undefined) return undefined;
  const text = raw.trim();
  if (upper(text) === "ABAP_TRUE") return { value: "X", raw: text };
  if (upper(text) === "ABAP_FALSE") return { value: "", raw: text };
  if (!/^'(?:[^'\r\n]|'')*'$/.test(text)) return undefined;
  const decoded = text.slice(1, -1).replace(/''/g, "'");
  const value = decoded.replace(/ +$/, "");
  if (value.length > 1 || /[0-9+\-.]/.test(value)) return undefined;
  return { value, raw: text };
}

function parameters(node: NodeV1 | undefined): Map<string, Parameter> {
  const declared = new Map<string, AbapParameterV1[]>();
  for (const parameter of node?.abapParameters ?? []) {
    const name = upper(parameter.name);
    declared.set(name, [...(declared.get(name) ?? []), parameter]);
  }
  const result = new Map<string, Parameter>();
  for (const [name, declarations] of declared) {
    if (declarations.length !== 1 || !/^[A-Z_][A-Z0-9_]*$/.test(name)) continue;
    const parameter = declarations[0];
    if (upper(parameter.direction) !== "IMPORTING") continue;
    const value = literal(parameter.defaultValue);
    if (value) result.set(name, { name, literal: value });
  }
  return result;
}

/** A whole guard must be exactly a scalar equality. OR/AND, NOT, parentheses,
 * method calls, component access, and extra statements do not partially match. */
function equality(text: string): Equality | undefined {
  const match = text.trim().match(/^(IF|ELSEIF)\s+([A-Z_][A-Z0-9_]*)\s*(?:=|\bEQ\b)\s*([\s\S]+)\.\s*$/i);
  if (!match) return undefined;
  const value = literal(match[3]);
  return value ? { keyword: upper(match[1]) as Equality["keyword"], parameter: upper(match[2]), literal: value } : undefined;
}

function knownDifferent(a: Literal, b: Literal): boolean {
  // A case-only distinction can depend on conversion into an unrecorded type
  // (for example a byte field); prefer a missed notice over guessing that type.
  return a.value !== b.value && a.value.toUpperCase() !== b.value.toUpperCase();
}

function location(source: SourceExcerptV1, occurrence?: CallSiteV1["occurrence"]): string {
  return occurrence
    ? `${source.path}:L${occurrence.line}:C${occurrence.column}`
    : `${source.path}:${source.span}`;
}

function nameOf(node: NodeV1 | undefined, fallback: string): string {
  return node ? `${node.owner ? `${node.owner}.` : ""}${node.name}` : fallback;
}

function contradictions(declared: Map<string, Parameter>, site: CallSiteV1): Contradiction[] {
  if (site.execution) return []; // registration/start conditions are not a synchronous execution proof
  const unchanged = new Set((site.unchangedParameters ?? []).map(upper));
  const found: Contradiction[] = [];
  const accept = (guard: Equality, control: ControlContextV1, negative: boolean, condition: string): void => {
    const parameter = declared.get(guard.parameter);
    if (!parameter || !unchanged.has(parameter.name)) return;
    const contradictory = negative
      ? parameter.literal.value === guard.literal.value
      : knownDifferent(parameter.literal, guard.literal);
    if (contradictory) found.push({ parameter, control, condition });
  };
  for (const control of site.controls ?? []) {
    const kind = upper(control.kind);
    if (kind === "IF" || kind === "ELSEIF") {
      const guard = equality(control.text);
      if (guard?.keyword === kind) accept(guard, control, false, summary(control.text));
    } else if (kind === "ELSE" && /^ELSE\s*\.$/i.test(control.text.trim())) {
      const earlier = control.priorBranches ?? [];
      if (earlier.length === 0) continue;
      const guards = earlier.map(branch => equality(branch.text));
      // Only a complete, simple IF / ELSEIF chain is eligible. This avoids
      // treating arbitrary earlier/nested control headers as ELSE's complement.
      if (guards.some((guard, index) => !guard || guard.keyword !== (index === 0 ? "IF" : "ELSEIF"))) continue;
      for (let index = 0; index < guards.length; index++) {
        accept(guards[index]!, control, true,
          `ELSE after ${summary(earlier[index].text)} (that earlier equality would be true)`);
      }
    }
  }
  return found;
}

/** Notices are attached to an explicit upstream/downstream site pairing.
 * Other occurrences on the same edges may be feasible; no message classifies
 * an entire edge, selected chain, or method as impossible. */
export function analyzeCallChain(graph: GraphV1, chain: EdgeV1[]): string[] {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const messages = new Set<string>();
  for (let index = 0; index + 1 < chain.length; index++) {
    const incoming = chain[index];
    const outgoing = chain[index + 1];
    if (incoming.relation !== "calls" || outgoing.relation !== "calls" || incoming.target !== outgoing.source) continue;
    const middle = nodes.get(incoming.target);
    const declared = parameters(middle);
    if (declared.size === 0) continue;
    for (const downstream of outgoing.callSites ?? []) {
      const candidates = contradictions(declared, downstream);
      if (candidates.length === 0) continue;
      for (const upstream of incoming.callSites ?? []) {
        // Even an empty argument map must have been explicitly recorded as
        // complete. Positional/dynamic/older metadata is never an omitted arg.
        if (upstream.execution || upstream.argumentsComplete !== true || !upstream.arguments) continue;
        const explicit = new Set(Object.keys(upstream.arguments).map(upper));
        for (const candidate of candidates) {
          if (explicit.has(candidate.parameter.name)) continue;
          messages.add(
            `possibly infeasible: ${candidate.parameter.name} omitted at ${location(upstream, upstream.occurrence)} → ` +
            `DEFAULT ${candidate.parameter.literal.raw} in ${nameOf(middle, incoming.target)} vs. ` +
            `${candidate.condition} at ${location(candidate.control)}; downstream site ${location(downstream, downstream.occurrence)} ` +
            `calling ${nameOf(nodes.get(outgoing.target), outgoing.target)}. Candidate site pairing only; other call sites may differ.`,
          );
        }
      }
    }
  }
  return [...messages].sort(compare);
}

/** Useful for an outgoing query without a known caller. This helper does not
 * claim that an argument actually was omitted; its premise stays in the text. */
export function analyzeDefaultConditions(graph: GraphV1, edge: EdgeV1): string[] {
  if (edge.relation !== "calls") return [];
  const source = graph.nodes.find(node => node.id === edge.source);
  const declared = parameters(source);
  const messages = new Set<string>();
  for (const site of edge.callSites ?? []) for (const candidate of contradictions(declared, site)) {
    messages.add(
      `default-conditioned notice: when ${candidate.parameter.name} is omitted on entry to ${nameOf(source, edge.source)}, ` +
      `DEFAULT ${candidate.parameter.literal.raw} conflicts with ${candidate.condition} at ${location(candidate.control)}; ` +
      `downstream site ${location(site, site.occurrence)} may be infeasible under that premise. Actual caller arguments are unknown.`,
    );
  }
  return [...messages].sort(compare);
}
