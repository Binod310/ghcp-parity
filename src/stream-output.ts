import { Transform } from "node:stream";

export function estimateOutputTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0;
}

export function createSseOutputCounter(
  onComplete: (tokens: number) => void,
): Transform {
  let pending = "";
  let output = "";

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      pending += chunk.toString("utf8");
      const events = pending.split("\n\n");
      pending = events.pop() ?? "";
      for (const event of events) {
        output += extractText(event);
      }
      callback(null, chunk);
    },
    flush(callback) {
      output += extractText(pending);
      onComplete(estimateOutputTokens(output));
      callback();
    },
  });
}

function extractText(event: string): string {
  return event
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .flatMap((line) => {
      const value = line.slice(5).trim();
      if (!value || value === "[DONE]") {
        return [];
      }
      try {
        const payload = JSON.parse(value) as Record<string, unknown>;
        return extractPayloadText(payload);
      } catch {
        return [];
      }
    })
    .join("");
}

function extractPayloadText(payload: Record<string, unknown>): string[] {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const chatText = choices.flatMap((choice) => {
    if (typeof choice !== "object" || choice === null) {
      return [];
    }
    const delta = (choice as Record<string, unknown>).delta;
    if (typeof delta !== "object" || delta === null) {
      return [];
    }
    const content = (delta as Record<string, unknown>).content;
    return typeof content === "string" ? [content] : [];
  });
  if (chatText.length > 0) {
    return chatText;
  }

  const text = payload.delta ?? payload.text;
  return typeof text === "string" ? [text] : [];
}
