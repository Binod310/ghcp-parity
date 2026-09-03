# Feature Completeness Analysis

## Remaining Features in Headroom ContentRouterConfig NOT Implemented

After thorough review of `headroom/headroom/transforms/content_router.py`, here are the remaining features we haven't implemented:

### Simple Features (Could Implement)

1. **compress_assistant_text_blocks** (bool, default: False)
   - **Purpose**: Compress assistant text blocks (cache-safety trade-off)
   - **Default OFF**: Because compressing assistant content changes bytes for cache matching
   - **When to enable**: Only for backends that don't honor cache_control AND have deterministic compressors
   - **Our case**: We have deterministic compressors (no ML), but still default to false for cache safety
   - **Implementation**: Simple role check in message processing
   - **Priority**: LOW (cache safety > compression)

2. **min_section_tokens** (int, default: 20)
   - **Purpose**: Minimum tokens to compress a section/block
   - **Current**: We have `min_tokens_to_compress: 250` (message level)
   - **Difference**: This is for sub-message sections/blocks
   - **Implementation**: Would need section-level detection
   - **Priority**: LOW (we already have message-level threshold)

3. **min_ratio_relaxed / min_ratio_aggressive** (float, default: 1.0)
   - **Purpose**: Acceptance thresholds for compression (compression_ratio < min_ratio → reject)
   - **Default 1.0**: Accept any shrink (no savings floor)
   - **Use case**: Prevent overhead when compression achieves < N% savings
   - **Implementation**: Check ratio after compression, revert if below threshold
   - **Priority**: MEDIUM (optimization for marginal cases)

### Complex Features (Not Implementing)

4. **relevance_split** (bool, default: True)
   - Requires embeddings/BM25 for relevance scoring
   - Segments LOG/SEARCH output into records, scores against prompt
   - **Not implementing**: Too complex for lightweight proxy

5. **ccr_enabled / ccr_inject_marker** (bool, default: True)
   - Compress-Cache-Retrieve with reversible markers
   - **Not implementing**: Requires retrieval infrastructure

6. **enable_cross_turn_dedup** (bool, default: False)
   - Cross-turn verbatim deduplication with in-context pointers
   - **Not implementing**: Requires session state tracking (proxy is stateless)

7. **lossless / lossless_then_lossy** (bool, default: False)
   - Mode switching between lossless-only and lossless+lossy
   - **Not implementing**: We apply both together (more aggressive)

8. **tool_profiles** (dict, default: None)
   - Per-tool CompressionProfile configuration
   - **Not implementing**: Overkill for HTTP proxy

9. **active_external_compressors** (list, default: None)
   - Dynamic compressor registry for external plugins
   - **Not implementing**: Not needed for fixed compression pipeline

10. **prefer_code_aware_for_code / force_kompress_all** (bool)
    - Routing preferences for compressor selection
    - **Not implementing**: We don't have multiple compressor backends

### Structural Compressor Config Overrides

11. **search_compressor / log_compressor / diff_compressor / text_crusher / smart_crusher**
    - Per-compressor configuration objects
    - **Not implementing**: We have fixed config in our implementations

### Summary

**Could implement easily** (3 features):

- compress_assistant_text_blocks (cache safety trade-off)
- min_section_tokens (sub-message threshold)
- min_ratio thresholds (acceptance gates)

**Not implementing** (8 features):

- Complex features requiring infrastructure (relevance_split, CCR, cross-turn-dedup)
- Mode switches (lossless modes)
- Per-tool profiles
- External compressor registry
- Compressor routing preferences
- Per-compressor config overrides

## Decision

**Implemented compress_assistant_text_blocks**: Available through
`COPILOT_PARITY_COMPRESS_ASSISTANT=1`; default remains disabled for cache safety.
**Implemented min_ratio thresholds**: Applied by `compressText`; runtime values
available through `COPILOT_PARITY_MIN_RATIO_RELAXED` and
`COPILOT_PARITY_MIN_RATIO_AGGRESSIVE`, default `1.0`.
**Implemented min_section_tokens**: Applied per paragraph section by `compressText`
with default `20`; small sections remain unchanged inside large messages.
**Implemented runtime size thresholds**: `COPILOT_PARITY_MIN_TOKENS`,
`COPILOT_PARITY_MIN_CHARS`, and `COPILOT_PARITY_MIN_SECTION_TOKENS` override
defaults without source changes.
**Implemented message protection controls**: `COPILOT_PARITY_FROZEN_MESSAGES`
and `COPILOT_PARITY_PROTECT_RECENT` preserve configured message zones.
**Implemented recent-code protection control**: `COPILOT_PARITY_PROTECT_RECENT_CODE`
preserves source code in recent messages; default `4`.
**Implemented error-output protection controls**: `COPILOT_PARITY_PROTECT_ERRORS`
and `COPILOT_PARITY_ERROR_MAX_CHARS` preserve small errors by default.
**Implemented XML-tag compression control**: `COPILOT_PARITY_COMPRESS_TAGGED=1`
compresses tagged content while preserving markers; default remains protected.
**Implemented custom tool exclusions**: `COPILOT_PARITY_EXCLUDE_TOOLS` adds
runtime-protected tool names to built-in exclusions.
**Implemented role compression controls**: `COPILOT_PARITY_COMPRESS_USER` and
`COPILOT_PARITY_COMPRESS_SYSTEM` independently control role compression.
**Implemented lossless compaction control**: `COPILOT_PARITY_LOSSLESS=0`
disables reversible log, grep, and diff folding.
**Implemented lossless-only mode**: `COPILOT_PARITY_LOSSLESS_ONLY=1` skips
lossy JSON and whitespace stages.
**Implemented strict accuracy guard**: `COPILOT_PARITY_STRICT_ACCURACY=1`
requires at least 20% savings before accepting compression.
**Implemented code-aware import control**: `COPILOT_PARITY_CODE_IMPORT_DEDUP=0`
disables exact duplicate import removal.
**Implemented per-tool compression profiles**: `COPILOT_PARITY_TOOL_PROFILES`
provides case-insensitive JSON overrides for tool-specific compression behavior.
**Implemented analysis-context protection**: `COPILOT_PARITY_PROTECT_ANALYSIS`
preserves code for review/debug/fix prompts by default.
**Implemented shell-tool detection**: `COPILOT_PARITY_BASH_TOOLS` configures
custom shell names for lossless log compaction.
**Skip everything else**: Infrastructure requirements or overkill for proxy

## Current Status

**Implemented**: 20 applicable core features
**Deferred**: CCR, relevance scoring, cross-turn deduplication, and external
compressors because they require additional infrastructure.
