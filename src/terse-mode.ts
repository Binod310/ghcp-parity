/**
 * Terse output mode ("caveman"-style): injects a system instruction that asks
 * the model to reply tersely, reducing output tokens. This is independent of
 * optimizer.ts, which reduces input tokens by compacting request content.
 */

export type TerseLevel = "off" | "lite" | "full" | "ultra";

const VALID_LEVELS = new Set<TerseLevel>(["off", "lite", "full", "ultra"]);

const TERSE_INSTRUCTIONS: Record<Exclude<TerseLevel, "off">, string> = {
  lite:
    "Respond concisely in user's language. Omit filler, hedging, and " +
    "pleasantries. Keep full sentences, technical accuracy, negations, exact " +
    "code, identifiers, error text, and numbers.",
  full:
    "Respond tersely in user's language. Drop articles, filler, hedging, and " +
    "pleasantries; fragments are fine. Keep all technical substance, negation, " +
    "exact code, identifiers, error text, and numbers. Do not invent " +
    "abbreviations or narrate tool calls. Use normal prose for security warnings, " +
    "irreversible actions, or ambiguous multi-step instructions.",
  ultra:
    "Respond in minimum words in user's language. State each fact once. Remove " +
    "conjunctions only when meaning stays unambiguous. Preserve negation, exact " +
    "code, identifiers, error strings, and numbers. Do not invent abbreviations. " +
    "Use normal prose for security warnings, irreversible actions, or ambiguous " +
    "multi-step instructions.",
};

export function resolveTerseLevel(
  headerValue: unknown,
  defaultLevel: TerseLevel,
): TerseLevel {
  if (typeof headerValue === "string") {
    const normalized = headerValue.trim().toLowerCase() as TerseLevel;
    if (VALID_LEVELS.has(normalized)) {
      return normalized;
    }
  }
  return defaultLevel;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Injects the terse instruction into a request body based on its API shape.
 * Supports OpenAI-style `messages`, Anthropic-style top-level `system`, and
 * Responses API `instructions`.
 */
export function applyTerseMode(
  route: string,
  body: unknown,
  level: TerseLevel,
): unknown {
  if (level === "off" || !isRecord(body)) {
    return body;
  }

  const instruction = TERSE_INSTRUCTIONS[level];
  const next: Record<string, unknown> = { ...body };

  // Anthropic Messages API: top-level `system` (string or content-block array).
  if (route === "/v1/messages") {
    if (typeof next.system === "string") {
      next.system = `${instruction}\n\n${next.system}`;
    } else if (Array.isArray(next.system)) {
      next.system = [{ type: "text", text: instruction }, ...next.system];
    } else {
      next.system = instruction;
    }
    return next;
  }

  // Responses API: top-level `instructions` string.
  if (route === "/v1/responses") {
    next.instructions =
      typeof next.instructions === "string"
        ? `${instruction}\n\n${next.instructions}`
        : instruction;
    return next;
  }

  // OpenAI-style Chat Completions: `messages` array with optional system role.
  if (Array.isArray(next.messages)) {
    const messages = next.messages as unknown[];
    const firstMessage = messages[0];
    if (isRecord(firstMessage) && firstMessage.role === "system") {
      const existingContent = firstMessage.content;
      const mergedContent =
        typeof existingContent === "string"
          ? `${instruction}\n\n${existingContent}`
          : instruction;
      next.messages = [
        { ...firstMessage, content: mergedContent },
        ...messages.slice(1),
      ];
    } else {
      next.messages = [{ role: "system", content: instruction }, ...messages];
    }
    return next;
  }

  return next;
}
