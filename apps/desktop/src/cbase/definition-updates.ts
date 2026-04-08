import type { CbaseDefinition, CbaseFilter, CbaseProperty } from "./types";

function collectFilterPropertyIds(
  filter: CbaseFilter,
  propertyIds: Set<string>,
): void {
  if ("and" in filter) {
    for (const entry of filter.and) {
      collectFilterPropertyIds(entry, propertyIds);
    }
    return;
  }

  if ("or" in filter) {
    for (const entry of filter.or) {
      collectFilterPropertyIds(entry, propertyIds);
    }
    return;
  }

  if ("not" in filter) {
    collectFilterPropertyIds(filter.not, propertyIds);
    return;
  }

  propertyIds.add(filter.property);
}

export function collectReferencedPropertyIds(filters: CbaseFilter[]): string[] {
  const propertyIds = new Set<string>();

  for (const filter of filters) {
    collectFilterPropertyIds(filter, propertyIds);
  }

  return [...propertyIds];
}

export function updateViewFilters(
  definition: CbaseDefinition,
  viewId: string,
  filters: CbaseFilter[],
  availableProperties?: Record<string, CbaseProperty>,
): CbaseDefinition {
  const nextFilters = filters.length > 0 ? filters : undefined;
  const updated: CbaseDefinition = {
    ...definition,
    views: definition.views.map((view) =>
      view.id === viewId ? { ...view, filters: nextFilters } : view,
    ),
  };

  if (!availableProperties) {
    return updated;
  }

  const missingPropertyIds = collectReferencedPropertyIds(filters).filter(
    (propertyId) =>
      !updated.properties[propertyId] && availableProperties[propertyId],
  );

  if (missingPropertyIds.length === 0) {
    return updated;
  }

  return {
    ...updated,
    properties: {
      ...updated.properties,
      ...Object.fromEntries(
        missingPropertyIds.map((propertyId) => [
          propertyId,
          availableProperties[propertyId],
        ]),
      ),
    },
  };
}
