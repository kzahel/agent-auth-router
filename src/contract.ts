// Model rows the control socket returns to integrations. Fields are additive;
// consumers gate on the /v1/info capability that introduced them.

/** One row of an account's provider catalog (`/v1/models` or Codex's model list). */
export interface CatalogModel {
  id: string; name: string; contextWindow?: number;
  supportedReasoningEfforts?: { reasoningEffort: string; description: string }[];
  defaultReasoningEffort?: string;
  supportsAdaptiveThinking?: boolean;
  supportsEffort?: boolean;
  capabilitySource?: "provider";
}

/**
 * One row of the official Claude CLI's `initialize.models`, as that profile's
 * CLI reported it (capability `catalog-cli-models-v1`). `value` is what the
 * CLI accepts as `--model`, often an alias; `resolvedModel` is the concrete
 * id the CLI says that alias selects for this account, when it reports one.
 */
export interface CliModel {
  value: string;
  displayName: string;
  description?: string;
  resolvedModel?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
}

/** `/v1/catalog` response. */
export interface AccountCatalog {
  models: CatalogModel[];
  cliModels?: CliModel[];
  cliModelsAt?: string;
}

export const EFFORT_LEVELS: readonly string[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;

/**
 * Bound and type-check CLI-reported rows. Malformed rows are dropped, unknown
 * fields are not copied, and an absent or non-array list yields `undefined`.
 */
export function sanitizeCliModels(value: unknown): CliModel[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 64).flatMap((entry): CliModel[] => {
    const row = object(entry);
    const id = row?.value;
    if (!row || typeof id !== "string" || !id.length || id.length > 200) return [];
    const model: CliModel = { value: id, displayName: text(row.displayName, 200) ?? id };
    const description = text(row.description, 300);
    if (description) model.description = description;
    const resolved = row.resolvedModel;
    if (typeof resolved === "string" && resolved.length > 0 && resolved.length <= 200) model.resolvedModel = resolved;
    for (const flag of ["supportsEffort", "supportsAdaptiveThinking", "supportsFastMode", "supportsAutoMode"] as const) {
      if (typeof row[flag] === "boolean") model[flag] = row[flag];
    }
    if (Array.isArray(row.supportedEffortLevels)) {
      model.supportedEffortLevels = [...new Set(row.supportedEffortLevels.slice(0, 16).filter((level): level is string => typeof level === "string" && EFFORT_LEVELS.includes(level)))];
    }
    return [model];
  });
}
