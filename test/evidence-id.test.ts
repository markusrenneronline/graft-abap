import { test } from "node:test";
import assert from "node:assert/strict";
import { evidenceId } from "../src/graph/evidence-id.js";
import type { SourceExcerptV1 } from "../src/graph/types.js";

const exit: SourceExcerptV1 = { path: "src/service.clas.abap", span: "L840-L840", text: "RETURN." };

test("evidence ids use a compact kind-prefixed source identity hash", () => {
  assert.match(evidenceId("exit", exit), /^exit:[0-9a-f]{16}$/);
});

test("evidence ids stay stable after query reordering, filtering and display relabeling", () => {
  const entries = [exit, { ...exit, span: "L845-L845" }, { ...exit, span: "L850-L850" }];
  const originalIds = new Map(entries.map(excerpt => [excerpt.span, evidenceId("exit", excerpt)]));
  const displayed = [entries[2], entries[0]].map((excerpt, index) => ({ ...excerpt, label: `E${index + 1}`, filter: "selected" }));
  for (const excerpt of displayed) assert.equal(evidenceId("exit", excerpt), originalIds.get(excerpt.span));
  const decorated = { ...exit, label: "E27", effect: "processing_block", controls: [{ kind: "IF", text: "IF invalid = abap_true." }], notice: "not evaluated" };
  assert.equal(evidenceId("exit", decorated), evidenceId("exit", exit));
  decorated.label = "E1";
  decorated.controls = [];
  assert.equal(evidenceId("exit", decorated), evidenceId("exit", exit));
});

test("different same-line statements have different evidence ids", () => {
  const check = { ...exit, text: "CHECK allowed = abap_true." };
  assert.notEqual(evidenceId("exit", check), evidenceId("exit", exit));
});

test("evidence ids normalize repository path separators and dot segments", () => {
  const alternate = { ...exit, path: ".\\src\\temporary\\..\\service.clas.abap" };
  const repeated = { ...exit, path: "./src//service.clas.abap" };
  assert.equal(evidenceId("exit", alternate), evidenceId("exit", exit));
  assert.equal(evidenceId("exit", repeated), evidenceId("exit", exit));
  assert.notEqual(evidenceId("exit", { ...exit, path: "src/Service.clas.abap" }), evidenceId("exit", exit));
});

test("evidence ids normalize newline encodings while preserving source case and spacing", () => {
  const multiline = { ...exit, span: "L840-L841", text: "CHECK allowed =\n  abap_true." };
  assert.equal(evidenceId("exit", multiline), evidenceId("exit", { ...multiline, text: "CHECK allowed =\r\n  abap_true." }));
  assert.equal(evidenceId("exit", multiline), evidenceId("exit", { ...multiline, text: "CHECK allowed =\r  abap_true." }));
  assert.notEqual(evidenceId("exit", multiline), evidenceId("exit", { ...multiline, text: "check allowed =\n  abap_true." }));
  assert.notEqual(evidenceId("exit", multiline), evidenceId("exit", { ...multiline, text: "CHECK allowed =\n abap_true." }));
});

test("evidence kind, file, line span and source changes each change identity", () => {
  const baseline = evidenceId("exit", exit);
  for (const kind of ["assignment", "call", "declaration"] as const) assert.notEqual(evidenceId(kind, exit), baseline);
  assert.notEqual(evidenceId("exit", { ...exit, path: "src/other.clas.abap" }), baseline);
  assert.notEqual(evidenceId("exit", { ...exit, span: "L841-L841" }), baseline);
  assert.notEqual(evidenceId("exit", { ...exit, text: "EXIT." }), baseline);
});

test("invocation coordinates distinguish identical occurrences on the same line", () => {
  const call = { path: "src/service.clas.abap", span: "L605-L605", text: "ping( ). ping( )." };
  const first = evidenceId("call", call, { line: 605, column: 1 });
  const second = evidenceId("call", call, { line: 605, column: 10 });
  assert.match(first, /^call:[0-9a-f]{16}$/);
  assert.notEqual(first, second);
  assert.notEqual(first, evidenceId("call", call));
  assert.notEqual(first, evidenceId("call", call, { line: 606, column: 1 }));
  assert.equal(first, evidenceId("call", { ...call }, { line: 605, column: 1 }));
});
