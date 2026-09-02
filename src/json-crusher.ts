/**
 * SmartCrusher-inspired JSON array compression for TypeScript.
 *
 * Implements the core Headroom SmartCrusher logic without ML:
 * 1. Detect JSON arrays of objects
 * 2. Preserve first N and last N items (context)
 * 3. Preserve error/exception items (100%)
 * 4. Preserve anomalous numeric values (statistical outliers)
 * 5. Sample remaining items statistically
 *
 * Based on Headroom's SmartCrusher (headroom/transforms/smart_crusher.py)
 */

interface CrusherConfig {
  minItemsToCrush: number;
  maxItemsAfterCrush: number;
  preserveFirst: number;
  preserveLast: number;
  targetRatio: number;
}

interface CrushResult {
  compressed: string;
  wasModified: boolean;
  originalCount: number;
  compressedCount: number;
  strategy: string;
}

const DEFAULT_CONFIG: CrusherConfig = {
  minItemsToCrush: 15, // Only crush arrays with 15+ items
  maxItemsAfterCrush: 10, // Keep at most 10 items (aggressive like Headroom)
  preserveFirst: 3, // Always keep first 3
  preserveLast: 2, // Always keep last 2
  targetRatio: 0.3, // Target 30% of original (aggressive compression)
};

/**
 * Check if a JSON value looks like error data.
 */
function isErrorItem(item: unknown): boolean {
  if (typeof item === "string") {
    const lower = item.toLowerCase();
    return (
      lower.includes("error") ||
      lower.includes("exception") ||
      lower.includes("failed") ||
      lower.includes("fatal")
    );
  }

  if (typeof item === "object" && item !== null) {
    const obj = item as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
      const keyLower = key.toLowerCase();
      if (
        keyLower === "error" ||
        keyLower === "status" ||
        keyLower === "level" ||
        keyLower === "severity"
      ) {
        const valStr = String(value).toLowerCase();
        if (
          valStr.includes("error") ||
          valStr.includes("fail") ||
          valStr === "error" ||
          valStr === "fatal"
        ) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Extract numeric values from an object for statistical analysis.
 */
function extractNumericValues(items: unknown[]): number[] {
  const nums: number[] = [];

  for (const item of items) {
    if (typeof item === "number") {
      nums.push(item);
    } else if (typeof item === "object" && item !== null) {
      const obj = item as Record<string, unknown>;
      for (const value of Object.values(obj)) {
        if (typeof value === "number" && !Number.isNaN(value)) {
          nums.push(value);
        }
      }
    }
  }

  return nums;
}

/**
 * Compute mean and standard deviation.
 */
function computeStats(values: number[]): { mean: number; stdDev: number } {
  if (values.length === 0) {
    return { mean: 0, stdDev: 0 };
  }

  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance =
    values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  const stdDev = Math.sqrt(variance);

  return { mean, stdDev };
}

/**
 * Check if an item contains anomalous numeric values (> 2 std dev from mean).
 */
function isAnomalousItem(item: unknown, mean: number, stdDev: number): boolean {
  if (stdDev === 0) return false;

  if (typeof item === "number") {
    return Math.abs(item - mean) > 2 * stdDev;
  }

  if (typeof item === "object" && item !== null) {
    const obj = item as Record<string, unknown>;
    for (const value of Object.values(obj)) {
      if (typeof value === "number" && !Number.isNaN(value)) {
        if (Math.abs(value - mean) > 2 * stdDev) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Crush a JSON array using SmartCrusher-like logic.
 */
export function crushJsonArray(
  content: string,
  config: Partial<CrusherConfig> = {},
): CrushResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  try {
    const parsed = JSON.parse(content);

    // Only process arrays
    if (!Array.isArray(parsed)) {
      return {
        compressed: content,
        wasModified: false,
        originalCount: 0,
        compressedCount: 0,
        strategy: "not_array",
      };
    }

    const items = parsed;
    const originalCount = items.length;

    // Skip if array is too small
    if (originalCount < cfg.minItemsToCrush) {
      return {
        compressed: content,
        wasModified: false,
        originalCount,
        compressedCount: originalCount,
        strategy: "too_small",
      };
    }

    // Extract numeric values for anomaly detection
    const numericValues = extractNumericValues(items);
    const { mean, stdDev } = computeStats(numericValues);

    const keptIndices = new Set<number>();

    // Step 1: Preserve first N items
    for (let i = 0; i < Math.min(cfg.preserveFirst, originalCount); i++) {
      keptIndices.add(i);
    }

    // Step 2: Preserve last N items
    for (
      let i = Math.max(0, originalCount - cfg.preserveLast);
      i < originalCount;
      i++
    ) {
      keptIndices.add(i);
    }

    // Step 3: Preserve error items
    for (let i = 0; i < originalCount; i++) {
      if (isErrorItem(items[i])) {
        keptIndices.add(i);
      }
    }

    // Step 4: Preserve anomalous items
    if (stdDev > 0) {
      for (let i = 0; i < originalCount; i++) {
        if (isAnomalousItem(items[i], mean, stdDev)) {
          keptIndices.add(i);
        }
      }
    }

    // Step 5: Statistical sampling of remaining items
    // Use targetRatio to determine how many items to keep
    const targetByRatio = Math.ceil(originalCount * cfg.targetRatio);
    const minTarget = keptIndices.size + 1; // At least keep what we've preserved
    const targetTotal = Math.min(
      cfg.maxItemsAfterCrush,
      Math.max(targetByRatio, minTarget),
    );
    const remainingSlots = Math.max(0, targetTotal - keptIndices.size);

    if (remainingSlots > 0) {
      const notKept: number[] = [];
      for (let i = 0; i < originalCount; i++) {
        if (!keptIndices.has(i)) {
          notKept.push(i);
        }
      }

      // Sample evenly across the remaining items
      const step = Math.max(1, Math.floor(notKept.length / remainingSlots));
      for (
        let i = 0;
        i < notKept.length && keptIndices.size < targetTotal;
        i += step
      ) {
        keptIndices.add(notKept[i]);
      }
    }

    // Build compressed array maintaining original order
    const keptItems = Array.from(keptIndices)
      .sort((a, b) => a - b)
      .map((i) => items[i]);

    const compressedCount = keptItems.length;

    // Add CCR-style marker if we dropped items
    const droppedCount = originalCount - compressedCount;
    if (droppedCount > 0) {
      keptItems.push({
        _headroom_dropped: `${droppedCount} items compressed (kept ${compressedCount}/${originalCount})`,
      });
    }

    const compressed = JSON.stringify(keptItems, null, 0);

    return {
      compressed,
      wasModified: droppedCount > 0,
      originalCount,
      compressedCount,
      strategy: droppedCount > 0 ? "smart_sample" : "passthrough",
    };
  } catch (error) {
    // Not valid JSON or other error - return as-is
    return {
      compressed: content,
      wasModified: false,
      originalCount: 0,
      compressedCount: 0,
      strategy: "parse_error",
    };
  }
}

/**
 * Detect and crush JSON arrays in text content.
 */
export function crushJsonInText(
  text: string,
  config: Partial<CrusherConfig> = {},
): { text: string; crushed: boolean } {
  // Try to parse the entire text as JSON first
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      const result = crushJsonArray(text, config);
      return { text: result.compressed, crushed: result.wasModified };
    }
  } catch {
    // Not a JSON array, continue
  }

  // Look for JSON arrays embedded in the text using bracket matching
  // More robust than regex - handles nested structures correctly
  let modified = false;
  let result = text;
  let offset = 0;

  while (offset < text.length) {
    const startIdx = text.indexOf("[", offset);
    if (startIdx === -1) break;

    // Find matching closing bracket
    let depth = 0;
    let endIdx = -1;
    for (let i = startIdx; i < text.length; i++) {
      if (text[i] === "[") depth++;
      else if (text[i] === "]") {
        depth--;
        if (depth === 0) {
          endIdx = i;
          break;
        }
      }
    }

    if (endIdx === -1) {
      offset = startIdx + 1;
      continue;
    }

    const candidate = text.slice(startIdx, endIdx + 1);

    // Try to parse as JSON array
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const crushResult = crushJsonArray(candidate, config);
        if (crushResult.wasModified) {
          // Replace this occurrence in the result
          const before = result.slice(0, startIdx);
          const after = result.slice(endIdx + 1);
          result = before + crushResult.compressed + after;
          modified = true;

          // Adjust offset for the length change
          const lengthDiff = crushResult.compressed.length - candidate.length;
          offset = endIdx + 1 + lengthDiff;
          continue;
        }
      }
    } catch {
      // Not valid JSON, skip
    }

    offset = startIdx + 1;
  }

  return { text: result, crushed: modified };
}
