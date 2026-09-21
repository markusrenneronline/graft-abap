import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeCallChain, analyzeDefaultConditions } from "../src/graph/abap-feasibility.js";
import type { CallSiteV1, ControlContextV1, EdgeV1, GraphV1, NodeV1 } from "../src/graph/types.js";

function node(name: string): NodeV1 {
  return { id: `zcl_test.clas.abap#ZCL_TEST.${name}`, name, owner: "ZCL_TEST", path: "zcl_test.clas.abap", span: "L1-L100",
    kind: "method", signature: null, exported: true, origin: "ast", body_hash: name, summary_state: "pending", summary: null, crux: null };
}

const control = (text = "IF iv_test = abap_true.", kind = "IF"): ControlContextV1 => ({ path: "evaluate.abap", span: "L145-L145", text, kind });
const site = (path: string, line: number, text: string): CallSiteV1 => ({ path, span: `L${line}-L${line}`, text, occurrence: { line, column: 5 } });

function fixture() {
  const a = node("BUILD_GENERATE");
  const b = node("EVALUATE");
  const c = node("RUN_SIMULATION");
  b.abapParameters = [{ name: "IV_TEST", direction: "IMPORTING", defaultValue: "abap_false" }];
  const upstream: CallSiteV1 = { ...site("generate.abap", 50, "evaluate( iv_pernr = pernr )."), arguments: { IV_PERNR: "pernr" }, argumentsComplete: true };
  const downstream: CallSiteV1 = { ...site("evaluate.abap", 146, "run_simulation( )."), controls: [control()], unchangedParameters: ["IV_TEST"] };
  const incoming: EdgeV1 = { source: a.id, target: b.id, relation: "calls", confidence: "extracted", callSites: [upstream] };
  const outgoing: EdgeV1 = { source: b.id, target: c.id, relation: "calls", confidence: "extracted", callSites: [downstream] };
  const graph: GraphV1 = { nodes: [a, b, c], edges: [incoming, outgoing], meta: { version: 1, nodeCount: 3, edgeCount: 2, languages: ["abap"] } };
  return { graph, a, b, c, upstream, downstream, incoming, outgoing, chain: [incoming, outgoing] };
}

test("omitted false default versus true guard produces a site-specific possibility notice", () => {
  const f = fixture();
  const messages = analyzeCallChain(f.graph, f.chain);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /possibly infeasible: IV_TEST omitted at generate\.abap:L50:C5 → DEFAULT abap_false/);
  assert.match(messages[0], /IF iv_test = abap_true\./);
  assert.match(messages[0], /downstream site evaluate\.abap:L146:C5 calling ZCL_TEST.RUN_SIMULATION/);
  assert.match(messages[0], /Candidate site pairing only; other call sites may differ/);
});

test("explicit arguments, including nested expressions, are never propagated or called omitted", () => {
  for (const actual of ["abap_true", "abap_false", "xsdbool( nested( iv_test = abap_true ) )", "lv_unknown"]) {
    const f = fixture();
    f.upstream.arguments = { iv_test: actual };
    assert.deepEqual(analyzeCallChain(f.graph, f.chain), []);
  }
});

test("positional, incomplete, and absent argument metadata remain unknown", () => {
  for (const mode of ["positional", "incomplete", "absent", "missing-map"]) {
    const f = fixture();
    if (mode === "positional") { f.upstream.text = "evaluate( abap_true )."; f.upstream.argumentsComplete = false; }
    if (mode === "incomplete") f.upstream.argumentsComplete = false;
    if (mode === "absent") { delete f.upstream.argumentsComplete; delete f.upstream.arguments; }
    if (mode === "missing-map") delete f.upstream.arguments;
    assert.deepEqual(analyzeCallChain(f.graph, f.chain), [], mode);
  }
});

test("unknown or possibly modified parameters suppress notices", () => {
  for (const unchanged of [undefined, [], ["IV_OTHER"]]) {
    const f = fixture();
    f.downstream.unchangedParameters = unchanged;
    assert.deepEqual(analyzeCallChain(f.graph, f.chain), []);
  }
});

test("compound, negated, dynamic, and accessor guards are not partially evaluated", () => {
  for (const guard of [
    "IF iv_test = abap_true OR fallback = abap_true.",
    "IF iv_test = abap_true AND ready = abap_true.",
    "IF NOT iv_test = abap_true.",
    "IF ( iv_test = abap_true ).",
    "IF helper( iv_test ) = abap_true.",
    "IF me->iv_test = abap_true.",
    "IF iv_test = c_true.",
    "IF iv_test <> abap_true.",
  ]) {
    const f = fixture();
    f.downstream.controls = [control(guard)];
    assert.deepEqual(analyzeCallChain(f.graph, f.chain), [], guard);
  }
});

test("symbolic, absent, numeric, and longer defaults stay unknown without type metadata", () => {
  for (const defaultValue of [undefined, "c_default_test", "get_default( )", "'AB'", "'0'", "0"]) {
    const f = fixture();
    f.b.abapParameters![0].defaultValue = defaultValue;
    assert.deepEqual(analyzeCallChain(f.graph, f.chain), [], String(defaultValue));
  }
});

test("boolean aliases and simple character literals compare conservatively", () => {
  const f = fixture();
  f.b.abapParameters![0].defaultValue = "' '";
  f.downstream.controls = [control("IF iv_test EQ 'X'.")];
  assert.equal(analyzeCallChain(f.graph, f.chain).length, 1);
  f.b.abapParameters![0].defaultValue = "'X'";
  assert.deepEqual(analyzeCallChain(f.graph, f.chain), []);
  f.b.abapParameters![0].defaultValue = "'A'";
  f.downstream.controls = [control("IF iv_test = 'B'.")];
  assert.equal(analyzeCallChain(f.graph, f.chain).length, 1);
  f.downstream.controls = [control("IF iv_test = 'a'.")];
  assert.deepEqual(analyzeCallChain(f.graph, f.chain), []);
});

test("simple ELSEIF equality is supported; ELSE requires a complete simple preceding branch chain", () => {
  const f = fixture();
  f.downstream.controls = [control("ELSEIF iv_test = abap_true.", "ELSEIF")];
  assert.equal(analyzeCallChain(f.graph, f.chain).length, 1);
  f.b.abapParameters![0].defaultValue = "abap_true";
  const branch = { ...control("ELSE.", "ELSE"), priorBranches: [control()] };
  f.downstream.controls = [branch];
  assert.match(analyzeCallChain(f.graph, f.chain)[0], /ELSE after IF iv_test = abap_true/);
  f.b.abapParameters![0].defaultValue = "abap_false";
  assert.deepEqual(analyzeCallChain(f.graph, f.chain), []);
  f.b.abapParameters![0].defaultValue = "abap_true";
  branch.priorBranches = [control("IF iv_test = abap_true OR other = abap_true.")];
  assert.deepEqual(analyzeCallChain(f.graph, f.chain), []);
  branch.priorBranches = [control("ELSEIF iv_test = abap_true.", "ELSEIF")];
  assert.deepEqual(analyzeCallChain(f.graph, f.chain), []);
});

test("alternate call sites are identified separately rather than classifying the whole chain", () => {
  const f = fixture();
  f.incoming.callSites!.push({ ...site("explicit.abap", 80, "evaluate( iv_test = abap_true )."), arguments: { IV_TEST: "abap_true" }, argumentsComplete: true });
  f.outgoing.callSites!.push({ ...site("evaluate.abap", 180, "run_simulation( )."), controls: [], unchangedParameters: ["IV_TEST"] });
  const messages = analyzeCallChain(f.graph, f.chain);
  assert.equal(messages.length, 1);
  assert.doesNotMatch(messages[0], /explicit\.abap|L180/);
  assert.match(messages[0], /other call sites may differ/);
  f.incoming.callSites!.reverse();
  f.outgoing.callSites!.reverse();
  f.graph.nodes.reverse();
  assert.deepEqual(analyzeCallChain(f.graph, f.chain), messages);
});

test("nested actual parameter text cannot overwrite the recorded direct argument map", () => {
  const f = fixture();
  f.upstream.text = "evaluate( iv_pernr = helper( iv_test = abap_true ) ).";
  f.upstream.arguments = { IV_PERNR: "helper( iv_test = abap_true )" };
  assert.equal(analyzeCallChain(f.graph, f.chain).length, 1);
  f.upstream.arguments = { IV_TEST: "helper( iv_test = abap_true )" };
  assert.deepEqual(analyzeCallChain(f.graph, f.chain), []);
});

test("only adjacent calls with unambiguous IMPORTING parameters participate", () => {
  for (const mode of ["single", "unconnected", "references", "changing", "duplicate", "old"]) {
    const f = fixture();
    if (mode === "single") f.chain.pop();
    if (mode === "unconnected") f.outgoing.source = "elsewhere";
    if (mode === "references") f.incoming.relation = "references";
    if (mode === "changing") f.b.abapParameters![0].direction = "CHANGING";
    if (mode === "duplicate") f.b.abapParameters!.push({ ...f.b.abapParameters![0] });
    if (mode === "old") delete f.b.abapParameters;
    assert.deepEqual(analyzeCallChain(f.graph, f.chain), [], mode);
  }
});

test("outgoing default notices retain the omitted-argument premise and unknown caller explicitly", () => {
  const f = fixture();
  const notices = analyzeDefaultConditions(f.graph, f.outgoing);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /when IV_TEST is omitted on entry/);
  assert.match(notices[0], /Actual caller arguments are unknown/);
  assert.doesNotMatch(notices[0], /IV_TEST omitted at generate/);
  f.downstream.unchangedParameters = [];
  assert.deepEqual(analyzeDefaultConditions(f.graph, f.outgoing), []);
});
