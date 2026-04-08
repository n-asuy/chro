/**
 * Pick the short slug for URLs, falling back to UUID for backward compat.
 */
export function slugOrId(entity: { slug?: string | null; id: string }): string {
  return entity.slug ?? entity.id;
}
