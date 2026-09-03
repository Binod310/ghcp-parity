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

## GitLab Target Instructions

Source repository: `ghcp-parity-main`.

Target repository: GitLab `ghcp-parity`.

Source baseline: `05c4144b07c3d4831a39ac1a8072c7bbf5ead3b3`.

Apply all tested features after baseline while preserving target organization changes.

### ZIP-Only Source Workflow

GitHub access is download-only. Do not use `git clone`, `git fetch`, or GitHub
push commands.

1. Download source ZIP from GitHub `main`:
   `https://github.com/Binod310/ghcp-parity/archive/refs/heads/main.zip`
2. Extract ZIP locally as `ghcp-parity-main`.
3. Open GitLab `ghcp-parity` working copy as target.
4. Compare extracted source files with target files.
5. Apply changes selectively while preserving target organization edits.
6. Run tests and build in target repository.
7. Commit and push only to GitLab.

Use extracted source only as a file reference. Do not copy `.git/`,
`node_modules/`, `dist/`, logs, generated test artifacts, auth files, telemetry
files, certificates, `.env` files, tokens, prompts, completions, or secrets.

### Preserve Target Changes

- Create backup branch before editing.
- Inspect target status, branch, remotes, and commits after `05c4144`.
- Merge source changes selectively with three-way review.
- Never use `git reset --hard`, `git checkout --`, `git clean -fd`, or broad replacement.
- Preserve target endpoints, authentication, TLS certificates, model routing, telemetry, deployment, GitLab CI, settings, naming, and tests.
- Preserve compatibility-only Headroom behavior where required: auth import, `x-headroom-*` headers, and existing migration paths.
- Do not copy local VS Code settings automatically.
- Do not copy `node_modules/`, `dist/`, logs, generated tests, auth files, telemetry files, certificates, `.env` files, tokens, prompts, completions, or secrets.

### Source Files

Merge these files, preserving target edits:

```text
src/auth.ts
src/ccr.ts
src/cli.ts
src/code-compaction.ts
src/json-crusher.ts
src/lossless-compaction.ts
src/optimizer.ts
src/server.ts
src/stream-output.ts
src/telemetry-store.ts
src/telemetry.ts
src/terse-mode.ts
src/types.ts
src/upstream-agent.ts
src/vscode-config.ts
```

Merge tests:

```text
tests/auth.test.ts
tests/code-compaction.test.ts
tests/optimizer.test.ts
tests/stream-output.test.ts
tests/telemetry.test.ts
tests/terse-mode.test.ts
tests/vscode-config.test.ts
tests/fixtures/external-compressor.cjs
```

Merge `README.md`, `REMAINING_FEATURES.md`, `docs/caveman-mode.md`,
`.gitignore`, `package.json`, `package-lock.json`, and `tsconfig.json` selectively.
Do not copy `tests/telemetry.test.js`, `tests/telemetry.test.js.map`,
`tests/telemetry.test.d.ts`, or any generated artifact.

### Features To Port

- Native Copilot routes, `/p/:project` forwarding, model ID preservation.
- Device OAuth, API-token exchange, refresh, one upstream `401` retry, Enterprise host routing.
- Corporate CA support through `COPILOT_CA_BUNDLE` and `NODE_EXTRA_CA_CERTS`.
- Repeated line/block/paragraph, log, search, diff, JSON, whitespace, schema, import, XML, and shell-output compression.
- Cache-anchor, frozen, recent-message, recent-code, analysis-code, error, and tool exclusions.
- Assistant, user, system, section, ratio, strict-accuracy, lossless, lossless-only, pipeline, and output-type controls.
- Per-tool profiles, external compressor registry, explicit module loading, and failure isolation.
- Cross-turn deduplication for Chat, Responses, and Anthropic inputs.
- Lexical relevance splitting for Chat, Responses, and Anthropic inputs.
- Terse levels `off`, `lite`, `full`, `ultra`, `wenyan-lite`, `wenyan-full`, `wenyan-ultra`.
- Input/output telemetry, SSE estimates, durable JSONL storage, model summaries, and `/stats/*` routes.
- CCR marker creation, threshold, TTL, capacity, retrieval, deletion, clear, status, marker toggle, and management auth.
- Non-sensitive `/stats/config` diagnostics.

### Runtime Variables

Port all current variables, preserving defaults:

```text
COPILOT_PARITY_ENABLE_OPTIMIZATION
COPILOT_PARITY_COMPRESS_ASSISTANT
COPILOT_PARITY_COMPRESS_USER
COPILOT_PARITY_COMPRESS_SYSTEM
COPILOT_PARITY_MIN_TOKENS
COPILOT_PARITY_MIN_CHARS
COPILOT_PARITY_MIN_SECTION_TOKENS
COPILOT_PARITY_MIN_RATIO_RELAXED
COPILOT_PARITY_MIN_RATIO_AGGRESSIVE
COPILOT_PARITY_FROZEN_MESSAGES
COPILOT_PARITY_PROTECT_RECENT
COPILOT_PARITY_PROTECT_RECENT_CODE
COPILOT_PARITY_PROTECT_ERRORS
COPILOT_PARITY_ERROR_MAX_CHARS
COPILOT_PARITY_COMPRESS_TAGGED
COPILOT_PARITY_EXCLUDE_TOOLS
COPILOT_PARITY_LOSSLESS
COPILOT_PARITY_LOSSLESS_ONLY
COPILOT_PARITY_COMPRESSION_MODE
COPILOT_PARITY_CODE_IMPORT_DEDUP
COPILOT_PARITY_BASH_TOOLS
COPILOT_PARITY_RELEVANCE_SPLIT
COPILOT_PARITY_CROSS_TURN_DEDUP
COPILOT_PARITY_JSON_COMPACTION
COPILOT_PARITY_LOG_COMPACTION
COPILOT_PARITY_SEARCH_COMPACTION
COPILOT_PARITY_DIFF_COMPACTION
COPILOT_PARITY_STRICT_ACCURACY
COPILOT_PARITY_CCR
COPILOT_PARITY_CCR_MIN_CHARS
COPILOT_PARITY_CCR_TTL_MS
COPILOT_PARITY_CCR_MAX_ENTRIES
COPILOT_PARITY_CCR_INJECT_MARKER
COPILOT_PARITY_EXTERNAL_COMPRESSORS
COPILOT_PARITY_EXTERNAL_COMPRESSOR_MODULES
COPILOT_PARITY_TOOL_PROFILES
COPILOT_PARITY_MANAGEMENT_TOKEN
COPILOT_PARITY_HOME_DIR
COPILOT_PARITY_TELEMETRY_FILE
```

### GitLab Validation

After each feature group:

```bash
npm test -- --grep "feature name"
```

Final validation:

```bash
npm install
npm test
npm run build
git diff --check
git ls-files | grep -E '(^|/)(node_modules|dist)/' || true
git ls-files | grep -E '(^|/)(\.env|.*auth.*\.json|.*telemetry.*\.jsonl|.*\.pem)$' || true
```

Live validation through GitLab organization settings:

```bash
curl -sS http://127.0.0.1:<PORT>/health
curl -sS http://127.0.0.1:<PORT>/stats/config
curl -sS http://127.0.0.1:<PORT>/stats/summary
```

Verify HTTP `200`, native model preservation, `/p/<project>/...` logs,
`/stats/latest` accounting, TLS, authentication, and unchanged organization
behavior. For CCR verify exact byte restoration, deletion, clear, status, TTL,
capacity eviction, unauthenticated `401`, and authorized management access.

Commit only after all tests, build, and organization-specific live checks pass.
Push only to GitLab. Never overwrite target organization changes.

## GHCP Copy-Paste Prompt

```text
Source: ghcp-parity-main, current feature-complete source repository.
Target: GitLab ghcp-parity, existing organization repository.
Baseline: 05c4144b07c3d4831a39ac1a8072c7bbf5ead3b3.

GitHub access is download-only. Download the source ZIP:
https://github.com/Binod310/ghcp-parity/archive/refs/heads/main.zip

Extract it locally as ghcp-parity-main. Do not clone, fetch, or push to GitHub.
Apply source features to GitLab target ghcp-parity.

Before editing:
1. Create backup branch in target.
2. Run git status --short.
3. Run git log --oneline --decorate --all -30.
4. Inspect target commits after 05c4144.
5. Compare source and target files.

Preserve every target organization change. Never use git reset --hard, git checkout --,
git clean -fd, broad file replacement, or automatic conflict-side selection.
Merge behavior selectively. Preserve target endpoints, authentication, TLS certificates,
model routing, telemetry, GitLab CI, deployment, settings, naming, and tests.

Add all applicable source features:
- Native Copilot routes, /p/:project forwarding, model ID preservation.
- Device OAuth, API-token exchange, refresh, one upstream 401 retry, Enterprise routing.
- Corporate CA support through COPILOT_CA_BUNDLE and NODE_EXTRA_CA_CERTS.
- Deterministic compression for repeated lines, blocks, paragraphs, logs, search, diffs,
	JSON, whitespace, tool schemas, JavaScript/TypeScript imports, XML, and shell output.
- Cache-anchor, frozen-message, recent-message, recent-code, analysis-code, error,
	excluded-tool, role, section, ratio, strict-accuracy, lossless, lossless-only,
	pipeline, JSON, output-type, and code-import controls.
- Per-tool profiles, external compressor registry, explicit module loading, shrink-only
	output acceptance, and plugin failure isolation.
- Cross-turn deduplication for Chat, Responses, and Anthropic inputs.
- Lexical relevance splitting for Chat, Responses, and Anthropic inputs.
- Terse levels off, lite, full, ultra, wenyan-lite, wenyan-full, wenyan-ultra.
- Input/output telemetry, SSE estimates, durable JSONL storage, model summaries, and
	stats endpoints.
- CCR markers, threshold, TTL, capacity eviction, retrieval, deletion, clear, status,
	marker toggle, and optional management bearer authentication.
- Non-sensitive /stats/config diagnostics.

Merge these source files while preserving target edits:
src/auth.ts
src/ccr.ts
src/cli.ts
src/code-compaction.ts
src/json-crusher.ts
src/lossless-compaction.ts
src/optimizer.ts
src/server.ts
src/stream-output.ts
src/telemetry-store.ts
src/telemetry.ts
src/terse-mode.ts
src/types.ts
src/upstream-agent.ts
src/vscode-config.ts

Merge matching tests plus:
tests/code-compaction.test.ts
tests/fixtures/external-compressor.cjs

Merge README.md, REMAINING_FEATURES.md, docs/caveman-mode.md, package files, and
tsconfig.json selectively. Do not copy node_modules, dist, logs, generated test files,
auth files, telemetry files, certificates, .env files, tokens, prompts, completions,
or secrets.

Preserve these runtime variables and documented defaults:
COPILOT_PARITY_ENABLE_OPTIMIZATION
COPILOT_PARITY_COMPRESS_ASSISTANT
COPILOT_PARITY_COMPRESS_USER
COPILOT_PARITY_COMPRESS_SYSTEM
COPILOT_PARITY_MIN_TOKENS
COPILOT_PARITY_MIN_CHARS
COPILOT_PARITY_MIN_SECTION_TOKENS
COPILOT_PARITY_MIN_RATIO_RELAXED
COPILOT_PARITY_MIN_RATIO_AGGRESSIVE
COPILOT_PARITY_FROZEN_MESSAGES
COPILOT_PARITY_PROTECT_RECENT
COPILOT_PARITY_PROTECT_RECENT_CODE
COPILOT_PARITY_PROTECT_ERRORS
COPILOT_PARITY_ERROR_MAX_CHARS
COPILOT_PARITY_COMPRESS_TAGGED
COPILOT_PARITY_EXCLUDE_TOOLS
COPILOT_PARITY_LOSSLESS
COPILOT_PARITY_LOSSLESS_ONLY
COPILOT_PARITY_COMPRESSION_MODE
COPILOT_PARITY_CODE_IMPORT_DEDUP
COPILOT_PARITY_BASH_TOOLS
COPILOT_PARITY_RELEVANCE_SPLIT
COPILOT_PARITY_CROSS_TURN_DEDUP
COPILOT_PARITY_JSON_COMPACTION
COPILOT_PARITY_LOG_COMPACTION
COPILOT_PARITY_SEARCH_COMPACTION
COPILOT_PARITY_DIFF_COMPACTION
COPILOT_PARITY_STRICT_ACCURACY
COPILOT_PARITY_CCR
COPILOT_PARITY_CCR_MIN_CHARS
COPILOT_PARITY_CCR_TTL_MS
COPILOT_PARITY_CCR_MAX_ENTRIES
COPILOT_PARITY_CCR_INJECT_MARKER
COPILOT_PARITY_EXTERNAL_COMPRESSORS
COPILOT_PARITY_EXTERNAL_COMPRESSOR_MODULES
COPILOT_PARITY_TOOL_PROFILES
COPILOT_PARITY_MANAGEMENT_TOKEN
COPILOT_PARITY_HOME_DIR
COPILOT_PARITY_TELEMETRY_FILE

After each feature group, run its focused test.
Then run:
npm install
npm test
npm run build
git diff --check

Run live GitLab validation:
curl -sS http://127.0.0.1:<PORT>/health
curl -sS http://127.0.0.1:<PORT>/stats/config
curl -sS http://127.0.0.1:<PORT>/stats/summary

Verify HTTP 200, native model preservation, /p/<project>/... logs, token accounting,
TLS, authentication, and unchanged organization behavior.

For CCR verify marker creation, exact byte retrieval, deletion, clear, status, TTL,
capacity eviction, missing-token 401, and authorized management access.

Before commit verify no node_modules/, dist/, generated artifacts, certificates,
credentials, telemetry data, or secrets are tracked.

Commit only after all tests, build, and live GitLab checks pass. Push only to GitLab.
Never overwrite target organization changes.
```
