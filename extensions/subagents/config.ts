/**
 * Model-routing config for subagents: load, validate, and merge the two
 * config layers (DESIGN.md §6).
 *
 *   ~/.pi/agent/subagents.json   (user)
 *   <cwd>/.pi/subagents.json     (project, overrides per rule name)
 *
 * Validation severities:
 * - File-level errors (invalid JSON, bad shape, duplicate rule names within a
 *   file, > MAX_RULES, description > MAX_RULE_DESC_CHARS, bad thinking) are
 *   reported in `fileErrors`. When non-empty, spawns are blocked and
 *   `/subagents config` shows the diagnostics.
 * - Per-rule "model unresolvable" checks need the model registry and happen in
 *   routing.ts at spawn time (rule disabled + diagnostic, spawns still work).
 *
 * This module is UI-free and registry-free so it stays unit-testable.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { isThinkingLevel, MAX_RULE_DESC_CHARS, MAX_RULES } from "./constants.ts";

export interface RoutingRule {
  name: string;
  description: string;
  model: string;
  thinking?: string;
}

export interface SubagentsConfig {
  defaultModel?: string;
  defaultThinking?: string;
  /** Whether cancellation/adoption/merge-timeout notes are injected into the next turn (default true, §4). */
  interruptNotes?: boolean;
  rules: RoutingRule[];
}

export interface ConfigFileError {
  path: string;
  error: string;
}

export interface LoadedRoutingConfig {
  /**
   * Merged config, or null when neither file exists. Still built from the
   * valid file(s) when the other file has errors, so `/subagents config` can
   * show what *would* apply.
   */
  config: SubagentsConfig | null;
  /** File-level errors. Non-empty ⇒ spawns are blocked. */
  fileErrors: ConfigFileError[];
  /** Non-fatal notes surfaced by `/subagents config`. */
  warnings: string[];
  userPath: string;
  projectPath: string;
}

export interface RoutingConfigPaths {
  userPath: string;
  projectPath: string;
}

export function routingConfigPaths(agentDir: string, cwd: string): RoutingConfigPaths {
  return {
    userPath: join(agentDir, "subagents.json"),
    projectPath: join(cwd, CONFIG_DIR_NAME, "subagents.json"),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Parse and shape-validate one config file's content.
 * Returns either a config or a single file-level error message.
 */
export function parseSubagentsConfig(
  text: string,
  source: string,
): { config?: SubagentsConfig; error?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { error: `Invalid JSON in ${source}: ${(error as Error).message}` };
  }

  if (!isPlainObject(raw)) {
    return { error: `${source}: top-level value must be a JSON object` };
  }

  if (raw.defaultModel !== undefined && !nonEmptyString(raw.defaultModel)) {
    return { error: `${source}: "defaultModel" must be a non-empty string` };
  }

  if (raw.defaultThinking !== undefined && !isThinkingLevel(raw.defaultThinking)) {
    return { error: `${source}: "defaultThinking" must be one of off|minimal|low|medium|high|xhigh|max` };
  }

  if (raw.interruptNotes !== undefined && typeof raw.interruptNotes !== "boolean") {
    return { error: `${source}: "interruptNotes" must be a boolean` };
  }

  const rules: RoutingRule[] = [];
  if (raw.rules !== undefined) {
    if (!Array.isArray(raw.rules)) {
      return { error: `${source}: "rules" must be an array` };
    }
    if (raw.rules.length > MAX_RULES) {
      return { error: `${source}: more than ${MAX_RULES} rules (limit: ${MAX_RULES})` };
    }

    const seenNames = new Set<string>();
    for (const [index, entry] of (raw.rules as unknown[]).entries()) {
      const at = `${source}: rules[${index}]`;
      if (!isPlainObject(entry)) {
        return { error: `${at} must be an object` };
      }
      if (!nonEmptyString(entry.name)) return { error: `${at}: "name" must be a non-empty string` };
      if (!nonEmptyString(entry.description)) {
        return { error: `${at}: "description" must be a non-empty string` };
      }
      if (entry.description.length > MAX_RULE_DESC_CHARS) {
        return { error: `${at}: "description" longer than ${MAX_RULE_DESC_CHARS} characters` };
      }
      if (!nonEmptyString(entry.model)) return { error: `${at}: "model" must be a non-empty string` };
      if (entry.thinking !== undefined && !isThinkingLevel(entry.thinking)) {
        return { error: `${at}: "thinking" must be one of off|minimal|low|medium|high|xhigh|max` };
      }
      if (seenNames.has(entry.name)) {
        return { error: `${source}: duplicate rule name "${entry.name}"` };
      }
      seenNames.add(entry.name);

      rules.push({
        name: entry.name,
        description: entry.description,
        model: entry.model,
        ...(entry.thinking !== undefined ? { thinking: entry.thinking } : {}),
      });
    }
  }

  return {
    config: {
      ...(nonEmptyString(raw.defaultModel) ? { defaultModel: raw.defaultModel } : {}),
      ...(raw.defaultThinking !== undefined ? { defaultThinking: raw.defaultThinking as string } : {}),
      ...(raw.interruptNotes !== undefined ? { interruptNotes: raw.interruptNotes as boolean } : {}),
      rules,
    },
  };
}

/**
 * Merge user and project configs (DESIGN.md §6): project wins per rule name
 * (replacing in place, keeping the user ordering position), project-only rules
 * are appended, and project `defaultModel`/`defaultThinking` win when present.
 */
export function mergeConfigs(
  user: SubagentsConfig | undefined,
  project: SubagentsConfig | undefined,
): SubagentsConfig {
  if (!user && !project) return { rules: [] };
  if (!user) return project!;
  if (!project) return user;

  const rules: RoutingRule[] = user.rules.map((rule) => {
    const override = project.rules.find((candidate) => candidate.name === rule.name);
    return override ?? rule;
  });
  for (const rule of project.rules) {
    if (!rules.some((candidate) => candidate.name === rule.name)) rules.push(rule);
  }

  const defaultModel = project.defaultModel ?? user.defaultModel;
  const defaultThinking = project.defaultThinking ?? user.defaultThinking;
  const interruptNotes = project.interruptNotes ?? user.interruptNotes;

  return {
    ...(defaultModel !== undefined ? { defaultModel } : {}),
    ...(defaultThinking !== undefined ? { defaultThinking } : {}),
    ...(interruptNotes !== undefined ? { interruptNotes } : {}),
    rules,
  };
}

/**
 * Load both config layers fresh from disk (hot reload on every tool call).
 * Never throws: read/parse problems become `fileErrors`.
 */
export function loadRoutingConfig(agentDir: string, cwd: string): LoadedRoutingConfig {
  const { userPath, projectPath } = routingConfigPaths(agentDir, cwd);
  const fileErrors: ConfigFileError[] = [];
  let user: SubagentsConfig | undefined;
  let project: SubagentsConfig | undefined;

  for (const [path, target] of [
    [userPath, "user"] as const,
    [projectPath, "project"] as const,
  ]) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      fileErrors.push({ path, error: `Could not read ${path}: ${(error as Error).message}` });
      continue;
    }

    const parsed = parseSubagentsConfig(text, path);
    if (parsed.error) {
      fileErrors.push({ path, error: parsed.error });
      continue;
    }
    if (target === "user") user = parsed.config;
    else project = parsed.config;
  }

  const config = user || project ? mergeConfigs(user, project) : null;
  return { config, fileErrors, warnings: [], userPath, projectPath };
}
