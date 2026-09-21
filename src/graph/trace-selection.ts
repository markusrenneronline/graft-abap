/** Pure evidence selection. Filtering detailed evidence never changes traversal
 * or the compact reached-symbol list; callers apply these ids only to evidence. */
import { resolveSymbol } from "./traverse.js";
import type { GraphV1 } from "./types.js";

/** `undefined` keeps the default (all); an explicit empty array selects none. */
export function parseEvidenceSelectors(value: unknown, optionName: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 50) {
    throw new Error(`${optionName} must be an array of at most 50 nonempty strings.`);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const entry: unknown = value[index];
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(`${optionName}[${index}] must be a nonempty string; whitespace-only selectors are not allowed.`);
    }
    const selector = entry.trim();
    const key = selector.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(selector);
    }
  }
  return result;
}

/** Resolve through the shared symbol contract, retaining all available matches.
 * A selector must contribute at least one available symbol: a typo or a symbol
 * outside the current trace must not silently look like missing exit evidence. */
export function selectEvidenceIds(
  graph: GraphV1,
  availableIds: readonly string[],
  selectors: readonly string[] | undefined,
  optionName: string,
): Set<string> | undefined {
  const parsed = parseEvidenceSelectors(selectors, optionName);
  if (parsed === undefined) return undefined;
  const available = new Set(availableIds);
  const selected = new Set<string>();
  for (const selector of parsed) {
    const matches = resolveSymbol(graph, selector);
    if (matches.length === 0) {
      throw new Error(`${optionName} selector ${JSON.stringify(selector)} does not match any graph symbol.`);
    }
    const allowed = matches.filter(node => available.has(node.id));
    if (allowed.length === 0) {
      throw new Error(`${optionName} selector ${JSON.stringify(selector)} matches graph symbols, but none are available in this trace. Choose a symbol from the available trace targets or sources.`);
    }
    for (const node of allowed) selected.add(node.id);
  }
  return selected;
}
