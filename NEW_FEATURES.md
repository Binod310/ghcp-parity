# Latest Features Added - Round 4

## 🆕 Advanced Features from ContentRouterConfig

These features were found in `headroom/content_router.py` ContentRouterConfig and have been fully implemented:

### 13. **Min Chars for Block Compression** (`min_chars_for_block_compression: 500`)

- Character-based threshold (in addition to token threshold)
- Below 500 chars, overhead exceeds savings
- Applied before token check in `compressText()`
- **Source**: `ContentRouterConfig.min_chars_for_block_compression` (default: 500)

### 14. **Protect Error Outputs with Size Threshold** (`protect_error_outputs`, `error_protection_max_chars`)

- Preserve error content below 8000 chars (~2K tokens) verbatim
- Larger errors still compress (LogCompressor preserves error lines anyway)
- Default: `protect_error_outputs: true`, `error_protection_max_chars: 8000`
- **Source**: `ContentRouterConfig.protect_error_outputs`, `error_protection_max_chars`

### 15. **Protect Recent Code** (`protect_recent_code: 4`)

- Don't compress CODE in last N messages
- Prevents breaking code snippets in active conversation
- Works independently of `protect_recent` (which protects ALL content)
- Uses `isSourceCode()` heuristic: markdown blocks, function/class keywords, special char density
- Applied to both single messages and multi-part content
- **Source**: `ContentRouterConfig.protect_recent_code` (default: 4)
- **Difference from protect_recent**: `protect_recent` skips ALL content in last N messages, `protect_recent_code` only skips CODE (still compresses text/logs/etc.)

### 16. **XML Tag Protection** (`compress_tagged_content`, `protectTags()`, `restoreTags()`)

- Protects custom/workflow XML tags (e.g., `<thinking>`, `<analysis>`, `<context>`)
- Two modes:
  - `compress_tagged_content: false` (default): Protect entire `<tag>content</tag>` block verbatim
  - `compress_tagged_content: true`: Only protect tag markers, expose content for compression
- Skips known HTML tags (div, span, p, a, img, etc.) - only protects custom tags
- Uses placeholder replacement (`{{HEADROOM_TAG_N}}`) with restoration after compression
- Integrated into `compressText()` pipeline (Step 0: before other transforms)
- **Source**: `headroom/transforms/tag_protector.py` (Rust-backed implementation)
- **Use case**: AI workflows using XML for structured thinking/analysis

### 17. **Bash Tool Detection** (`bash_tool_names`, `isBashTool()`)

- Identifies shell tools: `['bash', 'shell', 'local_shell']` by default
- Case-insensitive matching
- Enables shell-specific compression strategies
- **Source**: `ContentRouterConfig.bash_tool_names` (default: ['bash', 'shell'])
- **Use case**: Combined with grep/log detection for optimal shell output compression

## Implementation Details

### Updated `CompressionConfig` Interface

```typescript
export interface CompressionConfig {
  // ... existing fields ...

  min_chars_for_block_compression?: number; // NEW: 500 chars default
  protect_error_outputs?: boolean; // NEW: true default
  error_protection_max_chars?: number; // NEW: 8000 default
  protect_recent_code?: number; // NEW: 4 default
  compress_tagged_content?: boolean; // NEW: false default
  bash_tool_names?: string[]; // NEW: ['bash', 'shell', 'local_shell']
}
```

### Updated `compressText()` Pipeline

```
1. Check min_chars_for_block_compression (500)  <-- NEW
2. Check min_tokens_to_compress (250)
3. Check deduplication cache
4. Protect error content (if below 8000 chars)   <-- NEW
5. Protect custom XML tags (extract placeholders) <-- NEW
6. Apply lossless compaction
7. JSON array crushing
8. Aggressive text compaction
9. Restore XML tags                              <-- NEW
10. Accuracy guard check
11. Cache result
```

### Updated Message Processing

- `optimizeChatCompletionsBody()`: Added `codeProtectionStart` zone and `isSourceCode()` checks
- `optimizeResponsesBody()`: Added same code protection logic
- `optimizeMessagesBody()`: Added same code protection logic
- All three functions now check `protect_recent_code` before `protect_analysis_context`

## Testing Recommendations

1. **XML Tag Protection**: Test with `<thinking>`, `<analysis>`, `<context>` blocks
2. **Error Size Threshold**: Test with small error (< 8000 chars) and large error (> 8000 chars)
3. **Code Protection**: Test with code in recent messages (should skip) vs old messages (should compress)
4. **Char vs Token Threshold**: Test with 400-char content (skipped) vs 600-char content (compressed)

## Feature Count

**Total Implemented**: 17 features (was 12, added 5 more)  
**Round 4 Additions**: 5 features from ContentRouterConfig
