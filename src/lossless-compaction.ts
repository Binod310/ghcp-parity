/**
 * Lossless compaction utilities from Headroom.
 *
 * Format-native, reversible lossless compaction for logs, grep, and diffs.
 * Every helper keeps output looking like its own type - grep stays grep,
 * logs stay logs, diffs stay diffs.
 *
 * Based on headroom/transforms/lossless_compaction.py
 */

/**
 * Remove ANSI CSI/SGR (color) escape sequences.
 * Color is non-semantic and safe to strip.
 */
export function stripAnsi(text: string): string {
  // ANSI CSI SGR pattern: ESC [ ... m
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Collapse runs of 2+ identical consecutive lines (syslog convention).
 *
 * Example:
 *   Line A
 *   Line A
 *   Line A
 * becomes:
 *   Line A
 *   ... (repeated 3 times)
 */
export function collapseRuns(text: string): string {
  const lines = text.split("\n");
  if (lines.length === 0) return text;

  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const currentLine = lines[i];
    let runLength = 1;

    // Count consecutive identical lines
    while (
      i + runLength < lines.length &&
      lines[i + runLength] === currentLine
    ) {
      runLength++;
    }

    if (runLength >= 2) {
      out.push(currentLine);
      out.push(`... (repeated ${runLength} times)`);
    } else {
      out.push(currentLine);
    }

    i += runLength;
  }

  return out.join("\n");
}

/**
 * Check if text contains run-collapse markers.
 */
export function isRunCollapsed(text: string): boolean {
  return /\.\.\. \(repeated \d+ times\)/.test(text);
}

/**
 * Collapse multi-line blocks that repeat earlier content into back-refs.
 *
 * Example: k8s config with repeated container stanzas
 *
 * Block-level generalization of collapseRuns: a run of K consecutive lines
 * that exactly reproduces K lines seen D lines earlier becomes
 * "... (repeats K lines from D lines back)"
 */
export function foldRepeatedBlocks(text: string): string {
  const lines = text.split("\n");
  const n = lines.length;

  const MIN_BLOCK = 3;
  const MAX_BLOCK = 64;
  const MAX_LINES = 20000;
  const MAX_CANDIDATES = 8;

  if (n < MIN_BLOCK * 2 || n > MAX_LINES) {
    return text;
  }

  // Track recent positions of each unique line
  const positions = new Map<string, number[]>();
  const out: string[] = [];
  let i = 0;

  while (i < n) {
    let bestLen = 0;
    let bestDist = 0;

    // Look for longest matching block in previous occurrences
    const candidates = positions.get(lines[i]) || [];
    for (let j = candidates.length - 1; j >= 0; j--) {
      const q = candidates[j];
      const maxLen = Math.min(MAX_BLOCK, n - i, i - q);
      let length = 0;

      while (length < maxLen && lines[q + length] === lines[i + length]) {
        length++;
      }

      if (length > bestLen) {
        bestLen = length;
        bestDist = i - q;
      }
    }

    // If found a good match, replace with marker
    if (bestLen >= MIN_BLOCK) {
      const marker = `... (repeats ${bestLen} lines from ${bestDist} lines back)`;
      const blockChars = lines.slice(i, i + bestLen).join("\n").length;

      if (blockChars > marker.length + 1) {
        out.push(marker);
        // Remember these lines for future matching
        for (let k = 0; k < bestLen; k++) {
          rememberLine(positions, lines[i + k], i + k, MAX_CANDIDATES);
        }
        i += bestLen;
        continue;
      }
    }

    // No match found, keep line as-is
    rememberLine(positions, lines[i], i, MAX_CANDIDATES);
    out.push(lines[i]);
    i++;
  }

  return out.join("\n");
}

function rememberLine(
  positions: Map<string, number[]>,
  line: string,
  index: number,
  maxCandidates: number,
): void {
  let bucket = positions.get(line);
  if (!bucket) {
    bucket = [];
    positions.set(line, bucket);
  }
  bucket.push(index);
  if (bucket.length > maxCandidates) {
    bucket.shift();
  }
}

/**
 * Strip diff index lines (git metadata not needed for applying patch).
 * Pattern: "index <sha>..<sha> <mode>"
 */
export function diffStripIndex(text: string): string {
  return text.replace(/^index [0-9a-fA-F]+\.\.[0-9a-fA-F]+(?: [0-7]+)?$/gm, "");
}

/**
 * Comprehensive lossless compaction for logs, grep results, and diffs.
 * Applies all safe, reversible transforms.
 */
export function compactLossless(text: string): string {
  let result = text;

  // Strip ANSI colors (non-semantic)
  result = stripAnsi(result);

  // Collapse repeated lines
  if (!isRunCollapsed(result)) {
    const collapsed = collapseRuns(result);
    if (collapsed.length < result.length) {
      result = collapsed;
    }
  }

  // Fold repeated blocks
  const folded = foldRepeatedBlocks(result);
  if (folded.length < result.length) {
    result = folded;
  }

  // Strip diff index lines
  if (text.includes("diff --git") || text.includes("index ")) {
    const stripped = diffStripIndex(result);
    if (stripped.length < result.length) {
      result = stripped;
    }
  }

  return result;
}

/**
 * Check if content looks like grep/ripgrep output.
 */
export function isGrepOutput(text: string): boolean {
  // Pattern: path:line:content
  return /^[^\n:]+:\d+:.+$/m.test(text);
}

/**
 * Check if content looks like log output.
 */
export function isLogOutput(text: string): boolean {
  // Look for timestamp patterns and log levels
  const hasTimestamp = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(text);
  const hasLogLevel = /\b(ERROR|WARN|INFO|DEBUG|FATAL|TRACE)\b/i.test(text);
  const hasRepeatedFormat =
    text.split("\n").filter((l) => l.length > 20).length >= 5;

  return (hasTimestamp && hasLogLevel) || hasRepeatedFormat;
}

/**
 * Check if content looks like diff output.
 */
export function isDiffOutput(text: string): boolean {
  return text.includes("diff --git") || /^[+-]{3} /.test(text);
}
