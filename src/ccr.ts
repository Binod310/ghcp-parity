const entries = new Map<string, { content: string; expiresAt: number }>();
let nextId = 1;
let ttlMs = 60 * 60 * 1000;
let maxEntries = 1000;

export function getCcrStatus() {
  return { entryCount: entries.size, maxEntries, ttlMs };
}

export function configureCcrRetention(options: {
  ttlMs?: number;
  maxEntries?: number;
}): void {
  if (options.ttlMs !== undefined && options.ttlMs > 0) ttlMs = options.ttlMs;
  if (options.maxEntries !== undefined && options.maxEntries > 0) {
    maxEntries = Math.floor(options.maxEntries);
  }
}

export function storeCcrContent(content: string): string {
  const id = `ccr_${nextId++}`;
  while (entries.size >= maxEntries) {
    const oldest = entries.keys().next().value as string | undefined;
    if (!oldest) break;
    entries.delete(oldest);
  }
  entries.set(id, { content, expiresAt: Date.now() + ttlMs });
  return id;
}

export function retrieveCcrContent(id: string): string | undefined {
  const entry = entries.get(id);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    entries.delete(id);
    return undefined;
  }
  return entry.content;
}

export function deleteCcrContent(id: string): boolean {
  return entries.delete(id);
}

export function clearAllCcrContent(): void {
  entries.clear();
}

export function clearCcrContent(): void {
  entries.clear();
}

export function buildCcrMarker(id: string): string {
  return `[CCR:${id}] Retrieve original content from /ccr/retrieve/${id}.`;
}
