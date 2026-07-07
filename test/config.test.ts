import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type OllamaCloudConfig, mergeInferenceParams, resolveInferenceParams } from "../config.ts";

// loadConfig is exercised via the filesystem below. It reads the global path
// from getAgentDir() (controlled by PI_CODING_AGENT_DIR) and the project path
// from `<cwd>/.pi/ollama-cloud.json`.
const { loadConfig } = await import("../config.ts");

let agentDir: string;
let projectDir: string;
let originalAgentDir: string | undefined;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "pi-oc-agent-"));
  projectDir = mkdtempSync(join(tmpdir(), "pi-oc-project-"));
  originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
  if (originalAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

function writeGlobal(json: unknown) {
  writeFileSync(join(agentDir, "ollama-cloud.json"), JSON.stringify(json));
}
function writeProject(json: unknown) {
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  writeFileSync(join(projectDir, ".pi", "ollama-cloud.json"), JSON.stringify(json));
}

// ============================================================================
// sanitizeConfig (via loadConfig): unknown keys / wrong types dropped
// ============================================================================

describe("loadConfig sanitization", () => {
  it("applies defaults when no config files exist", () => {
    const config = loadConfig(projectDir);
    expect(config).toEqual({ webTools: true });
  });

  it("drops unknown top-level keys", () => {
    writeGlobal({ webTools: false, nonsense: true, alsoNonsense: 42 });
    const config = loadConfig(projectDir);
    expect(config).toEqual({ webTools: false });
    expect("nonsense" in config).toBe(false);
  });

  it("drops inference params with wrong types", () => {
    writeGlobal({
      inferenceParams: {
        temperature: "hot", // string -> dropped
        top_p: 0.9, // number -> kept
        seed: NaN, // non-finite -> dropped
        top_k: Infinity, // non-finite -> dropped
        stop: 42, // not string/array -> dropped
        unknownParam: 1, // not allowlisted -> dropped
      },
    });
    const config = loadConfig(projectDir);
    expect(config.inferenceParams).toEqual({ top_p: 0.9 });
  });

  it("accepts stop as a string or array of strings", () => {
    writeGlobal({ inferenceParams: { stop: "</end>" } });
    expect(loadConfig(projectDir).inferenceParams?.stop).toBe("</end>");

    writeGlobal({ inferenceParams: { stop: ["</end>", "</fin>"] } });
    expect(loadConfig(projectDir).inferenceParams?.stop).toEqual(["</end>", "</fin>"]);
  });

  it("drops a models entry that has no valid params", () => {
    writeGlobal({ models: { "qwen3:32b": { temperature: "bad" }, "good-model": { top_p: 0.5 } } });
    const config = loadConfig(projectDir);
    expect(config.models).toEqual({ "good-model": { top_p: 0.5 } });
  });

  it("drops models that is not an object", () => {
    writeGlobal({ models: ["qwen3"] });
    expect(loadConfig(projectDir).models).toBeUndefined();
  });

  it("drops inferenceParams that is not an object", () => {
    writeGlobal({ inferenceParams: "nope" });
    expect(loadConfig(projectDir).inferenceParams).toBeUndefined();
  });

  it("keeps all allowlisted numeric params", () => {
    const params = {
      temperature: 0.5,
      top_p: 0.9,
      top_k: 40,
      min_p: 0.05,
      typical_p: 1,
      tfs_z: 1,
      repeat_penalty: 1.1,
      repeat_last_n: 64,
      seed: 7,
      num_predict: 1024,
      num_ctx: 32768,
      num_gpu: 1,
      num_thread: 4,
      mirostat: 2,
      mirostat_tau: 5,
      mirostat_eta: 0.1,
      frequency_penalty: 0.1,
      presence_penalty: 0.1,
      max_tokens: 8192,
    };
    writeGlobal({ inferenceParams: params });
    expect(loadConfig(projectDir).inferenceParams).toEqual(params);
  });
});

// ============================================================================
// precedence: defaults < global < project (deep-merged for inference params)
// ============================================================================

describe("loadConfig precedence", () => {
  it("project overrides global webTools", () => {
    writeGlobal({ webTools: true });
    writeProject({ webTools: false });
    expect(loadConfig(projectDir).webTools).toBe(false);
  });

  it("project inferenceParams extend (not replace) global inferenceParams per-key", () => {
    writeGlobal({ inferenceParams: { temperature: 0.2, top_p: 0.9 } });
    writeProject({ inferenceParams: { temperature: 0.6 } });
    // top_p from global survives; temperature overridden by project.
    expect(loadConfig(projectDir).inferenceParams).toEqual({ temperature: 0.6, top_p: 0.9 });
  });

  it("project models extend global models (new ids kept, shared ids per-key merged)", () => {
    writeGlobal({
      models: { "qwen3:32b": { temperature: 0.2, top_p: 0.9 }, "deepseek-v4": { seed: 1 } },
    });
    writeProject({ models: { "qwen3:32b": { temperature: 0.6 } } });
    const models = loadConfig(projectDir).models;
    expect(models).toEqual({
      "qwen3:32b": { temperature: 0.6, top_p: 0.9 },
      "deepseek-v4": { seed: 1 },
    });
  });

  it("project-only config works without a global file", () => {
    writeProject({ inferenceParams: { temperature: 0.3 } });
    expect(loadConfig(projectDir).inferenceParams).toEqual({ temperature: 0.3 });
  });
});

// ============================================================================
// mergeInferenceParams / resolveInferenceParams
// ============================================================================

describe("mergeInferenceParams", () => {
  it("returns empty when both inputs are undefined", () => {
    expect(mergeInferenceParams()).toEqual({});
  });

  it("override wins per-key, base survives for other keys", () => {
    expect(mergeInferenceParams({ temperature: 0.2, top_p: 0.9 }, { temperature: 0.6 })).toEqual({
      temperature: 0.6,
      top_p: 0.9,
    });
  });
});

describe("resolveInferenceParams", () => {
  const baseConfig: OllamaCloudConfig = {
    inferenceParams: { temperature: 0.2, top_p: 0.9 },
    models: {
      "qwen3-coder:32b": { temperature: 0.6, top_k: 40 },
      "gpt-oss:120b": { temperature: 0.2 },
    },
  };

  it("returns global defaults for a model with no per-model entry", () => {
    expect(resolveInferenceParams(baseConfig, "unknown-model")).toEqual({ temperature: 0.2, top_p: 0.9 });
  });

  it("merges per-model entry on top of global defaults (per-key override)", () => {
    expect(resolveInferenceParams(baseConfig, "qwen3-coder:32b")).toEqual({
      temperature: 0.6, // per-model wins
      top_p: 0.9, // global survives
      top_k: 40, // per-model only
    });
  });

  it("returns empty when neither global nor per-model is configured", () => {
    expect(resolveInferenceParams({}, "any")).toEqual({});
  });
});