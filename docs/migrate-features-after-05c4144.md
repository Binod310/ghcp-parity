# Migration Prompt: Copilot Parity Features After `05c4144`

Use this prompt when applying current Copilot parity improvements to another organization or repository that already contains local changes on top of commit `05c4144b07c3d4831a39ac1a8072c7bbf5ead3b3`.

## Objective

Bring all tested Copilot parity and token-optimization features from the current `main` branch into the target repository without overwriting, reverting, or reformatting target-specific changes.

Reference baseline:

- Commit: `05c4144b07c3d4831a39ac1a8072c7bbf5ead3b3`
- Commit message: `feat: add Copilot parity proxy`
- Repository: `https://github.com/Binod310/ghcp-parity.git`
- Current feature commit: inspect current `main` before applying; do not assume a fixed later hash.

## Non-Negotiable Preservation Rules

1. Create a safety branch or patch backup in target repository before applying changes.
2. Inspect target status, branch, and commits after `05c4144`.
3. Never use `git reset --hard`, `git checkout --`, or broad file replacement.
4. Preserve target changes line by line. Resolve conflicts by combining behavior, not choosing one side blindly.
5. Keep target organization-specific endpoints, settings, authentication, certificates, model routing, telemetry, and naming unless a feature requires an additive change.
6. Do not copy `node_modules/`, `dist/`, logs, local auth files, telemetry files, certificates, or secrets.
7. Do not copy local VS Code user settings automatically. Review endpoint overrides manually.
8. Keep documentation and source comments in normal prose.
9. Do not commit secrets, bearer tokens, OAuth credentials, certificate files, prompts, or completions.

## Recommended Workflow

```bash
git status --short
git log --oneline --decorate --all -20
git show --stat 05c4144b07c3d4831a39ac1a8072c7bbf5ead3b3
git fetch origin
git diff 05c4144b07c3d4831a39ac1a8072c7bbf5ead3b3..origin/main -- src tests docs README.md REMAINING_FEATURES.md
```

Apply changes selectively with three-way review. Prefer `git diff`, `git apply --3way`, or manual edits that preserve target modifications. After each feature group, run its focused test before continuing.

## Feature Groups To Port

### Core routing and compatibility

Preserve native Copilot model IDs and endpoint behavior. Support `/chat/completions`, `/v1/chat/completions`, `/responses`, `/v1/responses`, `/v1/messages`, `/models`, and `/v1/models`. Preserve `/p/:project` prefix handling. Keep native VS Code routing through the configured loopback port.

Primary files:

- `src/server.ts`
- `src/types.ts`
- `src/vscode-config.ts`
- `tests/vscode-config.test.ts`

### Authentication and TLS

Preserve device OAuth, API-token exchange, refresh, one retry after upstream `401`, Headroom auth import, advertised Business/Enterprise API host handling, and custom CA support. Use `COPILOT_CA_BUNDLE` and `NODE_EXTRA_CA_CERTS`. Never disable TLS verification with `NODE_TLS_REJECT_UNAUTHORIZED=0`.

Primary files:

- `src/auth.ts`
- `src/upstream-agent.ts`
- `src/server.ts`
- `tests/auth.test.ts`

### Input compression

Port deterministic, shrink-only compression for repeated lines, repeated blocks, repeated paragraphs, logs, grep/search output, diffs, JSON text, safe whitespace, duplicate tool schemas, exact duplicate imports, XML-tagged content, and configured shell-tool output.

Preserve cache-anchored prefixes, excluded tools, recent code, analysis code, small errors, and configured frozen/recent messages.

Primary files:

- `src/optimizer.ts`
- `src/lossless-compaction.ts`
- `src/json-crusher.ts`
- `src/code-compaction.ts`
- `tests/optimizer.test.ts`
- `tests/code-compaction.test.ts`

### Runtime compression controls

Port environment and typed controls without changing defaults:

- `COPILOT_PARITY_ENABLE_OPTIMIZATION=0`
- `COPILOT_PARITY_COMPRESS_ASSISTANT=1`
- `COPILOT_PARITY_COMPRESS_USER=0`
- `COPILOT_PARITY_COMPRESS_SYSTEM=0`
- `COPILOT_PARITY_MIN_TOKENS`
- `COPILOT_PARITY_MIN_CHARS`
- `COPILOT_PARITY_MIN_SECTION_TOKENS`
- `COPILOT_PARITY_MIN_RATIO_RELAXED`
- `COPILOT_PARITY_MIN_RATIO_AGGRESSIVE`
- `COPILOT_PARITY_FROZEN_MESSAGES`
- `COPILOT_PARITY_PROTECT_RECENT`
- `COPILOT_PARITY_PROTECT_RECENT_CODE`
- `COPILOT_PARITY_PROTECT_ERRORS`
- `COPILOT_PARITY_ERROR_MAX_CHARS`
- `COPILOT_PARITY_COMPRESS_TAGGED`
- `COPILOT_PARITY_EXCLUDE_TOOLS`
- `COPILOT_PARITY_LOSSLESS`
- `COPILOT_PARITY_LOSSLESS_ONLY`
- `COPILOT_PARITY_COMPRESSION_MODE`
- `COPILOT_PARITY_CODE_IMPORT_DEDUP`
- `COPILOT_PARITY_BASH_TOOLS`
- `COPILOT_PARITY_RELEVANCE_SPLIT`
- `COPILOT_PARITY_CROSS_TURN_DEDUP`
- `COPILOT_PARITY_JSON_COMPACTION`
- `COPILOT_PARITY_LOG_COMPACTION`
- `COPILOT_PARITY_SEARCH_COMPACTION`
- `COPILOT_PARITY_DIFF_COMPACTION`
- `COPILOT_PARITY_STRICT_ACCURACY`

Preserve per-tool JSON profiles and explicit external compressor activation.

### Terse and ultra communication mode

Port `off`, `lite`, `full`, `ultra`, `wenyan-lite`, `wenyan-full`, and `wenyan-ultra`. Preserve dominant user language, negation, exact code, identifiers, error strings, numbers, and clarity exceptions.

Primary files:

- `src/terse-mode.ts`
- `src/types.ts`
- `src/server.ts`
- `tests/terse-mode.test.ts`
- `docs/caveman-mode.md`

### Telemetry

Port in-memory and durable JSONL telemetry, input token estimates, saved-token calculations, upstream usage parsing, streamed output estimates for OpenAI/Responses/Anthropic SSE, request summaries, per-model summaries, and `/stats/*` endpoints. Store numeric metadata only. Never store prompts, completions, credentials, or request bodies.

Primary files:

- `src/telemetry.ts`
- `src/telemetry-store.ts`
- `src/stream-output.ts`
- `src/server.ts`
- `tests/telemetry.test.ts`
- `tests/stream-output.test.ts`

### CCR

Port opt-in CCR only when target client or tool loop understands markers. Large content is stored in bounded in-memory storage and replaced by an explicit marker. Support retrieval, deletion, clear, status, configurable minimum size, TTL, maximum entries, marker injection control, and optional management bearer authentication.

Environment variables and endpoints:

- `COPILOT_PARITY_CCR=1`
- `COPILOT_PARITY_CCR_MIN_CHARS`
- `COPILOT_PARITY_CCR_TTL_MS`
- `COPILOT_PARITY_CCR_MAX_ENTRIES`
- `COPILOT_PARITY_CCR_INJECT_MARKER=0`
- `COPILOT_PARITY_MANAGEMENT_TOKEN`
- `GET /ccr/retrieve/:id`
- `DELETE /ccr/retrieve/:id`
- `POST /ccr/clear`
- `GET /ccr/status`

Do not claim native VS Code CCR completion. Native Copilot does not automatically retrieve markers.

Primary files:

- `src/ccr.ts`
- `src/optimizer.ts`
- `src/server.ts`
- `src/types.ts`
- `tests/optimizer.test.ts`

### External compressors and relevance

Port explicit external module loading with module shape `{ name, compress(text) }`. Activate names separately. Accept only shorter string output; ignore unknown modules; isolate loader and plugin exceptions.

Port lexical relevance splitting for Chat, Responses, and Anthropic inputs. Preserve sections matching latest user query; compress unrelated sections. Do not add embeddings or network calls.

## Validation Contract

Run from target repository:

```bash
npm install
npm test
npm run build
git diff --check
```

Run focused tests after each group. Then exercise live proxy through the configured VS Code prefix:

```bash
curl -sS http://127.0.0.1:<PORT>/health
curl -sS http://127.0.0.1:<PORT>/stats/config
curl -sS http://127.0.0.1:<PORT>/stats/summary
```

For live inference, verify:

- HTTP `200`
- Native selected model preserved
- Exact response marker returned
- Proxy log shows `/p/<project>/...`
- `/stats/latest` records route, model, status, before tokens, after tokens, and saved tokens
- TLS succeeds with configured CA

For CCR, verify marker creation, `GET` retrieval, exact restored bytes, deletion, clear, status, and `401`/authorized management behavior when token protection is enabled.

## Final Review

Before commit:

```bash
git status --short
git diff --stat
git diff --check
git ls-files | grep -E '(^|/)(node_modules|dist)/' || true
```

Expected result: no generated directories tracked, no secrets, all target changes preserved, tests and build pass. Commit only after review. Push only after the organization-specific live test passes.
