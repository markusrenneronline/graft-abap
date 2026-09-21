# Recorded ABAP analysis diagnostics

`graft_diagnostics` exposes all diagnostic categories stored with a repository graph. It is separate from `graft_unresolved_calls`: a diagnostic can concern a type, missing metadata or an unsupported statement, and several unresolved calls can share a diagnostic. Neither count is an analysis coverage percentage.

Examples of MCP arguments:

```json
{"limit": 20}
{"kind": "unsupported_statement", "evidence": true}
{"query": "constructor", "in": "src", "limit": 20, "offset": 0}
{"query": "diagnostic:<id copied from output>", "evidence": true}
```

All seven parameters are optional:

| Parameter | Meaning |
|---|---|
| `query` | Case-insensitive substring of category/message, or an exact diagnostic ID |
| `kind` | Exact category; omit for all categories and matched counts |
| `in` | Repository-relative source path prefix, respecting directory segments |
| `limit` | Integer 1–100; default 20 |
| `offset` | Nonnegative safe integer; default 0 |
| `evidence` | Boolean; default false |
| `revision` | Copy the `inventory:<SHA-256>` token from the first page to require unchanged inventory content |

The order is source path, line, optional occurrence column, category and message. Every page reports `[Inventory] revision: inventory:<SHA-256>`. Pass this token as `revision` on later pages, keeping the same filters. A changed inventory produces an explicit error instead of returning a page from a different version. Restart at offset 0 without the old token; do not merge the two versions. Existing callers can still omit the token, but an offset above zero then warns that pagination is unpinned.

The revision covers the complete diagnostic inventory, including stored source evidence, regardless of filters, page size or evidence display. A change outside the selected filter can therefore require a restart. Identical content after a rebuild retains its revision; build timestamps and object-key ordering do not change it. This is content validation, not server-side retention of previous inventories, an export lock or a comparison with SAP. Each request still follows normal freshness checks. Failed refresh can serve the retained inventory with its matching revision and a stale-source warning. Switching filters deliberately requires starting the filtered enumeration at offset 0 even though the inventory revision is unchanged.

Individual diagnostic IDs are based on the recorded path, line, category and message, plus an occurrence column when present, independent of filter, page position and source display. IDs of older notices without a column remain unchanged. They are not permanent identities across edits that move a finding or change its meaning. Inventory revisions additionally include source evidence, so an evidence-only change invalidates page continuation even if the individual IDs stay the same.

With `evidence=true`, the response includes the original **source line** captured during extraction. It is not necessarily the complete ABAP statement or method. Indentation is preserved. Queries never read a changed source file to reconstruct evidence for an older graph. Older graphs or notices without a source location explicitly report unavailable evidence. Failed refresh retains the existing graph and its source lines with the normal `not verified current` warning.

`unsupported_statement` means the configured parser could not model the statement. For example, an external macro definition may be absent from the export. This alone is not proof of invalid ABAP or an incomplete export. A fresh graph can contain analysis limitations. Absence of notices does not prove complete analysis: not every unsupported relationship currently produces a diagnostic.

Since pilot.20, `unresolved_construction` identifies NEW occurrences whose type/operand context or constructor ancestry is not resolved. The location includes a one-based column. These are analysis notices, not guessed method calls: the missing type may be a data type. Known data constructions and fully known classes without explicit constructors do not produce this notice. See ABAP-OBJECT-EXPRESSIONS.md for the supported classification and its limits.

Workspace-wide pagination is rejected; address an individual repository. Invalid types and page ranges return errors. Unknown categories simply match no notices, allowing callers to probe categories without hard-coded version-specific lists.

CLI equivalents:

```text
node pilot/run.mjs notices --kind unsupported_statement --evidence
node pilot/run.mjs notices --in src --limit 100 --offset 100 --revision <token-from-first-page>
```

The older `node pilot/run.mjs diagnostics [kind]` JSON command remains compatible and still returns `first50`. Use `notices` or MCP for complete pagination.

Tests cover more than 50 entries, IDs, filters, exact source lines, old graphs, validation, workspace rejection, failed refresh/recovery and independent verification of persisted evidence. The local MCP smoke test walks every recorded diagnostic through a separate stdio server.

Since pilot.19, both inventory tools share revision validation. A token from `graft_unresolved_calls` cannot be used with `graft_diagnostics`. Tests cover content changes at unchanged counts, removal, evidence changes, reload, caller labels, invalid tokens and real MCP refresh/recovery. Full graph analysis remains unchanged.
