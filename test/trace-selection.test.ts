import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEvidenceSelectors, selectEvidenceIds } from "../src/graph/trace-selection.js";
import { resolveSymbol } from "../src/graph/traverse.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";

function node(id: string, owner: string, name: string): NodeV1 {
  return { id, owner, name, kind: "method", path: id.split("#")[0], span: "L1-L2", signature: null, exported: true, origin: "ast", body_hash: id, summary_state: "pending", summary: null, crux: null };
}
const generate = node("src/http.clas.abap#ZCL_HTTP.BUILD_GENERATE", "ZCL_HTTP", "BUILD_GENERATE");
const evaluate = node("src/eval.clas.abap#ZCL_EVAL.EVALUATE", "ZCL_EVAL", "EVALUATE");
const firstRun = node("src/first.clas.abap#LCL_WORKER.RUN", "LCL_WORKER", "RUN");
const secondRun = node("src/second.clas.abap#LCL_WORKER.RUN", "LCL_WORKER", "RUN");
const unreachable = node("src/unused.clas.abap#ZCL_UNUSED.STOP", "ZCL_UNUSED", "STOP");
const graph: GraphV1 = {
  meta: { version: 1, nodeCount: 5, edgeCount: 0, languages: ["abap"] },
  nodes: [generate, evaluate, firstRun, secondRun, unreachable], edges: [],
};
const available = [generate.id, evaluate.id, firstRun.id, secondRun.id];

test("evidence selectors distinguish omitted from explicit empty selection", () => {
  assert.equal(parseEvidenceSelectors(undefined, "evidence_targets"), undefined);
  assert.deepEqual(parseEvidenceSelectors([], "evidence_targets"), []);
  assert.equal(selectEvidenceIds(graph, available, undefined, "evidence_targets"), undefined);
  assert.deepEqual(selectEvidenceIds(graph, available, [], "evidence_targets"), new Set());
  assert.deepEqual(selectEvidenceIds(graph, [], [], "exit_sources"), new Set());
});

test("evidence selector parser rejects wrong container and item types", () => {
  for (const value of [null, false, 0, "RUN", {}, new Set(["RUN"])]) {
    assert.throws(() => parseEvidenceSelectors(value, "evidence_targets"), /evidence_targets must be an array/);
  }
  for (const value of [[undefined], [null], [1], [true], [{}], [[]], Array(1)]) {
    assert.throws(() => parseEvidenceSelectors(value, "exit_sources"), /exit_sources\[0\] must be a nonempty string/);
  }
});

test("evidence selector parser trims but rejects empty or whitespace-only entries", () => {
  assert.deepEqual(parseEvidenceSelectors(["  ZCL_HTTP=>BUILD_GENERATE  ", "\tEVALUATE\n"], "evidence_targets"), ["ZCL_HTTP=>BUILD_GENERATE", "EVALUATE"]);
  for (const value of [[""], [" "], ["\t\r\n"], ["RUN", " "]]) {
    assert.throws(() => parseEvidenceSelectors(value, "exit_sources"), /whitespace-only selectors are not allowed/);
  }
});

test("evidence selector parser enforces its limit before deduplication", () => {
  assert.deepEqual(parseEvidenceSelectors(Array(50).fill("RUN"), "evidence_targets"), ["RUN"]);
  assert.throws(() => parseEvidenceSelectors(Array(51).fill("RUN"), "evidence_targets"), /at most 50/);
});

test("evidence selectors deduplicate case-insensitively without mutating caller arrays", () => {
  const selectors = [" RUN ", "run", "Run", "EVALUATE"];
  const snapshot = [...selectors];
  assert.deepEqual(parseEvidenceSelectors(selectors, "evidence_targets"), ["RUN", "EVALUATE"]);
  assert.deepEqual(selectEvidenceIds(graph, available, selectors, "evidence_targets"), new Set([firstRun.id, secondRun.id, evaluate.id]));
  assert.deepEqual(selectors, snapshot);
  assert.deepEqual(available, [generate.id, evaluate.id, firstRun.id, secondRun.id]);
});

test("evidence selectors support ABAP class-qualified arrows through the shared resolver", () => {
  assert.deepEqual(selectEvidenceIds(graph, available, ["zcl_http=>build_generate", "ZCL_EVAL->EVALUATE"], "evidence_targets"), new Set([generate.id, evaluate.id]));
});

test("evidence selectors preserve all available matches and intersect unavailable matches", () => {
  assert.deepEqual(selectEvidenceIds(graph, available, ["LCL_WORKER.RUN"], "exit_sources"), new Set([firstRun.id, secondRun.id]));
  assert.deepEqual(selectEvidenceIds(graph, [firstRun.id], ["RUN"], "exit_sources"), new Set([firstRun.id]));
});

test("evidence selectors reject unknown symbols with their option name", () => {
  assert.throws(() => selectEvidenceIds(graph, available, ["DOES_NOT_EXIST"], "evidence_targets"), /evidence_targets selector "DOES_NOT_EXIST" does not match any graph symbol/);
});

test("evidence selectors reject graph symbols unavailable in the current trace", () => {
  assert.throws(() => selectEvidenceIds(graph, available, ["ZCL_UNUSED.STOP"], "exit_sources"), /exit_sources selector "ZCL_UNUSED.STOP" matches graph symbols, but none are available in this trace/);
  assert.throws(() => selectEvidenceIds(graph, [], ["RUN"], "evidence_targets"), /none are available in this trace/);
  assert.throws(() => selectEvidenceIds(graph, available, ["RUN", "STOP"], "evidence_targets"), /"STOP".*none are available/);
});

test("evidence selectors resolve full path ids exactly without broadening same-name methods", () => {
  assert.deepEqual(selectEvidenceIds(graph, available, [secondRun.id.toLowerCase()], "evidence_targets"), new Set([secondRun.id]));
  assert.throws(() => selectEvidenceIds(graph, [firstRun.id], [secondRun.id], "exit_sources"), /none are available in this trace/);
});

test("evidence selector name resolution stays identical to the shared resolver", () => {
  const selector = "SomePackage.RUN";
  const sharedMatches = resolveSymbol(graph, selector).map(node => node.id);
  // A qualified ABAP owner is exact: an unknown owner must not silently fall
  // back to every same-named method. Selectors must preserve that rule too.
  assert.deepEqual(sharedMatches, []);
  assert.throws(() => selectEvidenceIds(graph, available, [selector], "evidence_targets"), /does not match any graph symbol/);
  assert.deepEqual(selectEvidenceIds(graph, available, ['RUN'], 'evidence_targets'),
    new Set(resolveSymbol(graph, 'RUN').map(node => node.id)));
});
