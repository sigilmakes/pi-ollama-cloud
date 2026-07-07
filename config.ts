/**
 * Configuration loader for pi-ollama-cloud.
 *
 * Reads settings from JSON config files with project-over-global precedence:
 *   - ~/.pi/agent/ollama-cloud.json (global / user-level)
 *   - .pi/ollama-cloud.json        (project-local, takes precedence)
 *
 * Environment variables serve as overrides above both config files:
 *   - PI_OLLAMA_WEB_TOOLS=0  disables web tool registration
 *
 * Example ollama-cloud.json:
 * ```json
 * {
 *   "webTools": false,
 *   "inferenceParams": { "temperature": 0.2 },
 *   "models": { "qwen3-coder:32b": { "temperature": 0.6 } }
 * }
 * ```
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// --- Types ---

/**
 * Sampling / inference parameters injected into the OpenAI-compatible request
 * body via the `before_provider_request` hook. Only keys Ollama Cloud's
 * `/v1/chat/completions` endpoint understands are allowlisted; unknown keys are
 * dropped during sanitization so a typo can't clobber core payload fields
 * (`model`, `messages`, `tools`, `stream`, ...).
 *
 * Numeric options mirror Ollama's Modelfile sampler names. Cloud honors the
 * OpenAI-standard ones (`temperature`, `top_p`, `seed`, `stop`, ...); the
 * Ollama-native ones (`top_k`, `min_p`, `num_predict`, `num_ctx`, ...) are
 * accepted by the compat layer but may be ignored server-side depending on
 * the model. See https://docs.ollama.com/api/openai-compatibility.
 */
export interface InferenceParams {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  typical_p?: number;
  tfs_z?: number;
  repeat_penalty?: number;
  repeat_last_n?: number;
  seed?: number;
  num_predict?: number;
  num_ctx?: number;
  num_gpu?: number;
  num_thread?: number;
  mirostat?: number;
  mirostat_tau?: number;
  mirostat_eta?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  /** Max output tokens. Overrides the model's default maxTokens (32768). */
  max_tokens?: number;
  /** Stop sequence(s). Single string or array of strings. */
  stop?: string | string[];
}

export interface OllamaCloudConfig {
  /** When false, ollama_web_search and ollama_web_fetch tools are not registered. Default: true. */
  webTools?: boolean;
  /**
   * Default inference params applied to every Ollama Cloud model request.
   * Per-model entries in `models` override these per-key.
   */
  inferenceParams?: InferenceParams;
  /**
   * Per-model inference params, keyed by model id (e.g. "qwen3-coder:32b").
   * Merged on top of `inferenceParams` (per-key override) for the active model.
   */
  models?: Record<string, InferenceParams>;
}

// --- Defaults ---

const DEFAULT_CONFIG: OllamaCloudConfig = {
  webTools: true,
};

// --- Validation ---

/** Top-level scalar config keys and their expected JS type string. */
const SCALAR_KEYS: Array<["webTools", "boolean"]> = [["webTools", "boolean"]];

/** Numeric inference-param keys accepted in InferenceParams. */
const NUMERIC_INFERENCE_KEYS = [
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "typical_p",
  "tfs_z",
  "repeat_penalty",
  "repeat_last_n",
  "seed",
  "num_predict",
  "num_ctx",
  "num_gpu",
  "num_thread",
  "mirostat",
  "mirostat_tau",
  "mirostat_eta",
  "frequency_penalty",
  "presence_penalty",
  "max_tokens",
] as const satisfies readonly (keyof InferenceParams)[];

/** Returns true for a finite number (NaN/Infinity rejected — they break the API). */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Returns true for a stop sequence: a string or an array of strings. */
function isStopSequence(v: unknown): v is string | string[] {
  if (typeof v === "string") return true;
  return Array.isArray(v) && v.every((entry) => typeof entry === "string");
}

/**
 * Validate a raw object into an InferenceParams. Unknown keys are silently
 * dropped; values with wrong types are dropped (key omitted, not defaulted).
 */
function sanitizeInferenceParams(raw: Record<string, unknown>): InferenceParams {
  const out: InferenceParams = {};
  for (const key of NUMERIC_INFERENCE_KEYS) {
    if (isFiniteNumber(raw[key])) (out as Record<string, unknown>)[key] = raw[key];
  }
  if (isStopSequence(raw.stop)) out.stop = raw.stop;
  return out;
}

/** Validate a raw object into a per-model map of InferenceParams. */
function sanitizeModels(raw: unknown): Record<string, InferenceParams> | undefined {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, InferenceParams> = {};
  for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (entry != null && typeof entry === "object" && !Array.isArray(entry)) {
      const sanitized = sanitizeInferenceParams(entry as Record<string, unknown>);
      // Keep the entry only if it has at least one valid param.
      if (Object.keys(sanitized).length > 0) out[id] = sanitized;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Validate a parsed JSON object against the known schema.
 * Unknown keys are silently dropped; values with wrong types fall back to undefined.
 */
function sanitizeConfig(raw: Record<string, unknown>): OllamaCloudConfig {
  const out: OllamaCloudConfig = {};
  for (const [key, expectedType] of SCALAR_KEYS) {
    const value = raw[key];
    if (typeof value === expectedType) (out as Record<string, unknown>)[key] = value;
  }
  const ip = raw.inferenceParams;
  if (ip != null && typeof ip === "object" && !Array.isArray(ip)) {
    const sanitized = sanitizeInferenceParams(ip as Record<string, unknown>);
    if (Object.keys(sanitized).length > 0) out.inferenceParams = sanitized;
  }
  out.models = sanitizeModels(raw.models);
  return out;
}

// --- Merging ---

/**
 * Merge two InferenceParams per-key; `override` wins. Undefined inputs are
 * treated as empty so the result only contains explicitly-set keys.
 */
export function mergeInferenceParams(base?: InferenceParams, override?: InferenceParams): InferenceParams {
  return { ...(base ?? {}), ...(override ?? {}) };
}

/**
 * Merge two per-model maps: for each model id, `override`'s entry is merged
 * per-key on top of `base`'s entry; ids only in `base` are kept as-is.
 */
function mergeModelsMap(
  base?: Record<string, InferenceParams>,
  override?: Record<string, InferenceParams>,
): Record<string, InferenceParams> | undefined {
  if (!base && !override) return undefined;
  if (!base) return override;
  if (!override) return base;
  const out: Record<string, InferenceParams> = { ...base };
  for (const [id, params] of Object.entries(override)) {
    out[id] = mergeInferenceParams(out[id], params);
  }
  return out;
}

/**
 * Resolve the effective inference params for a model id by merging the global
 * `inferenceParams` defaults with the per-model entry (per-model wins per-key).
 * Returns an empty object when nothing is configured for that model.
 */
export function resolveInferenceParams(config: OllamaCloudConfig, modelId: string): InferenceParams {
  return mergeInferenceParams(config.inferenceParams, config.models?.[modelId]);
}

// --- Loader ---

/**
 * Load configuration from JSON files.
 * Project-local config overrides global config.
 * Environment variables override both.
 */
export function loadConfig(cwd: string): OllamaCloudConfig {
  const globalPath = join(getAgentDir(), "ollama-cloud.json");
  const projectPath = join(cwd, ".pi", "ollama-cloud.json");

  let globalConfig: OllamaCloudConfig = {};
  let projectConfig: OllamaCloudConfig = {};

  // Load global config
  if (existsSync(globalPath)) {
    try {
      const content = readFileSync(globalPath, "utf-8");
      const parsed = JSON.parse(content);
      // Silently skip files that parse to null, arrays, or primitives —
      // malformed config should not crash the extension (defaults apply).
      if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
        globalConfig = sanitizeConfig(parsed as Record<string, unknown>);
      }
    } catch (err) {
      console.error(`[pi-ollama-cloud] Failed to load config from ${globalPath}: ${err}`);
    }
  }

  // Load project config
  if (existsSync(projectPath)) {
    try {
      const content = readFileSync(projectPath, "utf-8");
      const parsed = JSON.parse(content);
      // Same guard as global config: null/array/primitive parses are ignored.
      if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
        projectConfig = sanitizeConfig(parsed as Record<string, unknown>);
      }
    } catch (err) {
      console.error(`[pi-ollama-cloud] Failed to load config from ${projectPath}: ${err}`);
    }
  }

  // Merge with defaults: defaults < global < project.
  // Scalar keys (webTools) follow the shallow spread; inferenceParams and the
  // per-model map are deep-merged so project-local config extends rather than
  // replaces global defaults (global defaults + project per-model overrides).
  const merged: OllamaCloudConfig = {
    ...DEFAULT_CONFIG,
    ...globalConfig,
    ...projectConfig,
  };
  merged.inferenceParams = mergeInferenceParams(globalConfig.inferenceParams, projectConfig.inferenceParams);
  merged.models = mergeModelsMap(globalConfig.models, projectConfig.models);
  // mergeInferenceParams returns {} when nothing is configured; normalize to
  // undefined so the config object stays clean (matches sanitizeConfig output).
  if (merged.inferenceParams && Object.keys(merged.inferenceParams).length === 0) {
    merged.inferenceParams = undefined;
  }

  // Environment variable overrides (only webTools for now)
  const envOverride = resolveWebToolsEnv();
  if (envOverride !== undefined) {
    merged.webTools = envOverride;
  }

  return merged;
}

/**
 * Resolve the PI_OLLAMA_WEB_TOOLS environment variable override.
 * Returns undefined when not set (no override),
 * true/false when explicitly set.
 */
export function resolveWebToolsEnv(): boolean | undefined {
  const raw = process.env.PI_OLLAMA_WEB_TOOLS;
  if (raw === undefined) return undefined;

  const lowered = raw.toLowerCase();
  if (["0", "false", "no", "off", ""].includes(lowered)) return false;
  // Treat any other non-empty value as "enabled"
  return true;
}
