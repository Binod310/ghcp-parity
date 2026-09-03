import * as ts from "typescript";

export function compactDuplicateImports(source: string): string {
  const sourceFile = ts.createSourceFile(
    "context.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const seen = new Set<string>();
  const removals: Array<{ start: number; end: number }> = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) {
      continue;
    }
    const fingerprint = statement.getText(sourceFile);
    if (seen.has(fingerprint)) {
      removals.push({
        start: statement.getFullStart(),
        end: statement.getEnd(),
      });
    } else {
      seen.add(fingerprint);
    }
  }

  return removals
    .reverse()
    .reduce(
      (compacted, removal) =>
        `${compacted.slice(0, removal.start)}${compacted.slice(removal.end)}`,
      source,
    );
}
