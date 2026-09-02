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

**Implement compress_assistant_text_blocks**: Simple, aligns with Headroom defaults
**Consider min_ratio thresholds**: Useful optimization
**Skip min_section_tokens**: Already have message-level threshold
**Skip everything else**: Infrastructure requirements or overkill for proxy

## Current Status

**Implemented**: 17 core features
**Easy adds**: 1-2 more (compress_assistant_text_blocks, min_ratio thresholds)
**Final count**: ~18-19 features (93%+ of applicable features)
