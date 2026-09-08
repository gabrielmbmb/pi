/**
 * Model routing for subagents (DESIGN.md §6): bare-id model resolution, the
 * spawn-time resolution chain, and the injected guidance block.
 *
 * `resolveCliModel()` from the runtime SDK was evaluated for reuse and
 * rejected: its semantics (fuzzy alias/date heuristics, synthesized fallback
 * models, pattern:thinking parsing) do not match the strict
 * exact-→prefix-→error chain this design specifies.
 *
 * Pure/UI-free: the model registry is injected as a structural interface so
 * tests can pass fakes and index.ts passes `ctx.modelRegistry` directly.
 */

import {
  GUIDANCE_SNIPPET_CHARS,
  MAX_MODEL_CANDIDATES,
  type ThinkingLevelName,
} from "./constants.ts";
import type { RoutingRule, SubagentsConfig } from "./config.ts";

/** Structural slice of a Model that routing needs. */
export interface ModelLike {
  provider: string;
  id: string;
  name?: string;
}

/** Structural slice of pi's ModelRegistry that routing needs. */
export interface ModelRegistryLike {
  getAll(): ModelLike[];
  hasConfiguredAuth(model: ModelLike): boolean;
}

export interface ResolvedModelRef {
  model?: ModelLike;
  /** Hard failure: unresolvable or ambiguous. */
  error?: string;
  /** Soft note: resolved, but the provider has no configured auth. */
  warning?: string;
  /** Top candidates for error display, auth-configured first. */
  candidates?: string[];
}

export function modelLabel(model: ModelLike): string {
  return `${model.provider}/${model.id}`;
}

function authFirst(models: ModelLike[], registry: ModelRegistryLike): ModelLike[] {
  const withAuth = models.filter((model) => registry.hasConfiguredAuth(model));
  const withoutAuth = models.filter((model) => !registry.hasConfiguredAuth(model));
  return [...withAuth, ...withoutAuth];
}

function candidateList(models: ModelLike[]): string[] {
  return models.slice(0, MAX_MODEL_CANDIDATES).map(modelLabel);
}

/**
 * Resolve a model reference: `provider/modelId` or a bare model id.
 *
 * Bare ids: exact `model.id` match must be unique across providers; else a
 * prefix match must yield exactly one candidate (providers with no configured
 * auth match last — a unique auth-configured candidate beats no-auth ones);
 * else an error listing the top candidates.
 */
export function resolveModelRef(reference: string, registry: ModelRegistryLike): ResolvedModelRef {
  const trimmed = reference.trim();
  if (!trimmed) return { error: "Empty model reference" };

  const all = registry.getAll();
  const lower = trimmed.toLowerCase();

  const slashIndex = trimmed.indexOf("/");
  if (slashIndex > 0 && slashIndex < trimmed.length - 1) {
    const provider = trimmed.slice(0, slashIndex).trim().toLowerCase();
    const modelId = trimmed.slice(slashIndex + 1).trim().toLowerCase();
    const matches = all.filter(
      (model) => model.provider.toLowerCase() === provider && model.id.toLowerCase() === modelId,
    );
    if (matches.length === 1) return withAuthWarning(matches[0], registry);
    return {
      error: `No model matches "${trimmed}"`,
      candidates: candidateList(authFirst(all.filter((m) => m.id.toLowerCase().includes(modelId)), registry)),
    };
  }

  // Bare id: exact match, unique provider.
  const exact = all.filter((model) => model.id.toLowerCase() === lower);
  if (exact.length === 1) return withAuthWarning(exact[0], registry);
  if (exact.length > 1) {
    return {
      error: `"${trimmed}" matches models from multiple providers; use provider/modelId`,
      candidates: candidateList(authFirst(exact, registry)),
    };
  }

  // Prefix match; auth-configured providers match last, so a unique
  // auth-configured candidate wins over no-auth ones.
  const prefix = all.filter((model) => model.id.toLowerCase().startsWith(lower));
  const prefixWithAuth = prefix.filter((model) => registry.hasConfiguredAuth(model));
  if (prefixWithAuth.length === 1) return withAuthWarning(prefixWithAuth[0], registry);
  if (prefix.length === 1) return withAuthWarning(prefix[0], registry);
  if (prefix.length > 1) {
    return {
      error: `"${trimmed}" is ambiguous; matching models:`,
      candidates: candidateList(authFirst(prefix, registry)),
    };
  }

  // Nothing by prefix; offer substring matches as candidates.
  const loose = all.filter(
    (model) =>
      model.id.toLowerCase().includes(lower) || model.name?.toLowerCase().includes(lower),
  );
  return {
    error: `No model matches "${trimmed}"`,
    ...(loose.length > 0 ? { candidates: candidateList(authFirst(loose, registry)) } : {}),
  };
}

function withAuthWarning(model: ModelLike, registry: ModelRegistryLike): ResolvedModelRef {
  if (registry.hasConfiguredAuth(model)) return { model };
  // Warning only: model fallback chains may still work.
  return {
    model,
    warning: `No configured auth for ${modelLabel(model)}; the spawn may fail at runtime`,
  };
}

export type ModelSource = "explicit" | "config-default" | "inherited";
export type ThinkingSource = "explicit" | "config-default" | "inherited";

export interface SpawnRoutingInput {
  /** Explicit model reference chosen by the spawning agent (often a rule's model). */
  model?: string;
  /** Explicit thinking level chosen by the spawning agent. */
  thinking?: ThinkingLevelName;
}

export interface ParentModelInfo {
  model: ModelLike;
  thinking: ThinkingLevelName;
}

export interface ResolvedSpawnRouting {
  model: ModelLike;
  modelSource: ModelSource;
  thinking: ThinkingLevelName;
  thinkingSource: ThinkingSource;
  warnings: string[];
  /**
   * Set when an explicit `model` param cannot be resolved — a hard spawn
   * validation error per DESIGN.md §13 (config defaults only warn+inherit).
   */
  error?: string;
  candidates?: string[];
}

/**
 * The spawn resolution chain (DESIGN.md §6):
 * explicit model/thinking → config defaultModel/defaultThinking → inherit
 * the parent session's resolved model. Cheap by default, expensive on demand.
 */
export function resolveSpawnRouting(
  input: SpawnRoutingInput,
  config: SubagentsConfig | null,
  registry: ModelRegistryLike,
  parent: ParentModelInfo,
): ResolvedSpawnRouting {
  const warnings: string[] = [];

  let model: ModelLike;
  let modelSource: ModelSource;
  let candidates: string[] | undefined;

  if (input.model !== undefined) {
    const resolved = resolveModelRef(input.model, registry);
    if (resolved.error) {
      return {
        model: parent.model,
        modelSource: "inherited",
        thinking: parent.thinking,
        thinkingSource: "inherited",
        warnings,
        error: `model "${input.model}": ${resolved.error}`,
        ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
      };
    }
    model = resolved.model!;
    modelSource = "explicit";
    if (resolved.warning) warnings.push(resolved.warning);
  } else if (config?.defaultModel) {
    const resolved = resolveModelRef(config.defaultModel, registry);
    if (resolved.model) {
      model = resolved.model;
      modelSource = "config-default";
      if (resolved.warning) warnings.push(resolved.warning);
    } else {
      model = parent.model;
      modelSource = "inherited";
      warnings.push(
        `defaultModel "${config.defaultModel}" is not resolvable (${resolved.error}); inheriting ${modelLabel(parent.model)}`,
      );
    }
  } else {
    model = parent.model;
    modelSource = "inherited";
  }

  let thinking: ThinkingLevelName;
  let thinkingSource: ThinkingSource;
  if (input.thinking !== undefined) {
    thinking = input.thinking;
    thinkingSource = "explicit";
  } else if (config?.defaultThinking !== undefined) {
    thinking = config.defaultThinking as ThinkingLevelName;
    thinkingSource = "config-default";
  } else {
    thinking = parent.thinking;
    thinkingSource = "inherited";
  }

  return { model, modelSource, thinking, thinkingSource, warnings };
}

function snippet(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= GUIDANCE_SNIPPET_CHARS) return collapsed;
  return `${collapsed.slice(0, GUIDANCE_SNIPPET_CHARS - 1)}…`;
}

export interface RoutingBlockResult {
  /** Ready-to-inject guidance block; empty string when there is nothing to say. */
  block: string;
  /** Rules whose model did not resolve (disabled; surfaced as diagnostics). */
  disabledRules: { name: string; reason: string }[];
  /** Diagnostic when defaultModel did not resolve. */
  defaultWarning?: string;
}

/**
 * Build the routing guidance block injected into the main session's context
 * (pi.on("before_agent_start")) and into every subagent system prompt
 * (DefaultResourceLoader appendSystemPrompt). Always built fresh so guidance
 * is never stale at any depth.
 */
export function buildRoutingBlock(
  config: SubagentsConfig | null,
  registry: ModelRegistryLike,
  paths: { userPath: string; projectPath: string },
): RoutingBlockResult {
  if (!config || (config.rules.length === 0 && !config.defaultModel && !config.defaultThinking)) {
    return { block: "", disabledRules: [] };
  }

  const lines: string[] = [];
  const disabledRules: { name: string; reason: string }[] = [];
  let defaultWarning: string | undefined;

  lines.push("Subagent model routing (config: " + [paths.userPath, paths.projectPath].join(", ") + "):");

  for (const rule of config.rules) {
    const resolved = resolveModelRef(rule.model, registry);
    if (!resolved.model) {
      disabledRules.push({ name: rule.name, reason: resolved.error ?? "unresolvable" });
      lines.push(`- ${rule.name} → (unavailable: ${resolved.error}) — ${snippet(rule.description)}`);
      continue;
    }
    const target = modelLabel(resolved.model) + (rule.thinking ? ` (thinking: ${rule.thinking})` : "");
    lines.push(`- ${rule.name} → ${target} — ${snippet(rule.description)}`);
  }

  if (config.defaultModel) {
    const resolved = resolveModelRef(config.defaultModel, registry);
    if (resolved.model) {
      const target = modelLabel(resolved.model) + (config.defaultThinking ? ` (thinking: ${config.defaultThinking})` : "");
      lines.push(`Default for spawned subagents: ${target}`);
    } else {
      defaultWarning = `defaultModel "${config.defaultModel}" is not resolvable (${resolved.error}); subagents inherit the parent model`;
      lines.push(`Default for spawned subagents: inherited (configured default "${config.defaultModel}" is unresolvable)`);
    }
  } else if (config.defaultThinking) {
    lines.push(`Default thinking for spawned subagents: ${config.defaultThinking}`);
  }

  lines.push(
    "When spawning subagents, pick model/thinking by task similarity to these rules, pass them via the model/thinking params, and record the choice in model_reason. Full rule descriptions live in the config files.",
  );

  return { block: lines.join("\n"), disabledRules, ...(defaultWarning ? { defaultWarning } : {}) };
}

/**
 * Static promptGuidelines for the spawn tool: a one-line pointer only. The
 * live rule list is injected per turn / per spawn so it is never stale.
 */
export const SPAWN_TOOL_GUIDELINES = [
  "Use spawn_subagents to delegate self-contained tasks to parallel background subagents instead of doing every subtask yourself; check the injected subagent model-routing guidance (or /subagents config) to pick an appropriate model/thinking, and always collect_subagents before reporting results.",
];
