export interface JsonPatchPathOperation {
  path: string;
}

export function dedupeJsonPatchOperations<T extends JsonPatchPathOperation>(
  ops: readonly T[],
): T[] {
  const lastIndexByPath = new Map<string, number>();

  ops.forEach((op, index) => {
    lastIndexByPath.set(op.path, index);
  });

  return [...lastIndexByPath.values()]
    .sort((a, b) => a - b)
    .map((index) => ops[index]!)
    .filter(Boolean);
}
