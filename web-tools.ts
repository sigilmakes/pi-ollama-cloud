/**
 * Ollama Cloud web tools: ollama_web_search and ollama_web_fetch.
 *
 * Self-contained module. Depends on:
 *   - models.ts       - only for OLLAMA_BASE URL constant
 *   - pi-coding-agent - ExtensionAPI, ExtensionContext, keyHint, truncateToVisualLines
 *   - pi-tui          - Text, truncateToWidth
 * Does NOT depend on provider registration or model fetching internals.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  keyHint,
  truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { OLLAMA_BASE } from "./models.ts";

// --- Output bounds ---
// Tool results land in model context verbatim and render in the transcript, so
// the model-facing text is capped and the full content spills to disk (the
// built-in tools' truncation convention: cap the text, note the spill path).
const SEARCH_SNIPPET_CHARS = 300;
const FETCH_PREVIEW_CHARS = Number(process.env.PI_OLLAMA_WEB_MAX_PREVIEW) || 4000;

/** Spill full fetch text under the agent cache dir; return its path. */
function spillFetchText(url: string, text: string): string {
  const digest = createHash("sha256").update(url).digest("hex").slice(0, 12);
  const dir = join(getAgentDir(), "cache", "ollama-web-fetches");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${digest}-${Date.now()}.txt`);
  writeFileSync(path, text, "utf-8");
  return path;
}

function truncateSnippet(text: string): string {
  const trimmed = (text ?? "").trim();
  if (trimmed.length <= SEARCH_SNIPPET_CHARS) return trimmed;
  return `${trimmed.slice(0, SEARCH_SNIPPET_CHARS)}…`;
}

// --- Types ---

interface SearchResponse {
  results: Array<{
    title: string;
    url: string;
    content: string;
  }>;
}

interface FetchResponse {
  title: string;
  content: string;
  links: string[];
}

// --- Helpers ---

async function getCloudApiKey(ctx: ExtensionContext): Promise<string | undefined> {
  return (await ctx.modelRegistry.getApiKeyForProvider("ollama-cloud")) ?? process.env.OLLAMA_API_KEY;
}

function noApiKeyError() {
  return {
    content: [
      {
        type: "text" as const,
        text: "Error: No Ollama Cloud API key configured. Set OLLAMA_API_KEY or add to auth.json.",
      },
    ],
    isError: true,
  };
}

// Collapsed result preview: match the built-in bash tool's 5-line convention.
const PREVIEW_LINES = 5;

/**
 * Build a renderResult handler that shows a truncated preview when collapsed
 * and the full output when expanded. Follows the bash tool pattern.
 */
function createRenderResult() {
  return (
    result: { content: Array<{ type: string; text: string }>; isError?: boolean },
    options: { expanded: boolean; isPartial: boolean },
    theme: import("@earendil-works/pi-coding-agent").Theme,
    context: {
      invalidate: () => void;
      lastComponent: import("@earendil-works/pi-tui").Component | undefined;
      state: { cachedWidth?: number; cachedLines?: string[]; cachedSkipped?: number };
    },
  ) => {
    const state = context.state;
    const output = result.content
      .map((c) => c.text)
      .join("")
      .trim();
    const styledOutput = output
      .split("\n")
      .map((line: string) => theme.fg("toolOutput", line))
      .join("\n");

    if (options.expanded || result.isError) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(result.isError ? styledOutput : `\n${styledOutput}`);
      return text;
    }

    return {
      render: (width: number) => {
        if (state.cachedWidth !== width) {
          const preview = truncateToVisualLines(styledOutput, PREVIEW_LINES, width);
          state.cachedLines = preview.visualLines;
          state.cachedSkipped = preview.skippedCount;
          state.cachedWidth = width;
        }
        if (state.cachedSkipped && state.cachedSkipped > 0) {
          const hint =
            theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
            ` ${keyHint("app.tools.expand", "to expand")})`;
          return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
        }
        return ["", ...(state.cachedLines ?? [])];
      },
      invalidate: () => {
        state.cachedWidth = undefined;
        state.cachedLines = undefined;
        state.cachedSkipped = undefined;
      },
    };
  };
}

// --- Registrations ---

export function registerWebSearchTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ollama_web_search",
    label: "Ollama Web Search",
    description:
      "Search the web for real-time information using Ollama Cloud's web search API. " +
      "Returns relevant results with titles, URLs, and content snippets. " +
      "Requires an Ollama Cloud API key.",
    parameters: Type.Object({
      query: Type.String({ description: "The search query to execute" }),
      max_results: Type.Optional(
        Type.Integer({
          description: "Maximum number of search results to return (default: 5, max: 10)",
          default: 5,
          minimum: 1,
          maximum: 10,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const apiKey = await getCloudApiKey(ctx);
      if (!apiKey) return noApiKeyError();

      try {
        const res = await fetch(`${OLLAMA_BASE}/api/web_search`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query: params.query,
            max_results: params.max_results ?? 5,
          }),
          signal,
        });

        if (!res.ok) {
          const errorText = await res.text().catch(() => "");
          if (res.status === 401 || res.status === 403) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    "Ollama Cloud search failed: authentication error. " +
                    "Check your API key in OLLAMA_API_KEY or auth.json.",
                },
              ],
              isError: true,
            };
          }
          if (res.status === 429) {
            return {
              content: [{ type: "text", text: "Ollama Cloud search failed: rate limited. Try again shortly." }],
              isError: true,
            };
          }
          return {
            content: [
              { type: "text", text: `Search API error (status ${res.status}): ${errorText || res.statusText}` },
            ],
            isError: true,
          };
        }

        const data = (await res.json()) as SearchResponse;
        const truncated = data.results.some((r) => (r.content ?? "").trim().length > SEARCH_SNIPPET_CHARS);
        const formatted =
          data.results
            .map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${truncateSnippet(r.content)}`)
            .join("\n\n") +
          (truncated ? "\n\n(Snippets truncated to 300 chars; fetch a result's URL for full content.)" : "");

        return {
          content: [{ type: "text", text: formatted || "No results found." }],
          details: { results: data.results },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Web search failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
    renderCall(args, theme, _context) {
      const display = args.query ? `ollama_web_search("${args.query}")` : "ollama_web_search";
      return new Text(theme.fg("toolTitle", display), 0, 0);
    },
    renderResult: createRenderResult(),
  });
}

export function registerWebFetchTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ollama_web_fetch",
    label: "Ollama Web Fetch",
    description:
      "Fetch and extract text content from a web page URL using Ollama Cloud's web fetch API. " +
      "Returns the page title, main content, and links found on the page. " +
      "Requires an Ollama Cloud API key.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch and extract content from", format: "uri" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const apiKey = await getCloudApiKey(ctx);
      if (!apiKey) return noApiKeyError();

      try {
        const res = await fetch(`${OLLAMA_BASE}/api/web_fetch`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ url: params.url }),
          signal,
        });

        if (!res.ok) {
          const errorText = await res.text().catch(() => "");
          if (res.status === 401 || res.status === 403) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    "Ollama Cloud fetch failed: authentication error. " +
                    "Check your API key in OLLAMA_API_KEY or auth.json.",
                },
              ],
              isError: true,
            };
          }
          if (res.status === 429) {
            return {
              content: [{ type: "text", text: "Ollama Cloud fetch failed: rate limited. Try again shortly." }],
              isError: true,
            };
          }
          return {
            content: [{ type: "text", text: `Fetch API error (status ${res.status}): ${errorText || res.statusText}` }],
            isError: true,
          };
        }

        const data = (await res.json()) as FetchResponse;
        const fullText = data.content ?? "";
        const preview = fullText.slice(0, FETCH_PREVIEW_CHARS);
        const truncated = fullText.length > preview.length;
        const spillPath = fullText.length > 0 ? spillFetchText(params.url, fullText) : undefined;
        const formatted = [
          `Title: ${data.title}`,
          truncated
            ? `(showing first ${FETCH_PREVIEW_CHARS} of ${fullText.length} chars — full text: ${spillPath})`
            : "",
          "Content:",
          preview,
          "",
          `Links found: ${data.links?.length ?? 0}`,
          ...(data.links?.slice(0, 10).map((l) => `  - ${l}`) ?? []),
        ]
          .filter((line) => line !== "")
          .join("\n");

        return {
          content: [{ type: "text", text: formatted }],
          details: { title: data.title, content_chars: fullText.length, content_path: spillPath, links: data.links },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Web fetch failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
    renderCall(args, theme, _context) {
      const display = args.url ? `ollama_web_fetch("${args.url}")` : "ollama_web_fetch";
      return new Text(theme.fg("toolTitle", display), 0, 0);
    },
    renderResult: createRenderResult(),
  });
}
