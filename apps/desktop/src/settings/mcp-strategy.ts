type JsonRecord = Record<string, unknown>;

export interface McpConfig {
  servers: JsonRecord;
  servers_path: string[];
  template: JsonRecord;
  is_toml_config: boolean;
}

function ensurePath(container: JsonRecord, path: string[]): JsonRecord {
  let current: JsonRecord = container;
  for (const segment of path) {
    const next = current[segment];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      const created: JsonRecord = {};
      current[segment] = created;
      current = created;
      continue;
    }
    current = next as JsonRecord;
  }
  return current;
}

function getFromPath(container: JsonRecord, path: string[]): unknown {
  let current: unknown = container;
  for (const segment of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as JsonRecord)[segment];
  }
  return current;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class McpConfigStrategyGeneral {
  static createFullConfig(cfg: McpConfig): JsonRecord {
    const fullConfig = clone(cfg.template ?? {});
    if (!cfg.servers_path.length) {
      return fullConfig;
    }

    const holder = ensurePath(fullConfig, cfg.servers_path.slice(0, -1));
    const lastKey = cfg.servers_path[cfg.servers_path.length - 1]!;
    holder[lastKey] = clone(cfg.servers ?? {});
    return fullConfig;
  }

  static validateFullConfig(cfg: McpConfig, fullConfig: JsonRecord): void {
    let current: unknown = fullConfig;
    for (const segment of cfg.servers_path) {
      if (!current || typeof current !== "object" || Array.isArray(current)) {
        throw new Error(
          `Missing required field at path: ${cfg.servers_path.join(".")}`,
        );
      }
      current = (current as JsonRecord)[segment];
    }

    if (!current || typeof current !== "object" || Array.isArray(current)) {
      throw new Error("Servers configuration must be an object");
    }
  }

  static extractServersForApi(
    cfg: McpConfig,
    fullConfig: JsonRecord,
  ): JsonRecord {
    const value = getFromPath(fullConfig, cfg.servers_path);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Servers configuration must be an object");
    }
    return clone(value as JsonRecord);
  }

}

