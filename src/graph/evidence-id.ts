/** Source-based evidence identity, independent of query-local display labels. */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { SourceExcerptV1 } from "./types.js";

export type EvidenceKind = "exit" | "assignment" | "call" | "declaration";

/**
 * Format: kind:hash (first 16 lowercase hex characters of SHA-256).
 *
 * Hash input is UTF-8 JSON.stringify(["graft-evidence-v1", kind, normalizedPath,
 * excerpt.span, normalizedText, occurrence ? [line, column] : null]).
 * Backslashes, redundant path separators and dot segments are normalized with
 * posix.normalize; path case is preserved. Text CRLF and bare CR become LF, but
 * source case and every other whitespace character remain significant.
 *
 * Labels, filters, query order, controls and all other metadata are excluded.
 * Moving a statement to different lines or changing its source changes its id.
 * Supply occurrence to distinguish identical invocations on the same source
 * line. This identifies recorded source evidence, not runtime execution.
 */
export function evidenceId(
  kind: EvidenceKind,
  excerpt: SourceExcerptV1,
  occurrence?: { line: number; column: number },
): string {
  const path = posix.normalize(excerpt.path.replace(/\\/g, "/"));
  const source = excerpt.text.replace(/\r\n?/g, "\n");
  const position = occurrence ? [occurrence.line, occurrence.column] : null;
  const input = JSON.stringify(["graft-evidence-v1", kind, path, excerpt.span, source, position]);
  const hash = createHash("sha256").update(input, "utf8").digest("hex").slice(0, 16);
  return `${kind}:${hash}`;
}
