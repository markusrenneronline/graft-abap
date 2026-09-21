import { contentHash } from '../util/id.js';

export const INVENTORY_REVISION_PATTERN = '^inventory:[a-f0-9]{64}$';

/** Content identity, not a retained server-side snapshot. Object property order
 * and build timestamps do not matter. Callers supply canonically ordered rows
 * plus every field used to filter/render their inventory, including evidence. */
export function inventoryRevision(kind: string, payload: unknown, expected: unknown): string {
  if (expected !== undefined && (typeof expected !== 'string' || !new RegExp(INVENTORY_REVISION_PATTERN).test(expected)))
    throw new Error('revision must be an inventory:<64 lowercase SHA-256 hex characters> token copied from this tool.');
  const serialized = JSON.stringify(['graft-inventory-v1', kind, payload], (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
  const revision = `inventory:${contentHash(serialized)}`;
  if (expected !== undefined && expected !== revision)
    throw new Error(`Inventory changed since the supplied revision. Restart with offset=0 and no revision; do not combine these pages. Current revision: ${revision}`);
  return revision;
}

export function inventoryRevisionLines(revision: string, expected: unknown, offset: number): string[] {
  return [
    `[Inventory] revision: ${revision}`,
    ...(expected !== undefined ? ['[Inventory] revision verified.']
      : offset > 0 ? ['[Inventory] pagination is unpinned; pass the revision from the first page to detect inventory changes.'] : []),
  ];
}
