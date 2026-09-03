import type { ServerOptions } from "./types";
import { crushJsonInText } from "./json-crusher";
import {
  compactLossless,
  isGrepOutput,
  isLogOutput,
  isDiffOutput,
} from "./lossless-compaction";
import { compactDuplicateImports } from "./code-compaction";
import { buildCcrMarker, storeCcrContent } from "./ccr";

/**
 * Default tools to exclude from compression (from Headroom's DEFAULT_EXCLUDE_TOOLS).
 *
 * These tools provide exact content needed for other operations:
 * - Read/Glob/Grep: Exact file contents/search results needed for edits
 * - Write/Edit: Change records that must remain verbatim
 * - WebSearch/WebFetch: Reference data that must stay intact
 *
 * Note: Bash is NOT excluded - its outputs (logs, test results) are ideal
 * compression targets. To protect specific tools from lossy compression,
 * use protect_tool_results or add to exclude_tools.
 */
const DEFAULT_EXCLUDE_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "Write",
  "Edit",
  "WebSearch",
  "WebFetch",
  // Lowercase variants for case-insensitive matching
  "read",
  "glob",
  "grep",
  "write",
  "edit",
  "web_search",
  "web_fetch",
]);

/**
 * Headroom-style compression configuration.
 * Matches Headroom's CompressConfig from headroom/compress.py
 */
export interface CompressionConfig {
  /** Pin first N messages (already cached by provider) - NEVER compress these */
  frozen_message_count?: number;
  /** Don't compress last N messages (active conversation) */
  protect_recent?: number;
  /** Compress user messages (default: false for coding agents) */
  compress_user_messages?: boolean;
  /** Compress system messages (default: true) */
  compress_system_messages?: boolean;
  /** Skip messages below this token count */
  min_tokens_to_compress?: number;
  /**
   * Minimum content length (in chars) for block compression.
   * Below this, overhead exceeds savings. Default: 500 chars.
   */
  min_chars_for_block_compression?: number;
  /** Tool names to exclude from compression (merged with DEFAULT_EXCLUDE_TOOLS) */
  exclude_tools?: string[];
  /**
   * Accuracy guard mode: "strict" = more conservative, undefined = normal
   * In strict mode: higher thresholds, preserve more content
   */
  accuracy_guard?: "strict";
  /**
   * Apply lossless compaction to logs/grep/diff outputs
   * (ANSI strip, run collapse, repeated block folding)
   */
  lossless_compaction?: boolean;
  /** Stop after lossless transforms; skip JSON and whitespace compaction. */
  lossless_only?: boolean;
  /** Enable JSON array/object text compaction. */
  json_compaction?: boolean;
  /** Explicit pipeline mode; defaults to lossless_then_lossy. */
  compression_mode?: "lossless" | "lossless_then_lossy";
  enable_cross_turn_dedup?: boolean;
  ccr_enabled?: boolean;
  ccr_inject_marker?: boolean;
  ccr_min_chars?: number;
  relevance_split?: boolean;
  /**
   * Detect 'analyze'/'review' intent and protect code from compression.
   * When enabled, looks for keywords like "analyze", "review", "debug", "fix"
   * in the most recent user message. If found, preserves code content verbatim
   * so the model has full details for analysis.
   * Default: true (Headroom coding agent default)
   */
  protect_analysis_context?: boolean;
  /**
   * Protect failed tool calls / error outputs (default: true).
   * Error content below error_protection_max_chars stays verbatim.
   * Larger errors still compress (LogCompressor preserves error lines).
   */
  protect_error_outputs?: boolean;
  /**
   * Maximum chars for error protection (default: 8000 ~ 2K tokens).
   * Errors larger than this still get compressed.
   */
  error_protection_max_chars?: number;
  /**
   * Don't compress CODE in last N messages (default: 4).
   * Set 0 to disable. Protects code snippets in recent conversation.
   */
  protect_recent_code?: number;
  /**
   * Preserve custom/workflow XML tags from compression (default: false).
   * When false, entire <tag>content</tag> blocks protected verbatim.
   * When true, only tag markers protected; content can be compressed.
   */
  compress_tagged_content?: boolean;
  /**
   * Bash/shell tool names (case-insensitive) for search detection.
   * Default: ['bash', 'shell', 'local_shell']
   */
  bash_tool_names?: string[];
  /**
   * Compress assistant text blocks (cache-safety trade-off, default: false).
   *
   * Default OFF because compressing assistant content changes the bytes that
   * must match for provider prefix cache hits (Anthropic cache_control,
   * DeepSeek/OpenAI auto-cache). Our compressors are deterministic (no ML),
   * but cache eviction or proxy restart could still affect cache hits.
   *
   * Enable only if:
   * - Backend doesn't honor cache_control, OR
   * - Cache savings are less important than token savings
   */
  compress_assistant_text_blocks?: boolean;
  /**
   * Minimum tokens for a section/block to compress (default: 20).
   * More granular than min_tokens_to_compress (which applies at message level).
   * Blocks below this threshold are skipped even if the message is large.
   */
  min_section_tokens?: number;
  /**
   * Acceptance threshold when context pressure is LOW (default: 1.0).
   * Compression is accepted only if: compressed_size / original_size < min_ratio.
   * - 1.0 = accept ANY compression (any savings)
   * - 0.85 = accept only if ≥15% savings
   * - 0.7 = accept only if ≥30% savings
   * Used to avoid marginal compressions that don't justify overhead.
   */
  min_ratio_relaxed?: number;
  /**
   * Acceptance threshold when context pressure is HIGH (default: 1.0).
   * Same logic as min_ratio_relaxed but applies under memory pressure.
   * Typically same as or lower than min_ratio_relaxed (more aggressive under pressure).
   */
  min_ratio_aggressive?: number;
  /** Remove exact duplicate static imports from large JavaScript or TypeScript blocks. */
  code_aware_import_deduplication?: boolean;
  /** Per-tool overrides for compression safety and thresholds. */
  tool_profiles?: Record<string, ToolCompressionProfile>;
  /** Names of registered external compressors to run after built-in stages. */
  active_external_compressors?: string[];
  log_compaction?: boolean;
  search_compaction?: boolean;
  diff_compaction?: boolean;
}

export interface ToolCompressionProfile {
  protect_error_outputs?: boolean;
  compress_tagged_content?: boolean;
  lossless_compaction?: boolean;
  min_tokens_to_compress?: number;
  min_chars_for_block_compression?: number;
  min_section_tokens?: number;
  code_aware_import_deduplication?: boolean;
}

export type ExternalCompressor = (text: string) => string;
const externalCompressors = new Map<string, ExternalCompressor>();

export function registerExternalCompressor(
  name: string,
  compressor: ExternalCompressor,
): void {
  externalCompressors.set(name.toLowerCase(), compressor);
}

export function loadExternalCompressors(paths: string[]): string[] {
  const loaded: string[] = [];
  for (const path of paths) {
    try {
      const moduleValue = require(path) as {
        name?: unknown;
        compress?: unknown;
        default?: { name?: unknown; compress?: unknown };
      };
      const plugin = moduleValue.default ?? moduleValue;
      if (
        typeof plugin.name === "string" &&
        typeof plugin.compress === "function"
      ) {
        registerExternalCompressor(
          plugin.name,
          plugin.compress as ExternalCompressor,
        );
        loaded.push(plugin.name);
      }
    } catch {
      // Invalid plugin modules must not prevent proxy startup.
    }
  }
  return loaded;
}

const DEFAULT_CONFIG: Required<CompressionConfig> = {
  frozen_message_count: 0,
  protect_recent: 0, // Compress the current user turn; preserve cacheable assistant history
  compress_user_messages: true,
  compress_system_messages: true,
  min_tokens_to_compress: 250, // Headroom default
  min_chars_for_block_compression: 500, // Headroom default (overhead vs savings)
  exclude_tools: [], // No extra exclusions (DEFAULT_EXCLUDE_TOOLS always applied)
  accuracy_guard: undefined as any, // Normal mode
  lossless_compaction: true, // Enable by default (safe + effective)
  lossless_only: false,
  json_compaction: true,
  compression_mode: "lossless_then_lossy",
  enable_cross_turn_dedup: false,
  ccr_enabled: false,
  ccr_inject_marker: true,
  ccr_min_chars: 10000,
  relevance_split: false,
  protect_analysis_context: true, // Headroom default for coding agents
  protect_error_outputs: true, // Preserve error content (Headroom default)
  error_protection_max_chars: 8000, // ~2K tokens (Headroom default)
  protect_recent_code: 4, // Don't compress code in last 4 messages
  compress_tagged_content: false, // Protect entire XML blocks by default
  bash_tool_names: ["bash", "shell", "local_shell"], // Shell tool detection
  compress_assistant_text_blocks: false, // Cache safety (Headroom default)
  min_section_tokens: 20, // Headroom default for section-level threshold
  min_ratio_relaxed: 1.0, // Accept any compression (no savings floor)
  min_ratio_aggressive: 1.0, // Same under pressure (Headroom default)
  code_aware_import_deduplication: true,
  tool_profiles: {},
  active_external_compressors: [],
  log_compaction: true,
  search_compaction: true,
  diff_compaction: true,
};

// Deduplication cache: content hash → compressed version
const contentCache = new Map<string, string>();

/**
 * Check if a tool name is excluded from compression.
 */
function isToolExcluded(
  toolName: string | undefined,
  excludeTools: Set<string>,
): boolean {
  if (!toolName) return false;

  // Direct match (case-sensitive)
  if (excludeTools.has(toolName)) return true;

  // Case-insensitive match
  const lowerName = toolName.toLowerCase();
  for (const excluded of excludeTools) {
    if (excluded.toLowerCase() === lowerName) return true;
  }

  // Underscore/camelCase variants (e.g., "WebSearch" matches "web_search")
  const snakeCase = toolName
    .replace(/([A-Z])/g, "_$1")
    .toLowerCase()
    .replace(/^_/, "");
  if (excludeTools.has(snakeCase)) return true;

  return false;
}

/**
 * Detect tool name from message metadata or content.
 * Supports OpenAI function_call, Anthropic tool_use, etc.
 */
function detectToolName(message: Record<string, unknown>): string | undefined {
  // OpenAI function_call
  if (message.function_call && isRecord(message.function_call)) {
    return String(message.function_call.name || "");
  }

  // OpenAI tool_calls array
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    const firstCall = message.tool_calls[0];
    if (
      isRecord(firstCall) &&
      firstCall.function &&
      isRecord(firstCall.function)
    ) {
      return String(firstCall.function.name || "");
    }
  }

  // Anthropic content blocks with tool_use
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (isRecord(block) && block.type === "tool_use" && block.name) {
        return String(block.name);
      }
    }
  }

  // Tool role message with name
  if (message.role === "tool" && message.name) {
    return String(message.name);
  }

  return undefined;
}

/**
 * Check if content has strong error indicators.
 * Error content should be preserved verbatim (if below size threshold).
 */
function hasErrorIndicators(text: string): boolean {
  const lowerText = text.toLowerCase();
  const errorKeywords = [
    "error:",
    "exception:",
    "fatal:",
    "failure:",
    "failed:",
    "traceback",
    "stack trace",
    "segmentation fault",
    "core dumped",
    "panic:",
    "assertion failed",
  ];

  return errorKeywords.some((keyword) => lowerText.includes(keyword));
}

/**
 * Detect if user wants to analyze/review code (Headroom's protect_analysis_context).
 *
 * Looks at the most recent user message for analysis keywords like:
 * - analyze, review, audit, inspect
 * - debug, fix, error, bug
 * - explain, understand, refactor
 *
 * When detected, code content should be preserved verbatim for analysis.
 */
function detectAnalysisIntent(
  messages: Array<Record<string, unknown>>,
): boolean {
  const analysisKeywords = [
    "analyze",
    "analyse",
    "review",
    "audit",
    "inspect",
    "security",
    "vulnerability",
    "bug",
    "issue",
    "problem",
    "explain",
    "understand",
    "how does",
    "what does",
    "debug",
    "fix",
    "error",
    "wrong",
    "broken",
    "refactor",
    "improve",
    "optimize",
    "clean up",
  ];

  // Find most recent user message
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isRecord(message)) continue;

    if (message.role === "user") {
      const content = message.content;
      if (typeof content === "string") {
        const contentLower = content.toLowerCase();
        for (const keyword of analysisKeywords) {
          if (contentLower.includes(keyword)) {
            return true;
          }
        }
      }
      break; // Only check most recent user message
    }
  }

  return false;
}

/**
 * Detect if content looks like source code.
 * Simple heuristic: check for common code indicators.
 */
function isSourceCode(text: string): boolean {
  // Check for code markers
  if (text.includes("```")) return true; // Markdown code blocks

  // Check for common programming patterns
  const codePatterns = [
    /^\s*(function|class|def|const|let|var|import|export)\s+/m,
    /^\s*(public|private|protected|static)\s+/m,
    /\{[\s\S]*\}/m, // Curly braces (common in many languages)
    /^\s*\/\/|^\s*\/\*|^\s*\*/m, // Comments
    /^#include|^using namespace/m, // C/C++
    /^\s*@(override|interface|component)/im, // Decorators
  ];

  for (const pattern of codePatterns) {
    if (pattern.test(text)) return true;
  }

  // Check for high density of code-like characters
  const codeChars = (text.match(/[{}()\[\];=<>]/g) || []).length;
  const density = codeChars / Math.max(text.length, 1);
  if (density > 0.05) return true; // 5% threshold

  return false;
}

/**
 * Check if a tool is a bash/shell tool.
 */
function isBashTool(
  toolName: string | undefined,
  bashToolNames: string[],
): boolean {
  if (!toolName) return false;
  const lowerName = toolName.toLowerCase();
  return bashToolNames.some((name) => name.toLowerCase() === lowerName);
}

/**
 * Protect custom XML tags from compression (Headroom's tag_protector).
 *
 * Replaces <custom-tag>content</custom-tag> with placeholders,
 * returns cleaned text and protected blocks for restoration.
 */
function protectTags(
  text: string,
  compressTaggedContent: boolean,
): {
  cleanedText: string;
  protectedBlocks: Array<{
    placeholder: string;
    original: string;
    closing?: string;
  }>;
} {
  const protectedBlocks: Array<{
    placeholder: string;
    original: string;
    closing?: string;
  }> = [];
  let cleanedText = text;
  let placeholderIndex = 0;

  // Known HTML tags to skip (not custom)
  const knownHtmlTags = new Set([
    "div",
    "span",
    "p",
    "a",
    "img",
    "table",
    "tr",
    "td",
    "th",
    "ul",
    "ol",
    "li",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "strong",
    "em",
    "code",
    "pre",
    "blockquote",
    "body",
    "head",
    "html",
    "meta",
    "link",
    "script",
    "style",
  ]);

  // Find custom tags (non-HTML)
  // Pattern: <tag>content</tag> or <tag/>
  const tagPattern = /<(\w+)(?:\s[^>]*)?>[\s\S]*?<\/\1>|<(\w+)(?:\s[^>]*)?\/>/g;

  let match;
  while ((match = tagPattern.exec(text)) !== null) {
    const tagName = (match[1] || match[2]).toLowerCase();

    // Skip known HTML tags
    if (knownHtmlTags.has(tagName)) continue;

    const fullMatch = match[0];
    const placeholder = `{{HEADROOM_TAG_${placeholderIndex++}}}`;

    if (compressTaggedContent) {
      // Only protect tag markers, expose content
      // Extract content between tags
      const contentMatch = fullMatch.match(/<\w+(?:\s[^>]*)?>(.+)<\/\w+>/s);
      if (contentMatch) {
        const content = contentMatch[1];
        const tagStart = fullMatch.substring(0, fullMatch.indexOf(content));
        const tagEnd = fullMatch.substring(
          fullMatch.indexOf(content) + content.length,
        );
        protectedBlocks.push({
          placeholder,
          original: tagStart,
          closing: tagEnd,
        });
        cleanedText = cleanedText.replace(
          fullMatch,
          placeholder + content + `${placeholder}_END`,
        );
      } else {
        // Self-closing tag
        protectedBlocks.push({ placeholder, original: fullMatch });
        cleanedText = cleanedText.replace(fullMatch, placeholder);
      }
    } else {
      // Protect entire block verbatim
      protectedBlocks.push({ placeholder, original: fullMatch });
      cleanedText = cleanedText.replace(fullMatch, placeholder);
    }
  }

  return { cleanedText, protectedBlocks };
}

/**
 * Restore protected tags after compression.
 */
function restoreTags(
  text: string,
  protectedBlocks: Array<{
    placeholder: string;
    original: string;
    closing?: string;
  }>,
): string {
  let restored = text;
  for (const block of protectedBlocks) {
    restored = restored.replace(block.placeholder, block.original);
    if (block.closing) {
      restored = restored.replace(`${block.placeholder}_END`, block.closing);
    }
  }
  return restored;
}

/**
 * Apply compression to text content with full Headroom pipeline.
 */
function compressText(
  text: string,
  config: Required<CompressionConfig>,
  toolName?: string,
  relevanceQuery?: string,
): string {
  const toolConfig = resolveToolConfig(config, toolName);
  // Basic whitespace normalization is safe for short plain-text messages.
  const normalizedText = compactText(text);
  if (text.length < toolConfig.min_chars_for_block_compression) {
    return normalizedText;
  }

  if (
    config.ccr_enabled &&
    config.ccr_inject_marker &&
    text.length >= config.ccr_min_chars
  ) {
    return buildCcrMarker(storeCcrContent(text));
  }

  const estimatedTokens = estimateTokens(text);
  if (estimatedTokens < toolConfig.min_tokens_to_compress) {
    return text;
  }

  const sections = text.split(/(\n{2,})/);
  if (sections.length > 1) {
    const relevanceTerms = config.relevance_split
      ? tokenizeRelevanceQuery(relevanceQuery)
      : [];
    return sections
      .map((section) =>
        /^\n+$/.test(section) ||
        estimateTokens(section) < toolConfig.min_section_tokens
          ? section
          : relevanceTerms.length > 0 &&
              hasRelevantTerm(section, relevanceTerms)
            ? section
            : compressTextBlock(section, toolConfig, toolName),
      )
      .join("");
  }

  return compressTextBlock(text, toolConfig, toolName);
}

function tokenizeRelevanceQuery(query: string | undefined): string[] {
  return (query ?? "")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((term) => term.length >= 3)
    .slice(0, 50);
}

function hasRelevantTerm(text: string, terms: string[]): boolean {
  const lowerText = text.toLowerCase();
  return terms.some((term) => lowerText.includes(term));
}

function latestUserText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      isRecord(message) &&
      message.role === "user" &&
      typeof message.content === "string"
    ) {
      return message.content;
    }
  }
  return "";
}

function resolveToolConfig(
  config: Required<CompressionConfig>,
  toolName?: string,
): Required<CompressionConfig> {
  if (!toolName) return config;
  const profile = Object.entries(config.tool_profiles).find(
    ([name]) => name.toLowerCase() === toolName.toLowerCase(),
  )?.[1];
  return profile ? { ...config, ...profile } : config;
}

function compressTextBlock(
  text: string,
  config: Required<CompressionConfig>,
  toolName?: string,
): string {
  // Check deduplication cache
  const contentHash = JSON.stringify({
    text,
    compress_tagged_content: config.compress_tagged_content,
    protect_error_outputs: config.protect_error_outputs,
    error_protection_max_chars: config.error_protection_max_chars,
    code_aware_import_deduplication: config.code_aware_import_deduplication,
    min_section_tokens: config.min_section_tokens,
    min_ratio_relaxed: config.min_ratio_relaxed,
    accuracy_guard: config.accuracy_guard,
    lossless_compaction: config.lossless_compaction,
    lossless_only: config.lossless_only,
    compression_mode: config.compression_mode,
  });
  if (contentCache.has(contentHash)) {
    return contentCache.get(contentHash)!;
  }

  // Preserve error content below size threshold (Headroom's protect_error_outputs)
  if (config.protect_error_outputs && hasErrorIndicators(text)) {
    if (text.length <= config.error_protection_max_chars) {
      return text; // Small errors preserved verbatim
    }
    // Large errors still compress (but LogCompressor preserves error lines)
  }

  let compressed = text;

  if (config.code_aware_import_deduplication && isSourceCode(text)) {
    const compactedCode = compactDuplicateImports(text);
    if (compactedCode.length < compressed.length) {
      compressed = compactedCode;
    }
  }

  // Step 0: Protect custom XML tags if needed (Headroom's tag_protector)
  let protectedBlocks: Array<{
    placeholder: string;
    original: string;
    closing?: string;
  }> = [];
  if (text.includes("<") && text.includes(">")) {
    const tagResult = protectTags(text, config.compress_tagged_content);
    compressed = tagResult.cleanedText;
    protectedBlocks = tagResult.protectedBlocks;
  }

  // Step 1: Apply lossless compaction for logs/grep/diffs
  if (config.lossless_compaction) {
    const isSearchOutput = isGrepOutput(compressed);
    const isLog =
      isBashTool(toolName, config.bash_tool_names) || isLogOutput(compressed);
    const isDiff = isDiffOutput(compressed);
    if (
      (config.search_compaction && isSearchOutput) ||
      (config.log_compaction && isLog) ||
      (config.diff_compaction && isDiff)
    ) {
      const lossless = compactLossless(compressed);
      if (lossless.length < compressed.length) {
        compressed = lossless;
      }
    }
    if (config.lossless_only || config.compression_mode === "lossless") {
      const losslessResult =
        compressed.length < text.length ? compressed : text;
      contentCache.set(contentHash, losslessResult);
      return losslessResult;
    }
  }

  for (const name of config.active_external_compressors) {
    const compressor = externalCompressors.get(name.toLowerCase());
    if (!compressor) continue;
    try {
      const candidate = compressor(compressed);
      if (
        typeof candidate === "string" &&
        candidate.length < compressed.length
      ) {
        compressed = candidate;
      }
    } catch {
      // Plugin failures must not break request optimization.
    }
  }

  // Step 2: JSON array crushing (SmartCrusher)
  if (config.json_compaction) {
    const crushResult = crushJsonInText(compressed);
    if (crushResult.crushed) {
      compressed = crushResult.text;
    }
  }

  // Step 3: Aggressive text compaction
  compressed = compactText(compressed);

  // Step 4: Restore protected XML tags
  if (protectedBlocks.length > 0) {
    compressed = restoreTags(compressed, protectedBlocks);
  }

  // Step 5: Check min_ratio acceptance threshold (Headroom's min_ratio gates)
  // Calculate compression ratio: compressed / original
  const compressionRatio = compressed.length / text.length;

  // Use relaxed threshold by default (could be enhanced to detect context pressure)
  const minRatio = config.min_ratio_relaxed;

  // Only accept compression if ratio < threshold (i.e., meaningful savings)
  if (compressionRatio >= minRatio) {
    compressed = text; // Reject compression - savings too small
  }

  // In strict accuracy mode, additional 20% savings requirement
  if (config.accuracy_guard === "strict") {
    const savingsPercent =
      ((text.length - compressed.length) / text.length) * 100;
    if (savingsPercent < 20) {
      compressed = text; // Revert to original
    }
  }

  // Cache the result
  contentCache.set(contentHash, compressed);
  return compressed;
}

export function optimizePayload(
  route: string,
  body: unknown,
  options?: Pick<ServerOptions, "enableOptimization"> &
    Partial<
      Pick<
        ServerOptions,
        | "compressAssistantTextBlocks"
        | "compressUserMessages"
        | "compressSystemMessages"
        | "minCompressionRatioRelaxed"
        | "minCompressionRatioAggressive"
        | "minTokensToCompress"
        | "minCharsForBlockCompression"
        | "minSectionTokens"
        | "frozenMessageCount"
        | "protectRecentMessages"
        | "protectRecentCode"
        | "protectErrorOutputs"
        | "errorProtectionMaxChars"
        | "compressTaggedContent"
        | "excludeTools"
        | "losslessCompaction"
        | "losslessOnly"
        | "compressionMode"
        | "enableCrossTurnDedup"
        | "ccrEnabled"
        | "ccrInjectMarker"
        | "ccrMinChars"
        | "relevanceSplit"
        | "strictAccuracyGuard"
        | "protectAnalysisContext"
        | "codeAwareImportDeduplication"
        | "toolProfiles"
        | "bashToolNames"
        | "activeExternalCompressors"
        | "logCompaction"
        | "searchCompaction"
        | "diffCompaction"
        | "jsonCompaction"
      >
    >,
  config?: CompressionConfig,
): unknown {
  if (options?.enableOptimization === false) {
    return body;
  }

  const cfg = {
    ...DEFAULT_CONFIG,
    ...(options?.compressAssistantTextBlocks === true
      ? { compress_assistant_text_blocks: true }
      : {}),
    ...(options?.compressUserMessages !== undefined
      ? { compress_user_messages: options.compressUserMessages }
      : {}),
    ...(options?.compressSystemMessages !== undefined
      ? { compress_system_messages: options.compressSystemMessages }
      : {}),
    ...(options?.minCompressionRatioRelaxed !== undefined
      ? { min_ratio_relaxed: options.minCompressionRatioRelaxed }
      : {}),
    ...(options?.minCompressionRatioAggressive !== undefined
      ? { min_ratio_aggressive: options.minCompressionRatioAggressive }
      : {}),
    ...(options?.minTokensToCompress !== undefined
      ? { min_tokens_to_compress: options.minTokensToCompress }
      : {}),
    ...(options?.minCharsForBlockCompression !== undefined
      ? { min_chars_for_block_compression: options.minCharsForBlockCompression }
      : {}),
    ...(options?.minSectionTokens !== undefined
      ? { min_section_tokens: options.minSectionTokens }
      : {}),
    ...(options?.frozenMessageCount !== undefined
      ? { frozen_message_count: options.frozenMessageCount }
      : {}),
    ...(options?.protectRecentMessages !== undefined
      ? { protect_recent: options.protectRecentMessages }
      : {}),
    ...(options?.protectRecentCode !== undefined
      ? { protect_recent_code: options.protectRecentCode }
      : {}),
    ...(options?.protectErrorOutputs !== undefined
      ? { protect_error_outputs: options.protectErrorOutputs }
      : {}),
    ...(options?.errorProtectionMaxChars !== undefined
      ? { error_protection_max_chars: options.errorProtectionMaxChars }
      : {}),
    ...(options?.compressTaggedContent !== undefined
      ? { compress_tagged_content: options.compressTaggedContent }
      : {}),
    ...(options?.excludeTools !== undefined
      ? { exclude_tools: options.excludeTools }
      : {}),
    ...(options?.losslessCompaction !== undefined
      ? { lossless_compaction: options.losslessCompaction }
      : {}),
    ...(options?.losslessOnly !== undefined
      ? { lossless_only: options.losslessOnly }
      : {}),
    ...(options?.compressionMode !== undefined
      ? { compression_mode: options.compressionMode }
      : {}),
    ...(options?.enableCrossTurnDedup !== undefined
      ? { enable_cross_turn_dedup: options.enableCrossTurnDedup }
      : {}),
    ...(options?.ccrEnabled !== undefined
      ? { ccr_enabled: options.ccrEnabled }
      : {}),
    ...(options?.ccrInjectMarker !== undefined
      ? { ccr_inject_marker: options.ccrInjectMarker }
      : {}),
    ...(options?.ccrMinChars !== undefined
      ? { ccr_min_chars: options.ccrMinChars }
      : {}),
    ...(options?.relevanceSplit !== undefined
      ? { relevance_split: options.relevanceSplit }
      : {}),
    ...(options?.strictAccuracyGuard === true
      ? { accuracy_guard: "strict" as const }
      : {}),
    ...(options?.protectAnalysisContext !== undefined
      ? { protect_analysis_context: options.protectAnalysisContext }
      : {}),
    ...(options?.codeAwareImportDeduplication !== undefined
      ? {
          code_aware_import_deduplication: options.codeAwareImportDeduplication,
        }
      : {}),
    ...(options?.toolProfiles !== undefined
      ? { tool_profiles: options.toolProfiles }
      : {}),
    ...(options?.bashToolNames !== undefined
      ? { bash_tool_names: options.bashToolNames }
      : {}),
    ...(options?.activeExternalCompressors !== undefined
      ? { active_external_compressors: options.activeExternalCompressors }
      : {}),
    ...(options?.logCompaction !== undefined
      ? { log_compaction: options.logCompaction }
      : {}),
    ...(options?.searchCompaction !== undefined
      ? { search_compaction: options.searchCompaction }
      : {}),
    ...(options?.diffCompaction !== undefined
      ? { diff_compaction: options.diffCompaction }
      : {}),
    ...(options?.jsonCompaction !== undefined
      ? { json_compaction: options.jsonCompaction }
      : {}),
    ...config,
  };
  const deduplicatedBody = deduplicateToolSchemas(body);

  if (route === "/v1/chat/completions") {
    return optimizeChatCompletionsBody(deduplicatedBody, cfg);
  }
  if (route === "/v1/responses") {
    return optimizeResponsesBody(deduplicatedBody, cfg);
  }
  if (route === "/v1/messages") {
    return optimizeMessagesBody(deduplicatedBody, cfg);
  }
  return deduplicatedBody;
}

function deduplicateToolSchemas(body: unknown): unknown {
  if (!isRecord(body)) {
    return body;
  }

  const next: Record<string, unknown> = { ...body };
  for (const key of ["tools", "functions"]) {
    const tools = body[key];
    if (!Array.isArray(tools)) {
      continue;
    }
    const seen = new Set<string>();
    next[key] = tools.filter((tool) => {
      const fingerprint = canonicalJson(tool);
      if (seen.has(fingerprint)) {
        return false;
      }
      seen.add(fingerprint);
      return true;
    });
  }
  return next;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function optimizeChatCompletionsBody(
  body: unknown,
  config: Required<CompressionConfig>,
): unknown {
  if (!isRecord(body)) {
    return body;
  }

  const next: Record<string, unknown> = { ...body };
  if (!Array.isArray(body.messages)) {
    return next;
  }

  const messages = body.messages;
  const totalMessages = messages.length;

  // Merge user-provided exclude tools with defaults
  const excludeTools = new Set([
    ...DEFAULT_EXCLUDE_TOOLS,
    ...config.exclude_tools,
  ]);

  // Detect analysis intent (protect_analysis_context)
  const analysisIntent = config.protect_analysis_context
    ? detectAnalysisIntent(messages)
    : false;
  const relevanceQuery = config.relevance_split
    ? latestUserText(messages)
    : undefined;

  // Determine message protection zones
  const frozenCount = Math.max(
    Math.min(config.frozen_message_count, totalMessages),
    cacheAnchoredPrefixLength(messages),
  );
  const recentStart = Math.max(0, totalMessages - config.protect_recent);

  // Determine code protection zone (protect_recent_code)
  const codeProtectionStart = Math.max(
    0,
    totalMessages - config.protect_recent_code,
  );
  const seenTurnContent = new Set<string>();

  next.messages = messages.map((message, index) => {
    if (!isRecord(message)) {
      return message;
    }

    // Zone 1: Frozen prefix (already cached by provider) - return verbatim
    if (index < frozenCount) {
      return message;
    }

    // Zone 2: Protected recent messages (active conversation) - return verbatim
    if (index >= recentStart) {
      return message;
    }

    // Zone 3: Compressible middle zone
    const role = message.role;
    const messageCopy: Record<string, unknown> = { ...message };
    const content = message.content;

    // Role-based compression control
    if (role === "user" && !config.compress_user_messages) {
      return message; // Skip user messages by default (Headroom coding agent mode)
    }

    if (role === "system" && !config.compress_system_messages) {
      return message;
    }

    // Assistant messages: check compress_assistant_text_blocks (cache safety)
    if (role === "assistant" && !config.compress_assistant_text_blocks) {
      return message; // Preserve assistant content for cache hits (default)
    }

    // Detect tool name and check exclusion
    const toolName = detectToolName(message);
    if (toolName && isToolExcluded(toolName, excludeTools)) {
      return message; // Skip excluded tools
    }

    // String content
    if (typeof content === "string") {
      // Check protect_recent_code: don't compress code in last N messages
      if (config.protect_recent_code > 0 && index >= codeProtectionStart) {
        if (isSourceCode(content)) {
          return message; // Protect recent code
        }
      }

      // Protection: Don't compress CODE when analysis intent detected
      if (analysisIntent && isSourceCode(content)) {
        return message; // Preserve code verbatim for analysis
      }

      if (config.enable_cross_turn_dedup && content.length >= 500) {
        if (seenTurnContent.has(content)) {
          messageCopy.content =
            "[Repeated content appears earlier in this conversation.]";
          return messageCopy;
        }
        seenTurnContent.add(content);
      }

      messageCopy.content = compressText(
        content,
        config,
        toolName,
        relevanceQuery,
      );
      return messageCopy;
    }

    // Array content (OpenAI multi-part messages)
    if (Array.isArray(content)) {
      messageCopy.content = content.map((part) => {
        if (!isRecord(part)) {
          return part;
        }
        const partCopy: Record<string, unknown> = { ...part };
        if (typeof part.text === "string") {
          // Check protect_recent_code
          if (config.protect_recent_code > 0 && index >= codeProtectionStart) {
            if (isSourceCode(part.text)) {
              return part;
            }
          }

          // Protection: Don't compress CODE when analysis intent detected
          if (analysisIntent && isSourceCode(part.text)) {
            return part; // Preserve code verbatim for analysis
          }

          partCopy.text = compressText(part.text, config, toolName);
        }
        return partCopy;
      });
    }

    return messageCopy;
  });

  return next;
}

function optimizeResponsesBody(
  body: unknown,
  config: Required<CompressionConfig>,
): unknown {
  if (!isRecord(body)) {
    return body;
  }

  const next: Record<string, unknown> = { ...body };
  const input = body.input;

  const excludeTools = new Set([
    ...DEFAULT_EXCLUDE_TOOLS,
    ...config.exclude_tools,
  ]);

  // Single string input
  if (typeof input === "string") {
    next.input = compressText(input, config);
    return next;
  }

  // Array input
  if (!Array.isArray(input)) {
    return next;
  }

  const totalItems = input.length;
  const frozenCount = Math.max(
    Math.min(config.frozen_message_count, totalItems),
    cacheAnchoredPrefixLength(input),
  );
  const recentStart = Math.max(0, totalItems - config.protect_recent);
  const relevanceQuery = config.relevance_split
    ? (input
        .filter(isRecord)
        .reverse()
        .find(
          (item) => item.role === "user" && typeof item.content === "string",
        )?.content as string | undefined)
    : undefined;
  const seenTurnContent = new Set<string>();

  next.input = input.map((item, index) => {
    // Frozen or recent zones - return verbatim
    if (index < frozenCount || index >= recentStart) {
      return item;
    }

    if (!isRecord(item)) {
      return item;
    }

    const itemCopy: Record<string, unknown> = { ...item };
    const toolName = detectToolName(item);

    // Skip excluded tools
    if (toolName && isToolExcluded(toolName, excludeTools)) {
      return item;
    }

    // Compress text field
    if (typeof item.text === "string") {
      if (config.enable_cross_turn_dedup && item.text.length >= 500) {
        if (seenTurnContent.has(item.text)) {
          itemCopy.text =
            "[Repeated content appears earlier in this conversation.]";
          return itemCopy;
        }
        seenTurnContent.add(item.text);
      }
      itemCopy.text = compressText(item.text, config, toolName, relevanceQuery);
    }

    // Compress content array
    if (Array.isArray(item.content)) {
      itemCopy.content = item.content.map((part) => {
        if (!isRecord(part)) {
          return part;
        }
        const partCopy: Record<string, unknown> = { ...part };
        if (typeof part.text === "string") {
          if (config.enable_cross_turn_dedup && part.text.length >= 500) {
            if (seenTurnContent.has(part.text)) {
              partCopy.text =
                "[Repeated content appears earlier in this conversation.]";
              return partCopy;
            }
            seenTurnContent.add(part.text);
          }
          partCopy.text = compressText(
            part.text,
            config,
            toolName,
            relevanceQuery,
          );
        }
        return partCopy;
      });
    }
    return itemCopy;
  });

  return next;
}

function optimizeMessagesBody(
  body: unknown,
  config: Required<CompressionConfig>,
): unknown {
  if (!isRecord(body)) {
    return body;
  }

  const next: Record<string, unknown> = { ...body };
  if (!Array.isArray(body.messages)) {
    return next;
  }

  const messages = body.messages;
  const totalMessages = messages.length;
  const frozenCount = Math.max(
    Math.min(config.frozen_message_count, totalMessages),
    cacheAnchoredPrefixLength(messages),
  );
  const recentStart = Math.max(0, totalMessages - config.protect_recent);
  const codeProtectionStart = Math.max(
    0,
    totalMessages - config.protect_recent_code,
  );

  const excludeTools = new Set([
    ...DEFAULT_EXCLUDE_TOOLS,
    ...config.exclude_tools,
  ]);

  // Detect analysis intent (protect_analysis_context)
  const analysisIntent = config.protect_analysis_context
    ? detectAnalysisIntent(messages)
    : false;
  const relevanceQuery = config.relevance_split
    ? latestUserText(messages)
    : undefined;

  next.messages = messages.map((message, index) => {
    // Frozen or recent zones - return verbatim
    if (index < frozenCount || index >= recentStart) {
      return message;
    }

    if (!isRecord(message)) {
      return message;
    }

    const role = message.role;
    const messageCopy: Record<string, unknown> = { ...message };
    const content = message.content;

    // Role-based compression control
    if (role === "user" && !config.compress_user_messages) {
      return message;
    }

    if (role === "system" && !config.compress_system_messages) {
      return message;
    }

    // Assistant messages: check compress_assistant_text_blocks (cache safety)
    if (role === "assistant" && !config.compress_assistant_text_blocks) {
      return message;
    }

    // Detect tool name and check exclusion
    const toolName = detectToolName(message);
    if (toolName && isToolExcluded(toolName, excludeTools)) {
      return message;
    }

    // String content
    if (typeof content === "string") {
      // protect_recent_code
      if (config.protect_recent_code > 0 && index >= codeProtectionStart) {
        if (isSourceCode(content)) {
          return message;
        }
      }

      // Protection: Don't compress CODE when analysis intent detected
      if (analysisIntent && isSourceCode(content)) {
        return message; // Preserve code verbatim for analysis
      }

      messageCopy.content = compressText(
        content,
        config,
        toolName,
        relevanceQuery,
      );
      return messageCopy;
    }

    // Array content (Anthropic content blocks)
    if (Array.isArray(content)) {
      messageCopy.content = content.map((part) => {
        if (!isRecord(part)) {
          return part;
        }

        const partCopy: Record<string, unknown> = { ...part };
        if (typeof part.text === "string") {
          // protect_recent_code
          if (config.protect_recent_code > 0 && index >= codeProtectionStart) {
            if (isSourceCode(part.text)) {
              return part;
            }
          }

          // Protection: Don't compress CODE when analysis intent detected
          if (analysisIntent && isSourceCode(part.text)) {
            return part; // Preserve code verbatim for analysis
          }

          partCopy.text = compressText(part.text, config, toolName);
        }
        return partCopy;
      });
    }

    return messageCopy;
  });

  return next;
}

function cacheAnchoredPrefixLength(items: unknown[]): number {
  let lastAnchor = -1;
  for (let index = 0; index < items.length; index += 1) {
    if (containsCacheControl(items[index])) {
      lastAnchor = index;
    }
  }
  return lastAnchor + 1;
}

function containsCacheControl(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsCacheControl);
  }
  if (!isRecord(value)) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(value, "cache_control")) {
    return true;
  }
  return Object.values(value).some(containsCacheControl);
}

/**
 * Simple token estimation: ~4 characters per token (GPT-4 average)
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Fast content hash for deduplication (FNV-1a 32-bit)
 */
function simpleHash(text: string): string {
  let hash = 2166136261; // FNV offset basis
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619); // FNV prime
  }
  return (hash >>> 0).toString(36); // Convert to base36 string
}

function compactText(value: string): string {
  // Aggressive Headroom-style compression
  return (
    value
      // Normalize line endings
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      // Remove trailing whitespace from each line
      .replace(/[ \t]+$/gm, "")
      // Collapse tabs and multiple spaces to single space
      .replace(/[ \t]{2,}/g, " ")
      // Collapse excessive newlines (4+ → 2, 3 → 2)
      .replace(/\n{3,}/g, "\n\n")
      // Remove spaces around punctuation (natural language optimization)
      .replace(/ ([,;:.!?)\]}])/g, "$1")
      .replace(/([([{]) /g, "$1")
      // Minify code blocks - dedent to minimum indentation
      .replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
        const lines = code.split("\n");
        const nonEmptyLines = lines.filter((l: string) => l.trim().length > 0);
        if (nonEmptyLines.length === 0) return match;

        const minIndent = Math.min(
          ...nonEmptyLines.map((l: string) => {
            const leadingSpaces = l.match(/^[ \t]*/)?.[0].length || 0;
            return leadingSpaces;
          }),
        );

        const dedented = lines
          .map((l: string) => (l.trim().length > 0 ? l.slice(minIndent) : ""))
          .join("\n")
          .trim();

        return `\`\`\`${lang}\n${dedented}\n\`\`\``;
      })
      // Remove markdown link titles: [text](url "title") → [text](url)
      .replace(/\[([^\]]+)\]\(([^)]+)\s+"[^"]*"\)/g, "[$1]($2)")
      // Collapse markdown headers: ### Text → ###Text
      .replace(/^(#{1,6})[ \t]+/gm, "$1")
      // Remove empty list items
      .replace(/^[-*+][ \t]*$/gm, "")
      // Remove repeated blank lines in lists
      .replace(/(\n[-*+][^\n]*)\n{2,}(?=[-*+])/g, "$1\n")
      // Final trim
      .trim()
  );
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}
