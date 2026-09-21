import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTraceEvidence, traceChainWarnings } from "../src/graph/trace-evidence.js";
import { evidenceId } from "../src/graph/evidence-id.js";
import type { CallSiteV1, EdgeV1, GraphV1, LocalAssignmentV1, NodeV1 } from "../src/graph/types.js";

test('earlier exits retain conditions and distinguish loop effects without promising execution', () => {
  const [a, b] = [node('A'), node('B')];
  const occurrence = site('b( ).');
  occurrence.earlierExits = [
    { path: a.path, span: 'L3-L3', text: 'RETURN.', kind: 'RETURN', effect: 'processing_block', controls: [{ path: a.path, span: 'L2-L2', text: 'IF invalid = abap_true.', kind: 'IF' }] },
    { path: a.path, span: 'L6-L6', text: 'EXIT.', kind: 'EXIT', effect: 'loop_exit' },
    { path: a.path, span: 'L8-L8', text: 'CHECK enabled = abap_true.', kind: 'CHECK', effect: 'loop_iteration' },
  ];
  const output = formatTraceEvidence(graph([a, b], [call(a, b, [occurrence])]), a, 'out', 1);
  assert.match(output, /Earlier exits \(not evaluated\)/);
  assert.match(output, /IF invalid = abap_true\./);
  assert.match(output, /EXIT leaves the innermost loop/);
  assert.match(output, /CHECK skips the current loop iteration.*condition is false/);
  assert.doesNotMatch(output, /No enclosing control headers recorded/);
});

function node(name: string, path = `${name.toLowerCase()}.clas.abap`, kind: NodeV1["kind"] = "method"): NodeV1 {
  return { id: kind === "file" ? path : `${path}#ZCL_TEST.${name}`, name, owner: kind === "method" ? "ZCL_TEST" : undefined,
    kind, path, span: "L1-L20", signature: null, exported: true, origin: "ast", body_hash: name,
    summary_state: "pending", summary: null, crux: null };
}
const site = (text: string, line = 10): CallSiteV1 => ({ path: "caller.clas.abap", span: `L${line}-L${line}`, text });
const call = (a: NodeV1, b: NodeV1, sites?: CallSiteV1[]): EdgeV1 => ({ source: a.id, target: b.id, relation: "calls", confidence: "extracted", ...(sites ? { callSites: sites } : {}) });
const graph = (nodes: NodeV1[], edges: EdgeV1[]): GraphV1 => ({ nodes, edges, meta: { version: 1, nodeCount: nodes.length, edgeCount: edges.length, languages: ["abap"] } });

test('exit filters preserve known empty versus unavailable evidence and count only nonempty sections', () => {
  const [empty, unknown, guarded, target] = [node('EMPTY'), node('UNKNOWN'), node('GUARDED'), node('TARGET')];
  const g = graph([empty, unknown, guarded, target], [
    call(empty, target, [{ ...site('target( ).'), earlierExits: [] }]),
    call(unknown, target, [site('target( ).')]),
    call(guarded, target, [{ ...site('target( ).'), earlierExits: [{ path: guarded.path, span: 'L2-L2', text: 'RETURN.', kind: 'RETURN', effect: 'processing_block' }] }]),
  ]);
  const output = formatTraceEvidence(g, target, 'in', 1, { exitSources: [] });
  assert.equal(output.split('no earlier RETURN/EXIT/CHECK recorded').length - 1, 1);
  assert.equal(output.split('Earlier exits: evidence unavailable').length - 1, 1);
  assert.equal(output.split('Earlier exits omitted by exit_sources filter').length - 1, 1);
  assert.match(output, /1 call-site exit section\(s\) by exit_sources/);
  assert.doesNotMatch(output, /Earlier exit source:/);
  const unfiltered = formatTraceEvidence(g, target, 'in', 1);
  assert.match(unfiltered, /0 call-site exit section\(s\) by exit_sources/);
  assert.match(unfiltered, /Earlier exit source:/);
});

test('stable source ids survive target and exit filters even when short labels are renumbered', () => {
  const [a, b, c] = [node('A'), node('B'), node('C')];
  b.declaration = { path: b.path, span: 'L1-L1', text: 'METHODS b.' };
  const assignment = { path: a.path, span: 'L4-L4', text: 'DATA(value) = 1.', variable: 'VALUE' };
  const aSite: CallSiteV1 = { ...site('b( value = value ).'), occurrence: { line: 10, column: 3 }, localAssignments: [assignment],
    earlierExits: [{ path: a.path, span: 'L2-L2', text: 'RETURN.', kind: 'RETURN', effect: 'processing_block' }] };
  const bSite: CallSiteV1 = { ...site('c( ).'), earlierExits: [{ path: b.path, span: 'L3-L3', text: 'RETURN.', kind: 'RETURN', effect: 'processing_block' }] };
  const g = graph([a, b, c], [call(a, b, [aSite]), call(b, c, [bSite])]);
  const full = formatTraceEvidence(g, c, 'in', 2);
  const selected = formatTraceEvidence(g, c, 'in', 2, { evidenceTargets: ['A'] });
  const filtered = formatTraceEvidence(g, c, 'in', 2, { exitSources: ['A'] });
  const ids = [evidenceId('call', aSite, aSite.occurrence), evidenceId('exit', aSite.earlierExits![0]), evidenceId('assignment', assignment), evidenceId('declaration', b.declaration)];
  for (const output of [full, selected, filtered]) for (const id of ids) assert.ok(output.includes(`Stable evidence ID: ${id}`), id);
  assert.match(full, /\[E2\] Earlier exit/);
  assert.doesNotMatch(filtered, /\[E2\] Earlier exit/);
  assert.match(full, /Short labels .* are local to this response/);
});

test('selected incoming chains carry site-specific default warnings even beyond evidence display limits', () => {
  const [a, b, c, other] = [node('BUILD_GENERATE'), node('EVALUATE'), node('RUN_SIMULATION'), node('BUILD_TIMEEVAL')];
  b.abapParameters = [{ name: 'IV_TEST', direction: 'IMPORTING', defaultValue: 'abap_false' }];
  const downstream = { ...site('run_simulation( ).'), unchangedParameters: ['IV_TEST'],
    controls: [{ kind: 'IF', path: b.path, span: 'L8-L8', text: 'IF iv_test = abap_true.' }] };
  const g = graph([a, b, c, other], [call(a, b, [{ ...site('evaluate( ).'), arguments: {}, argumentsComplete: true }]),
    call(other, b, [{ ...site('evaluate( iv_test = lv_test ).'), arguments: { IV_TEST: 'lv_test' }, argumentsComplete: true }]), call(b, c, [downstream])]);
  const notices = traceChainWarnings(g, c, 'in', 2);
  assert.equal(notices.get(a.id)?.length, 1);
  assert.match(notices.get(a.id)![0], /possibly infeasible: IV_TEST omitted.*DEFAULT abap_false.*IF iv_test = abap_true/);
  assert.deepEqual(notices.get(other.id), []);
  assert.deepEqual(notices.get(b.id), []);
  assert.match(formatTraceEvidence(g, c, 'in', 2), /\[possibly infeasible:/);
  assert.doesNotMatch(formatTraceEvidence(g, c, 'in', 2, { maxTargets: 1 }), /\[possibly infeasible:/);
});

test('outgoing assumption stays in detailed evidence and never marks a compact edge', () => {
  const [a, b] = [node('EVALUATE'), node('RUN_SIMULATION')];
  a.abapParameters = [{ name: 'IV_TEST', direction: 'IMPORTING', defaultValue: 'abap_false' }];
  const g = graph([a, b], [call(a, b, [{ ...site('run_simulation( ).'), unchangedParameters: ['IV_TEST'],
    controls: [{ kind: 'IF', path: a.path, span: 'L8-L8', text: 'IF iv_test = abap_true.' }] }])]);
  assert.deepEqual(traceChainWarnings(g, a, 'out', 1).get(b.id), []);
  const notice = formatTraceEvidence(g, a, 'out', 1);
  assert.match(notice, /when IV_TEST is omitted/);
  assert.match(notice, /Actual caller arguments are unknown/);
  assert.doesNotMatch(notice, /possibly infeasible: IV_TEST omitted/);
});

test('local assignments retain their guards and are shared without claiming a propagated value', () => {
  const [a, b, c] = [node('A'), node('B'), node('C')];
  const assignment = { path: a.path, span: 'L4-L4', text: 'lv_test = flag( iv_default = abap_false ).', variable: 'LV_TEST',
    controls: [{ kind: 'IF', path: a.path, span: 'L3-L3', text: 'IF changed = abap_true.' }] };
  const first = { ...site('b( iv_test = lv_test ).', 10), localAssignments: [assignment] };
  const second = { ...site('c( iv_test = lv_test ).', 12), localAssignments: [assignment] };
  const output = formatTraceEvidence(graph([a, b, c], [call(a, b, [first]), call(a, c, [second])]), a, 'out', 1);
  assert.equal(output.split(assignment.text).length - 1, 1);
  assert.equal(output.split('LV_TEST [A1]').length - 1, 2);
  assert.match(output, /Last preceding direct assignment \(not evaluated\): LV_TEST/);
  assert.match(output, /Local assignment control IF \(not evaluated\)/);
  assert.match(output, /Source order only; conditional writes and loops may produce different runtime values/);
});

test('conditional assignments show earlier initializers as candidates, not proven fallback values', () => {
  const [a, b] = [node('A'), node('B')];
  const assignment: LocalAssignmentV1 = { path: a.path, span: 'L9-L9', text: 'lv_schema = to_upper( iv_schema ).', variable: 'LV_SCHEMA',
    controls: [{ kind: 'IF', path: a.path, span: 'L8-L8', text: 'IF iv_schema IS NOT INITIAL.' }],
    priorAssignments: [{ path: a.path, span: 'L2-L2', text: 'DATA(lv_schema) = c_default_schema.', variable: 'LV_SCHEMA' }] };
  const output = formatTraceEvidence(graph([a, b], [call(a, b, [{ ...site('b( schema = lv_schema ).'), localAssignments: [assignment] }])]), a, 'out', 1);
  assert.match(output, /IF iv_schema IS NOT INITIAL/);
  assert.match(output, /Local assignment source: a.clas.abap:L2-L2/);
  assert.match(output, /Earlier direct assignment candidate \(not evaluated\): LV_SCHEMA/);
  assert.match(output, /not a proven fallback value or complete branch coverage/);
});

test('call outputs show the actual output direction without implying successful assignment', () => {
  const [a, b] = [node('A'), node('B')];
  const assignment: LocalAssignmentV1 = { path: a.path, span: 'L4-L4', text: 'parse( IMPORTING ev = lv_pernr ).', variable: 'LV_PERNR', kind: 'call_output', output: { direction: 'IMPORTING', parameter: 'EV' } };
  const output = formatTraceEvidence(graph([a, b], [call(a, b, [{ ...site('b( pernr = lv_pernr ).'), localAssignments: [assignment] }])]), a, 'out', 1);
  assert.match(output, /Assigned via call output \(not evaluated\): LV_PERNR; IMPORTING EV/);
  assert.match(output, /Call success and output value are unknown/);
  assert.doesNotMatch(output, /Last preceding direct assignment \(not evaluated\): LV_PERNR/);
});

test('target selection keeps each intermediate hop, counts filtered targets, and runs before the cap', () => {
  const [a, b, c, d] = [node('A'), node('B'), node('C'), node('D')];
  const g = graph([a, b, c, d], [call(a, b, [site('b( ).')]), call(b, c, [site('c( ).')]), call(a, d, [site('d( ).')])]);
  const output = formatTraceEvidence(g, a, 'out', 2, { evidenceTargets: ['ZCL_TEST=>C'], maxTargets: 1 });
  assert.match(output, /ZCL_TEST.A --calls \[S1\]--> ZCL_TEST.B --calls \[S2\]--> ZCL_TEST.C/);
  assert.match(output, /b\( \)\./);
  assert.match(output, /c\( \)\./);
  assert.doesNotMatch(output, /d\( \)\./);
  assert.match(output, /2 target\(s\) by evidence_targets/);
  assert.match(output, /0 target\(s\) by target limit/);
  assert.doesNotMatch(formatTraceEvidence(g, a, 'out', 2, { evidenceTargets: [] }), /Selected chain T|Call site 1/);
});

test('exit selection changes only earlier exits, never call sources or selected chains', () => {
  const [a, b, c] = [node('A'), node('B'), node('C')];
  const aSite: CallSiteV1 = { ...site('b( ).'), earlierExits: [{ path: a.path, span: 'L2-L2', text: 'RETURN.', kind: 'RETURN', effect: 'processing_block' }] };
  const bSite: CallSiteV1 = { ...site('c( ).'), earlierExits: [{ path: b.path, span: 'L3-L3', text: 'CHECK ready = abap_true.', kind: 'CHECK', effect: 'processing_block' }] };
  const g = graph([a, b, c], [call(a, b, [aSite]), call(b, c, [bSite])]);
  const output = formatTraceEvidence(g, c, 'in', 2, { exitSources: ['ZCL_TEST=>B'] });
  assert.match(output, /b\( \)\./);
  assert.match(output, /c\( \)\./);
  assert.match(output, /CHECK ready = abap_true/);
  assert.doesNotMatch(output, /Earlier exit source: a.clas.abap/);
  assert.match(output, /1 call-site exit section\(s\) by exit_sources/);
  const none = formatTraceEvidence(g, c, 'in', 2, { exitSources: [] });
  assert.doesNotMatch(none, /Earlier exit source:/);
  assert.match(none, /2 call-site exit section\(s\) by exit_sources/);
  assert.throws(() => formatTraceEvidence(g, c, 'in', 2, { exitSources: ['C'] }), /none are available in this trace/);
});

test("trace evidence prints every multihop link, controls, earlier branches and original defaults once", () => {
  const [a, b, c] = [node("A"), node("B"), node("C")];
  b.declaration = { path: "b.clas.abap", span: "L2-L3", text: "METHODS b IMPORTING enabled TYPE abap_bool DEFAULT abap_false." };
  const occurrence = site("b( enabled = abap_true ).");
  occurrence.controls = [{ kind: "ELSEIF", path: a.path, span: "L8-L8", text: "ELSEIF second = abap_true.", priorBranches: [{ path: a.path, span: "L6-L6", text: "IF first = abap_true." }] }];
  const g = graph([a, b, c], [call(a, b, [occurrence]), call(b, c, [site("c( ).", 12)])]);
  const output = formatTraceEvidence(g, a, "out", 2);
  assert.match(output, /Selected chain T2 \(2 hops/);
  assert.match(output, /ZCL_TEST\.A --calls \[S1\]--> ZCL_TEST\.B.*--calls \[S2\]--> ZCL_TEST\.C/);
  assert.equal(output.split("b( enabled = abap_true ).").length - 1, 1);
  assert.match(output, /c\( \)\./);
  assert.match(output, /Earlier branch header \(not evaluated\): a\.clas\.abap:L6-L6/);
  assert.match(output, /ELSEIF second = abap_true\./);
  assert.equal(output.split("DEFAULT abap_false").length - 1, 1);
  assert.match(output, /do not evaluate runtime conditions, propagate arguments, or prove execution/);
});

test("incoming evidence presents actual caller-to-seed order", () => {
  const [a, b, c] = [node("A"), node("B"), node("C")];
  const output = formatTraceEvidence(graph([a, b, c], [call(a, b, [site("b( ).")]), call(b, c, [site("c( ).")])]), c, "in", 3);
  const longChain = output.split("\n").find(line => line.startsWith("ZCL_TEST.A") && line.includes(" --calls "))!;
  assert.ok(longChain.indexOf("ZCL_TEST.A") < longChain.indexOf("ZCL_TEST.B"));
  assert.ok(longChain.indexOf("ZCL_TEST.B") < longChain.indexOf("ZCL_TEST.C"));
  assert.match(output, /b\( \)\./);
  assert.match(output, /c\( \)\./);
});

test("outgoing evidence includes the queried symbol's own parameter defaults once", () => {
  const [a, b] = [node("EVALUATE"), node("SUBMIT")];
  a.declaration = { path: a.path, span: "L2-L2", text: "METHODS evaluate IMPORTING iv_test TYPE abap_bool DEFAULT abap_false." };
  const output = formatTraceEvidence(graph([a, b], [call(a, b)]), a, "out", 1);
  assert.match(output, /Queried symbol declaration/);
  assert.equal(output.split("iv_test TYPE abap_bool DEFAULT abap_false").length - 1, 1);
});

test("diamonds select one deterministic shortest chain and disclose alternatives", () => {
  const [a, b, c, d] = [node("A"), node("B"), node("C"), node("D")];
  const edges = [call(a, c), call(c, d), call(a, b), call(b, d)];
  const original = formatTraceEvidence(graph([a, b, c, d], edges), a, "out", Infinity);
  const reordered = formatTraceEvidence(graph([d, c, b, a], [...edges].reverse()), a, "out", Infinity);
  assert.equal(original, reordered);
  assert.match(original, /alternative paths are not enumerated/);
  const dChain = original.split("\n").find(line => line.startsWith("ZCL_TEST.A") && line.includes("ZCL_TEST.D"))!;
  assert.match(dChain, /ZCL_TEST.B/);
  assert.doesNotMatch(dChain, /ZCL_TEST.C/);
  assert.equal(original.split("Selected chain ").length - 1, 3);
});

test("cycles terminate at infinite depth; single-hop self-recursion remains visible", () => {
  const [a, b] = [node("A"), node("B")];
  const g = graph([a, b], [call(a, a, [site("a( ).")]), call(a, b), call(b, a)]);
  const recursive = formatTraceEvidence(g, a, "out", 1);
  assert.match(recursive, /a\( \)\./);
  assert.match(recursive, /Reached targets: 2/);
  const deep = formatTraceEvidence(g, a, "out", Infinity);
  assert.match(deep, /Reached targets: 1/);
  assert.equal(deep.split("Selected chain ").length - 1, 1);
});

test("file seed expansion matches edgeWalk depth rules and excludes internal seeds", () => {
  const file = node("owner.clas.abap", "owner.clas.abap", "file");
  const a = node("A", file.path);
  const b = node("B", file.path);
  const outside = node("OUTSIDE");
  const g = graph([file, a, b, outside], [call(a, b), call(b, outside)]);
  assert.match(formatTraceEvidence(g, file, "out", 1), /Reached targets: 0/);
  const deep = formatTraceEvidence(g, file, "out", 2);
  assert.match(deep, /Reached targets: 1/);
  assert.match(deep, /ZCL_TEST.B.*--calls.*ZCL_TEST.OUTSIDE/);
  assert.doesNotMatch(deep, /ZCL_TEST.A.*--calls/);
});

test("older graph evidence is labeled unavailable instead of synthesized from signatures", () => {
  const [a, b] = [node("A"), node("B")];
  b.signature = "METHODS fabricated DEFAULT 42.";
  b.body_text = "fabricated call body";
  const output = formatTraceEvidence(graph([a, b], [call(a, b)]), a, "out", 1);
  assert.match(output, /Call-site evidence unavailable/);
  assert.match(output, /Callee declaration evidence unavailable/);
  assert.doesNotMatch(output, /fabricated/);
});

test("repeated call sites survive edge deduplication and respect the per-edge cap", () => {
  const [a, b] = [node("A"), node("B")];
  const first = site("b( first = 1 ).", 2);
  const second = site("b( second = 2 ).", 4);
  const third = site("b( third = 3 ).", 6);
  const g = graph([a, b], [call(a, b, [third, first]), call(a, b, [second, first])]);
  const output = formatTraceEvidence(g, a, "out", 1, { maxSites: 2 });
  assert.match(output, /showing 2 of 3/);
  assert.equal(output.split("b( first = 1 ).").length - 1, 1);
  assert.match(output, /b\( second = 2 \)\./);
  assert.doesNotMatch(output, /b\( third = 3 \)\./);
  assert.match(output, /1 call site\(s\) by per-step site limit/);
  assert.equal(output, formatTraceEvidence(graph([b, a], [...g.edges].reverse()), a, "out", 1, { maxSites: 2 }));
});

test("identical excerpts for separate invocations on the same line remain distinct", () => {
  const [a, b] = [node("A"), node("B")];
  const statement = site("consume( b( ) + b( ) ).", 10);
  const first = { ...statement, occurrence: { line: 10, column: 10 } };
  const second = { ...statement, occurrence: { line: 10, column: 18 } };
  const output = formatTraceEvidence(graph([a, b], [call(a, b, [second, first])]), a, "out", 1);
  assert.match(output, /showing 2 of 2/);
  assert.match(output, /Invocation 1: caller\.clas\.abap:L10:C10/);
  assert.match(output, /Invocation 2: caller\.clas\.abap:L10:C18/);
});

test("target and character caps report omitted evidence without cutting source delimiters", () => {
  const [a, b, c] = [node("A"), node("B"), node("C")];
  const g = graph([a, b, c], [call(a, b, [site("b( ).\n" + "x".repeat(3000))]), call(a, c)]);
  const limited = formatTraceEvidence(g, a, "out", 1, { maxTargets: 1 });
  assert.match(limited, /1 target\(s\) by target limit/);
  const bounded = formatTraceEvidence(g, a, "out", 1, { maxChars: 1600 });
  assert.ok(bounded.length <= 1600);
  assert.match(bounded, /[1-9]\d* step detail\(s\).*by character limit/);
  assert.equal((bounded.match(/^```abap$/gm) ?? []).length, (bounded.match(/^```$/gm) ?? []).length);
  for (const maxChars of [0, 1, 30, 100, 700]) assert.ok(formatTraceEvidence(g, a, "out", 1, { maxChars }).length <= maxChars);
});

test("non-call walk relations remain structural and excerpt fences cannot be closed by source", () => {
  const [a, b, c] = [node("A"), node("B"), node("C")];
  const reference: EdgeV1 = { source: a.id, target: c.id, relation: "references", confidence: "extracted" };
  const output = formatTraceEvidence(graph([a, b, c], [call(a, b, [site("b( value = '```' ).")]), reference]), a, "out", 1);
  assert.match(output, /--references/);
  assert.match(output, /Structural relationship; call-site evidence does not apply/);
  assert.match(output, /````abap\nb\( value = '```' \)\.\n````/);
});
