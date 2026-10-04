import type { Provider } from "./types.ts";

export interface CatalogModel {
  id: string; name: string; contextWindow?: number;
  supportedReasoningEfforts?: { reasoningEffort: string; description: string }[];
  defaultReasoningEffort?: string;
  supportsAdaptiveThinking?: boolean;
  supportsEffort?: boolean;
  capabilitySource?: "provider";
}
const levels = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};

/** Account catalog metadata only; never infer entitlement from a model name. */
export function modelCapabilities(provider: Provider, value: unknown): Partial<CatalogModel> {
  const row = object(value);
  const result: Partial<CatalogModel> = {};
  const context = row.context_window ?? row.max_input_tokens;
  if (Number.isSafeInteger(context) && context > 0) result.contextWindow = context;
  if (provider === "codex" && Array.isArray(row.supported_reasoning_levels)) {
    result.supportedReasoningEfforts = row.supported_reasoning_levels.slice(0, 16).flatMap((v: unknown) => {
      const r = object(v);
      return levels.includes(r.effort) ? [{ reasoningEffort: r.effort, description: typeof r.description === "string" ? r.description.slice(0, 300) : "" }] : [];
    });
    result.supportsEffort = result.supportedReasoningEfforts.length > 0;
    if (levels.includes(row.default_reasoning_level)) result.defaultReasoningEffort = row.default_reasoning_level;
    result.capabilitySource = "provider";
  }
  if (provider === "claude") {
    const capabilities = object(row.capabilities), effort = object(capabilities.effort), thinking = object(capabilities.thinking);
    if (typeof effort.supported === "boolean") {
      result.supportsEffort = effort.supported;
      result.supportedReasoningEfforts = levels.filter(level => effort.supported && object(effort[level]).supported === true)
        .map(reasoningEffort => ({ reasoningEffort, description: "" }));
      result.capabilitySource = "provider";
    }
    const adaptive = object(object(thinking.types).adaptive).supported;
    if (typeof adaptive === "boolean") { result.supportsAdaptiveThinking = adaptive; result.capabilitySource = "provider"; }
  }
  return result;
}

export function validThinking(value: unknown): value is string {
  return typeof value === "string" && /^(auto|off|on:(low|medium|high|xhigh|max))$/.test(value);
}

/** Match YA's named effort vocabulary, including its Max -> native ultra mapping. */
export function supportsThinking(model: CatalogModel | undefined, thinking: string | undefined): boolean {
  if (!model) return false;
  if (thinking === undefined || thinking === "auto" || thinking === "off") return true;
  if (!validThinking(thinking) || model.supportsEffort === false || model.supportsAdaptiveThinking === false) return false;
  const effort = thinking.slice(3);
  return !!model.supportedReasoningEfforts?.some(r => r.reasoningEffort === effort || (effort === "max" && r.reasoningEffort === "ultra"));
}
