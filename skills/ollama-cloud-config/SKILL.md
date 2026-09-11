---
name: ollama-cloud-config
description: Configure Ollama Cloud sampling params, context-window caps, and web tools in pi (the coding agent). Use when the user wants to change temperature/top_p per model, cap a model's context window for a project, or enable/disable Ollama web search/fetch tools.
---

# Ollama Cloud config for pi

The pi-ollama-cloud extension reads JSON config from two files, project wins over global:

- Global: `~/.pi/agent/ollama-cloud.json`
- Project: `<project>/.pi/ollama-cloud.json`

Malformed files never crash the extension — unknown keys and wrong-typed values are silently dropped, so a typo just means the setting doesn't apply. There is no error message; check the file if a setting seems ignored.

## Sampling params (per request)

```json
{
  "inferenceParams": { "temperature": 0.2 },
  "models": { "glm-5.3-flash": { "temperature": 0.6, "top_p": 0.9 } }
}
```

- `inferenceParams` applies to every Ollama Cloud model.
- `models` is keyed by model id; per-model keys override `inferenceParams` per-key.
- Allowlisted numeric params: `temperature`, `top_p`, `top_k`, `min_p`, `typical_p`, `tfs_z`, `repeat_penalty`, `repeat_last_n`, `seed`, `num_predict`, `num_ctx`, `num_gpu`, `num_thread`, `mirostat`, `mirostat_tau`, `mirostat_eta`, `frequency_penalty`, `presence_penalty`, `max_tokens`. Also `stop` (string or string[]).
- These are injected into the request body at send time — they don't change what pi believes about the model.

## Context-window / max-output caps (registration)

```json
{
  "modelOverrides": { "glm-5.3": { "contextWindow": 300000, "maxTokens": 32768 } }
}
```

- `contextWindow` is the advertised window pi plans around (compaction triggers relative to it). Cap below the real limit to make pi compact earlier.
- `maxTokens` is the advertised max output tokens.
- Applied at provider registration; re-applied on every `/ollama-cloud-refresh`, so caps survive catalog updates.
- Ids not in the current catalog are ignored.
- **Don't use this to raise a context window above the model's real limit** — pi will overfill and requests will fail server-side.

## Web tools

```json
{ "webTools": false }
```

Disables `ollama_web_search` / `ollama_web_fetch` tool registration. Hard kill switch: env var `PI_OLLAMA_WEB_TOOLS=0` overrides both files.

## Merge rules

Defaults < global < project. `inferenceParams`, `models`, and `modelOverrides` deep-merge per-key across global and project (project wins per key); `webTools` is scalar (project replaces global).

## Verify

Changes take effect on next pi start (or `/reload`). To confirm a cap: `/model ollama-cloud/glm-5.3` then check the status line context indicator, or run `pi models list ollama-cloud` and inspect the advertised window.