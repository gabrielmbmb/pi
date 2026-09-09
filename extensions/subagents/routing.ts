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
import type { SubagentsConfig } from "./config.ts";

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
  /** Hard failure: unknown, unauthenticated, or ambiguous. */
  error?: string;
  /** Explicit notice when the same model ID was rerouted to an authenticated provider. */
  warning?: string;
  /** Auth-configured candidates for error display. */
  candidates?: string[];
}

export function modelLabel(model: ModelLike): string {
  return `${model.provider}/${model.id}`;
}

function candidateList(models: ModelLike[]): string[] {
  return models.slice(0, MAX_MODEL_CANDIDATES).map(modelLabel);
}

/**
 * Resolve only auth-configured overrides. Bare IDs prefer exact matches, then
 * unique authenticated prefixes. An explicitly named unauthenticated provider
 * can reroute only to a single authenticated provider with the SAME model ID.
 * Never silently choose another model or guess between available providers.
 */
export function resolveModelRef(reference: string, registry: ModelRegistryLike): ResolvedModelRef {
  const trimmed = reference.trim();
  if (!trimmed) return { error: "Empty model reference" };

  const all = registry.getAll();
  const available = all.filter((model) => registry.hasConfiguredAuth(model));
  const lower = trimmed.toLowerCase();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex > 0 && slashIndex < trimmed.length - 1) {
    const provider = trimmed.slice(0, slashIndex).trim().toLowerCase();
    const modelId = trimmed.slice(slashIndex + 1).trim().toLowerCase();
    const requested = all.find((model) => model.provider.toLowerCase() === provider && model.id.toLowerCase() === modelId);
    if (requested) {
      if (available.includes(requested)) return { model: requested };
      const alternatives = available.filter((model) => model.id.toLowerCase() === modelId);
      if (alternatives.length === 1) return {
        model: alternatives[0],
        warning: `No configured auth for ${modelLabel(requested)}; using ${modelLabel(alternatives[0]!)} (same model ID).`,
      };
      return {
        error: `No configured auth for ${modelLabel(requested)}; ${alternatives.length ? "multiple authenticated providers offer this model; choose provider/modelId" : "configure credentials or omit model to inherit the parent"}`,
        ...(alternatives.length ? { candidates: candidateList(alternatives) } : {}),
      };
    }
    return {
      error: `No model matches "${trimmed}"`,
      candidates: candidateList(available.filter((model) => model.id.toLowerCase().includes(modelId))),
    };
  }

  const exact = all.filter((model) => model.id.toLowerCase() === lower);
  const matches = exact.length ? exact : all.filter((model) => model.id.toLowerCase().startsWith(lower));
  const authenticated = matches.filter((model) => available.includes(model));
  if (authenticated.length === 1) return { model: authenticated[0] };
  if (authenticated.length > 1) return {
    error: exact.length ? `"${trimmed}" matches models from multiple authenticated providers; use provider/modelId` : `"${trimmed}" is ambiguous; matching authenticated models:`,
    candidates: candidateList(authenticated),
  };
  if (matches.length) return {
    error: `No configured auth for models matching "${trimmed}"; configure credentials or omit model to inherit the parent`,
  };

  const loose = available.filter((model) => model.id.toLowerCase().includes(lower) || model.name?.toLowerCase().includes(lower));
  return {
    error: `No model matches "${trimmed}"`,
    ...(loose.length ? { candidates: candidateList(loose) } : {}),
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

const SPAWN_MODEL_GUIDANCE =
  "For spawn_subagents, omit model unless a task needs an override: omission uses the configured default, otherwise inherits your current provider/model unchanged (also for nested children). " +
  "When overriding, copy an available fully qualified provider/modelId from routing guidance when provided; do not guess provider prefixes. " +
  "openai and openai-codex are different providers with separate credentials. " +
  "An unavailable provider is rerouted only when exactly one authenticated provider offers the same model ID, and the spawn response reports that change. " +
  "model_reason is optional audit metadata; keep it concise. Long reasons are truncated, not rejected.";

export interface RoutingBlockResult {
  /** Ready-to-inject guidance, including safe defaults even without a config. */
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
    return { block: SPAWN_MODEL_GUIDANCE, disabledRules: [] };
  }

  const lines: string[] = [];
  const disabledRules: { name: string; reason: string }[] = [];
  let defaultWarning: string | undefined;

  lines.push(SPAWN_MODEL_GUIDANCE);
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
    if (resolved.warning) lines.push(`  Note: ${resolved.warning}`);
  }

  if (config.defaultModel) {
    const resolved = resolveModelRef(config.defaultModel, registry);
    if (resolved.model) {
      const target = modelLabel(resolved.model) + (config.defaultThinking ? ` (thinking: ${config.defaultThinking})` : "");
      lines.push(`Default for spawned subagents: ${target}`);
      if (resolved.warning) {
        defaultWarning = resolved.warning;
        lines.push(`  Note: ${resolved.warning}`);
      }
    } else {
      defaultWarning = `defaultModel "${config.defaultModel}" is not resolvable (${resolved.error}); subagents inherit the parent model`;
      lines.push(`Default for spawned subagents: inherited (configured default "${config.defaultModel}" is unresolvable)`);
    }
  } else if (config.defaultThinking) {
    lines.push(`Default thinking for spawned subagents: ${config.defaultThinking}`);
  }

  lines.push(
    "If a task matches an available rule, copy that rule's model/thinking target; otherwise leave model unset for the configured default or inheritance. " +
    "Never use unavailable rules. Optionally record the choice in model_reason. Full rule descriptions live in the config files.",
  );

  return { block: lines.join("\n"), disabledRules, ...(defaultWarning ? { defaultWarning } : {}) };
}

/**
 * Static promptGuidelines for the spawn tool. The
 * live rule list is injected per turn / per spawn so it is never stale.
 */
export const SPAWN_TOOL_GUIDELINES = [
  "Use spawn_subagents to delegate self-contained tasks to parallel background subagents; prefer leaving model unset for the configured default or inheritance, and never guess provider prefixes. For overrides, copy an available target from the injected routing guidance. model_reason is optional and long reasons are truncated. Always collect_subagents before reporting results.",
];
