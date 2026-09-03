| Strict accuracy guard | Accepts compression only when it reaches at least 20% savings, protecting detail in accuracy-sensitive workflows. | [optimizer.ts](src/optimizer.ts), [server.ts](src/server.ts), [types.ts](src/types.ts) | [optimizer.test.ts](tests/optimizer.test.ts) |
| Recent code protection | Keeps source code in recent messages byte-for-byte unchanged; configurable for cache and analysis safety. | [optimizer.ts](src/optimizer.ts), [server.ts](src/server.ts), [types.ts](src/types.ts) | [optimizer.test.ts](tests/optimizer.test.ts) |

# Copilot Parity Local

Local proxy for VS Code GitHub Copilot. It routes native Copilot requests through
`127.0.0.1`, preserves selected model IDs, compacts eligible input context, and
records per-request token estimates. No duplicate model appears in VS Code picker.

## Implemented Features

| Feature                      | Behavior                                                                                                                                                              | Source                                                                                                                                               | Tests / verification                                                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Native VS Code routing       | Routes Copilot Chat, agent, completions, model discovery, and native request paths through local proxy without changing `model`.                                      | [server.ts](src/server.ts)                                                                                                                           | Select models in VS Code; inspect `/stats/latest`.                                                                             |
| Safe VS Code lifecycle       | Adds/removes only marker-owned JSONC settings; supports macOS, Windows, Linux, custom settings files, and refuses unmanaged overrides.                                | [vscode-config.ts](src/vscode-config.ts)                                                                                                             | [vscode-config.test.ts](tests/vscode-config.test.ts)                                                                           |
| Copilot OAuth                | Device login, short-lived API-token exchange, expiry refresh, retry after upstream `401`, and Headroom-auth import.                                                   | [auth.ts](src/auth.ts)                                                                                                                               | [auth.test.ts](tests/auth.test.ts)                                                                                             |
| Enterprise routing           | Persists GitHub's validated advertised Business/Enterprise API endpoint; `COPILOT_BASE_URL` explicitly overrides it.                                                  | [auth.ts](src/auth.ts), [server.ts](src/server.ts)                                                                                                   | `curl -sS http://127.0.0.1:8796/health`                                                                                        |
| Input optimization           | Compacts eligible repeated/log/JSON text while protecting configured sensitive context and exact tool content.                                                        | [optimizer.ts](src/optimizer.ts), [lossless-compaction.ts](src/lossless-compaction.ts), [json-crusher.ts](src/json-crusher.ts)                       | `curl -sS http://127.0.0.1:8796/stats/summary`                                                                                 |
| Terse output mode            | Injects `lite`, `full`, `ultra`, and Wenyan levels without changing selected model.                                                                                   | [terse-mode.ts](src/terse-mode.ts), [types.ts](src/types.ts)                                                                                         | [terse-mode.test.ts](tests/terse-mode.test.ts), [docs/caveman-mode.md](docs/caveman-mode.md)                                   |
| Request telemetry            | Records route, model, status, input savings, and completed-stream output-token estimates. Persists only telemetry fields, never prompts, completions, or credentials. | [telemetry.ts](src/telemetry.ts), [telemetry-store.ts](src/telemetry-store.ts), [stream-output.ts](src/stream-output.ts), [server.ts](src/server.ts) | [telemetry.test.ts](tests/telemetry.test.ts), [stream-output.test.ts](tests/stream-output.test.ts), `/stats/requests`          |
| Corporate TLS                | Adds configured corporate CA bundle to Node's public trust roots for proxy and auth traffic.                                                                          | [upstream-agent.ts](src/upstream-agent.ts)                                                                                                           | `curl -sS http://127.0.0.1:8796/health`                                                                                        |
| Assistant compression        | Preserves assistant text by default for cache safety; enables deterministic compression with `COPILOT_PARITY_COMPRESS_ASSISTANT=1`.                                   | [optimizer.ts](src/optimizer.ts), [server.ts](src/server.ts), [types.ts](src/types.ts)                                                               | [optimizer.test.ts](tests/optimizer.test.ts)                                                                                   |
| Compression ratio gates      | Rejects compression that does not beat configured ratio thresholds; defaults accept any shrink.                                                                       | [optimizer.ts](src/optimizer.ts), [server.ts](src/server.ts), [types.ts](src/types.ts)                                                               | [optimizer.test.ts](tests/optimizer.test.ts)                                                                                   |
| Section-level threshold      | Splits long text at paragraph boundaries; preserves sections below `min_section_tokens` while compressing eligible sections.                                          | [optimizer.ts](src/optimizer.ts)                                                                                                                     | [optimizer.test.ts](tests/optimizer.test.ts)                                                                                   |
| Runtime size thresholds      | Configures minimum token, character, and section sizes through environment variables without code changes.                                                            | [optimizer.ts](src/optimizer.ts), [server.ts](src/server.ts), [types.ts](src/types.ts)                                                               | [optimizer.test.ts](tests/optimizer.test.ts)                                                                                   |
| Message protection           | Freezes cached prefix messages and protects recent active messages through runtime settings.                                                                          | [optimizer.ts](src/optimizer.ts), [server.ts](src/server.ts), [types.ts](src/types.ts)                                                               | [optimizer.test.ts](tests/optimizer.test.ts)                                                                                   |
| Error-output protection      | Preserves small error outputs by default; supports disabling protection or changing maximum protected size.                                                           | [optimizer.ts](src/optimizer.ts), [server.ts](src/server.ts), [types.ts](src/types.ts)                                                               | [optimizer.test.ts](tests/optimizer.test.ts)                                                                                   |
| XML-tag protection           | Preserves tagged blocks by default; optionally compresses tag content while keeping opening and closing markers.                                                      | [optimizer.ts](src/optimizer.ts), [server.ts](src/server.ts), [types.ts](src/types.ts)                                                               | [optimizer.test.ts](tests/optimizer.test.ts)                                                                                   |
| Role compression controls    | Enables or disables user and system message compression independently through environment settings.                                                                   | [optimizer.ts](src/optimizer.ts), [server.ts](src/server.ts), [types.ts](src/types.ts)                                                               | [optimizer.test.ts](tests/optimizer.test.ts)                                                                                   |
| Lossless compaction          | Enables or disables reversible log, grep, and diff compaction independently from other compression stages.                                                            | [optimizer.ts](src/optimizer.ts), [server.ts](src/server.ts), [types.ts](src/types.ts)                                                               | [optimizer.test.ts](tests/optimizer.test.ts)                                                                                   |
| Lossless-only mode           | Runs only reversible log, grep, and diff transforms; skips JSON crushing and whitespace normalization.                                                                | [optimizer.ts](src/optimizer.ts), [server.ts](src/server.ts), [types.ts](src/types.ts)                                                               | [optimizer.test.ts](tests/optimizer.test.ts)                                                                                   |
| Code import deduplication    | Removes exact duplicate JavaScript/TypeScript imports; configurable for exact source preservation.                                                                    | [code-compaction.ts](src/code-compaction.ts), [optimizer.ts](src/optimizer.ts), [server.ts](src/server.ts)                                           | [code-compaction.test.ts](tests/code-compaction.test.ts), [optimizer.test.ts](tests/optimizer.test.ts)                         |
| Tool compression profiles    | Applies per-tool overrides for lossless mode, tag/error protection, and compression thresholds.                                                                       | [optimizer.ts](src/optimizer.ts), [server.ts](src/server.ts), [types.ts](src/types.ts)                                                               | [optimizer.test.ts](tests/optimizer.test.ts)                                                                                   |
| Analysis-context protection  | Preserves code when recent user prompts request review, debugging, fixing, or analysis.                                                                               | [optimizer.ts](src/optimizer.ts), [server.ts](src/server.ts), [types.ts](src/types.ts)                                                               | [optimizer.test.ts](tests/optimizer.test.ts)                                                                                   |
| Shell-tool detection         | Applies lossless log compaction to configured shell tool outputs, including custom tool names.                                                                        | [optimizer.ts](src/optimizer.ts), [server.ts](src/server.ts), [types.ts](src/types.ts)                                                               | [optimizer.test.ts](tests/optimizer.test.ts)                                                                                   |
| Cross-turn deduplication     | Replaces repeated long text across Chat, Responses, and Anthropic message items with an explicit reference; disabled by default.                                      | [optimizer.ts](src/optimizer.ts), [server.ts](src/server.ts), [types.ts](src/types.ts)                                                               | [optimizer.test.ts](tests/optimizer.test.ts)                                                                                   |
| Relevance-aware compression  | Preserves sections matching latest user query across Chat, Responses, and Anthropic inputs while compressing unrelated sections; disabled by default.                 | [optimizer.ts](src/optimizer.ts), [server.ts](src/server.ts), [types.ts](src/types.ts)                                                               | [optimizer.test.ts](tests/optimizer.test.ts)                                                                                   |
| External compressor registry | Runs explicitly registered compressors after built-in stages; accepts shrink-only output and isolates plugin failures.                                                | [optimizer.ts](src/optimizer.ts), [server.ts](src/server.ts), [types.ts](src/types.ts)                                                               | [optimizer.test.ts](tests/optimizer.test.ts)                                                                                   |
| Compression pipeline modes   | Selects `lossless` or `lossless_then_lossy` processing for explicit safety/performance trade-offs.                                                                    | [optimizer.ts](src/optimizer.ts), [server.ts](src/server.ts), [types.ts](src/types.ts)                                                               | [optimizer.test.ts](tests/optimizer.test.ts)                                                                                   |
| CCR marker retrieval         | Stores large content locally and replaces it with an explicit retrievable marker; opt-in only.                                                                        | [ccr.ts](src/ccr.ts), [optimizer.ts](src/optimizer.ts), [server.ts](src/server.ts)                                                                   | [optimizer.test.ts](tests/optimizer.test.ts)                                                                                   |
| External module loading      | Loads explicit compressor modules at startup; invalid modules cannot prevent proxy startup.                                                                           | [optimizer.ts](src/optimizer.ts), [server.ts](src/server.ts), [types.ts](src/types.ts)                                                               | [optimizer.test.ts](tests/optimizer.test.ts), [tests/fixtures/external-compressor.cjs](tests/fixtures/external-compressor.cjs) |
| JSON compaction control      | Enables or disables JSON text crushing independently from lossless and whitespace stages.                                                                             | [optimizer.ts](src/optimizer.ts), [server.ts](src/server.ts), [types.ts](src/types.ts)                                                               | [optimizer.test.ts](tests/optimizer.test.ts)                                                                                   |
| Output-type compaction       | Enables or disables log, search/grep, and diff compaction independently.                                                                                              | [optimizer.ts](src/optimizer.ts), [server.ts](src/server.ts), [types.ts](src/types.ts)                                                               | [optimizer.test.ts](tests/optimizer.test.ts)                                                                                   |
| Runtime config diagnostics   | Reports active non-sensitive optimization flags and thresholds through `/stats/config`; never returns tokens, prompts, or completions.                                | [server.ts](src/server.ts)                                                                                                                           | `curl -sS http://127.0.0.1:9796/stats/config`                                                                                  |
| CCR lifecycle cleanup        | Deletes one marker or clears all in-memory CCR entries without restarting proxy.                                                                                      | [ccr.ts](src/ccr.ts), [server.ts](src/server.ts)                                                                                                     | [optimizer.test.ts](tests/optimizer.test.ts)                                                                                   |
| Management endpoint auth     | Optionally protects diagnostics and CCR management routes with a bearer token.                                                                                        | [server.ts](src/server.ts)                                                                                                                           | `curl -H 'Authorization: Bearer ...' http://127.0.0.1:9796/stats/config`                                                       |

CCR status diagnostics:

```bash
curl http://127.0.0.1:9796/ccr/status
```

Returns entry count and retention limits only. Management token authentication
also applies.

## Requirements

Exclude additional tools from compression:

```bash
COPILOT_PARITY_EXCLUDE_TOOLS=database_snapshot,custom_search
```

Built-in exclusions remain active. Tool names match case-insensitively,
including supported underscore/camel-case variants.

- Node.js 20 or later
- VS Code with GitHub Copilot enabled and signed in
- GitHub account with Copilot access
- Loopback access from VS Code extension host to `127.0.0.1`

## Setup

Install dependencies and build:

```bash
git clone https://github.com/Binod310/ghcp-parity.git
cd ghcp-parity
npm install
npm run build
```

Authorize parity with GitHub Copilot. Follow printed device-login URL and code:

```bash
npm run dev -- copilot-auth login
npm run dev -- copilot-auth status
```

The reusable OAuth credential and refreshed Copilot API token are stored locally
under `~/.copilot-parity-local/auth.json`; this file is ignored by Git.

Existing Headroom auth can be imported instead:

```bash
npm run dev -- copilot-auth import-headroom
npm run dev -- copilot-auth status
```

## Corporate TLS Inspection

On networks that intercept TLS, provide a PEM bundle containing the corporate CA
(for example, Zscaler) plus standard public roots. Node must receive the bundle at
process startup:

```bash
export COPILOT_CA_BUNDLE="$HOME/.headroom/certs/copilot-ca-bundle.pem"
export NODE_EXTRA_CA_CERTS="$HOME/.headroom/certs/copilot-ca-bundle.pem"
```

Without corporate TLS inspection, omit these variables. Never set
`NODE_TLS_REJECT_UNAUTHORIZED=0`.

## Configure VS Code

Add a marker-owned block to VS Code user settings:

```bash
npm run dev -- wrap vscode --port 8796 --project Headroom
```

Use `--project <name>` to label the proxy URL for a project. Use a specific
settings file for Insiders, VSCodium, remote development, or custom profiles:

```bash
npm run dev -- wrap vscode --port 8796 --project MyProject \
  --settings-file /path/to/User/settings.json
```

`--no-configure` prints settings without changing files. The managed block adds:

- `github.copilot.advanced.debug.overrideProxyUrl`
- `github.copilot.advanced.debug.overrideCapiUrl`
- `github.copilot.advanced.chatOverrideProxyUrl`

Restart VS Code after configuring. Continue using native model picker: selected
models travel through parity unchanged.

Remove only parity's settings block:

```bash
npm run dev -- wrap vscode-remove
```

Pass same `--settings-file` value when one was used during setup.

## Run

Start the proxy with input optimization:

```bash
env \
  COPILOT_CA_BUNDLE="$COPILOT_CA_BUNDLE" \
  NODE_EXTRA_CA_CERTS="$NODE_EXTRA_CA_CERTS" \
  npm run dev -- proxy --port 8796
```

Enable terse output mode as well. This injects a concise-response instruction into
native Chat Completions, Responses, and Anthropic Messages requests; it preserves
model ID, code, identifiers, error text, negation, and numbers:

```bash
env \
  COPILOT_PARITY_TERSE_MODE=ultra \
  COPILOT_CA_BUNDLE="$COPILOT_CA_BUNDLE" \
  NODE_EXTRA_CA_CERTS="$NODE_EXTRA_CA_CERTS" \
  npm run dev -- proxy --port 8796
```

Supported terse levels: `off` (default), `lite`, `full`, `ultra`, `wenyan-lite`,
`wenyan-full`, `wenyan-ultra`. Per-request override: header
`x-copilot-parity-terse`. Full caveman mode contract: [docs/caveman-mode.md](docs/caveman-mode.md).
Stop proxy with `Ctrl+C`. While stopped, configured Copilot requests fail rather
than bypass parity.

Assistant text remains unchanged by default because changing cached assistant
bytes can reduce provider prefix-cache hits. Enable this trade-off explicitly:

```bash
COPILOT_PARITY_COMPRESS_ASSISTANT=1
```

Set compression acceptance thresholds from `0` exclusive to `1` inclusive:

```bash
COPILOT_PARITY_MIN_RATIO_RELAXED=0.85
COPILOT_PARITY_MIN_RATIO_AGGRESSIVE=0.70
```

Compression is accepted only when `compressed_size / original_size` is below
the selected threshold. Invalid values fall back to `1`.

Runtime size thresholds:

```bash
COPILOT_PARITY_MIN_TOKENS=250
COPILOT_PARITY_MIN_CHARS=500
COPILOT_PARITY_MIN_SECTION_TOKENS=20
```

Invalid or non-positive values use defaults.

Message protection controls:

```bash
COPILOT_PARITY_FROZEN_MESSAGES=0
COPILOT_PARITY_PROTECT_RECENT=0
```

Frozen messages and recent messages remain unchanged. Cache-anchored prefixes
stay protected regardless of these values.

Protect source code in last `N` messages:

```bash
COPILOT_PARITY_PROTECT_RECENT_CODE=4
```

Error-output protection controls:

```bash
COPILOT_PARITY_PROTECT_ERRORS=1
COPILOT_PARITY_ERROR_MAX_CHARS=8000
```

Protection is enabled by default. Set `COPILOT_PARITY_PROTECT_ERRORS=0` to allow
eligible error logs to compress.

XML-tag compression:

```bash
COPILOT_PARITY_COMPRESS_TAGGED=1
```

Default preserves complete tagged blocks byte-for-byte. Opt-in changes only tag
content; tag markers remain intact.

Role compression controls:

```bash
COPILOT_PARITY_COMPRESS_USER=1
COPILOT_PARITY_COMPRESS_SYSTEM=1
```

Both are enabled by default. Set either variable to `0` to preserve that role's
content unchanged.

Lossless compaction control:

```bash
COPILOT_PARITY_LOSSLESS=1
```

Enabled by default. Set to `0` to disable reversible log, grep, and diff folding.

Lossless-only mode:

```bash
COPILOT_PARITY_LOSSLESS_ONLY=1
```

Useful when exact non-lossless content must remain unchanged.

Code-aware import deduplication:

```bash
COPILOT_PARITY_CODE_IMPORT_DEDUP=1
```

Enabled by default. Set to `0` to preserve duplicate imports exactly.

Per-tool compression profiles use JSON at proxy startup:

```bash
COPILOT_PARITY_TOOL_PROFILES='{"database_snapshot":{"lossless_compaction":false,"protect_error_outputs":true}}'
```

Supported fields include `lossless_compaction`, `compress_tagged_content`,
`protect_error_outputs`, `error_protection_max_chars`,
`min_tokens_to_compress`, `min_chars_for_block_compression`,
`min_section_tokens`, and `code_aware_import_deduplication`.

Analysis-context protection:

```bash
COPILOT_PARITY_PROTECT_ANALYSIS=1
```

Enabled by default. Set to `0` to allow code compression during analysis prompts.

Configure shell-tool names:

```bash
COPILOT_PARITY_BASH_TOOLS=bash,shell,terminal_exec
```

Configured shell outputs enter the lossless log-compaction path.

Enable cross-turn deduplication:

```bash
COPILOT_PARITY_CROSS_TURN_DEDUP=1
```

Repeated text of at least `500` characters becomes an explicit in-context
reference. Disabled by default because references require original content to
remain in the same request.

Enable relevance-aware compression:

```bash
COPILOT_PARITY_RELEVANCE_SPLIT=1
```

Latest user query terms preserve matching paragraph sections. Unrelated sections
remain eligible for compression. Disabled by default.

Activate registered external compressors by name:

```bash
COPILOT_PARITY_EXTERNAL_COMPRESSORS=plugin_name
```

Plugins register through `registerExternalCompressor`. Unknown names are ignored,
exceptions are isolated, and plugins cannot expand content.

Load modules by absolute or resolvable path:

```bash
COPILOT_PARITY_EXTERNAL_COMPRESSOR_MODULES=/path/to/compressor.cjs
```

Module shape: `{ name, compress(text) }`. Combine with
`COPILOT_PARITY_EXTERNAL_COMPRESSORS` to activate loaded names.

JSON text compaction:

```bash
COPILOT_PARITY_JSON_COMPACTION=1
```

Enabled by default. Set to `0` to preserve JSON text while leaving other stages
available.

Control lossless compaction by output type:

```bash
COPILOT_PARITY_LOG_COMPACTION=1
COPILOT_PARITY_SEARCH_COMPACTION=1
COPILOT_PARITY_DIFF_COMPACTION=1
```

All are enabled by default. Set any flag to `0` to preserve that output type.

Select compression pipeline:

```bash
COPILOT_PARITY_COMPRESSION_MODE=lossless
```

Supported values: `lossless` and `lossless_then_lossy` (default).

Enable CCR markers for content at least `10000` characters:

```bash
COPILOT_PARITY_CCR=1
```

Retrieve content with `GET /ccr/retrieve/:id`. Disabled by default because native
VS Code Copilot does not automatically call retrieval endpoints. Use only when
client or tool loop understands `[CCR:...]` markers.

Change CCR activation size:

```bash
COPILOT_PARITY_CCR_MIN_CHARS=10000
```

Default: `10000` characters.

Control marker injection separately:

```bash
COPILOT_PARITY_CCR_INJECT_MARKER=0
```

CCR remains enabled, but large content uses normal compression instead of a
retrieval marker.

Bound CCR memory retention:

```bash
COPILOT_PARITY_CCR_TTL_MS=3600000
COPILOT_PARITY_CCR_MAX_ENTRIES=1000
```

Expired entries are removed on retrieval. Oldest entries are evicted when the
capacity limit is reached.

Clean up CCR entries explicitly:

```bash
curl -X DELETE http://127.0.0.1:9796/ccr/retrieve/ccr_1
curl -X POST http://127.0.0.1:9796/ccr/clear
curl http://127.0.0.1:9796/ccr/status
```

Protect diagnostics and CCR management routes:

```bash
export COPILOT_PARITY_MANAGEMENT_TOKEN='local-secret'
curl -H "Authorization: Bearer $COPILOT_PARITY_MANAGEMENT_TOKEN" \
  http://127.0.0.1:9796/stats/config
```

Unset token for default local behavior. Never commit token values.

Strict accuracy guard:

```bash
COPILOT_PARITY_STRICT_ACCURACY=1
```

Disabled by default. When enabled, compression is rejected unless it saves at
least 20%.

Default: `4`. Set `0` to disable this code-specific protection.

For Business and Enterprise accounts, parity uses the validated API endpoint
advertised during token exchange, such as `https://api.business.githubcopilot.com`.
Set `COPILOT_BASE_URL` only when intentionally pinning a different Copilot API host.

## Verify

With proxy running:

```bash
curl -sS http://127.0.0.1:8796/health
curl -sS http://127.0.0.1:8796/stats/latest
curl -sS http://127.0.0.1:8796/stats/summary
curl -sS http://127.0.0.1:9796/stats/config
```

Health response must include `"ok":true`, `"token_configured":true`, and
`"copilot_base_url":"https://api.githubcopilot.com"`. In VS Code, select a model
and send a short chat prompt. Proxy log and `/stats/latest` should show its native
route and model, for example `claude-sonnet-5` on `/v1/messages` or `gpt-5.6-terra`
on `/responses`. `gpt-4o-mini-2024-07-18` requests on `/chat/completions` are
typically Copilot's separate internal title, todo, or command-risk helper calls.

`saved_tokens` measures estimated input-token reduction from request compaction.
`total_output_tokens` measures text estimated from completed native SSE streams.
It is not output-token savings: providers often omit a baseline output count, so
terse-mode savings require a controlled comparison.

Telemetry persists across restarts at
`~/.copilot-parity-local/telemetry.jsonl`, with user-only permissions. It contains
route, model, status, timestamp, and numeric usage fields only. Set
`COPILOT_PARITY_TELEMETRY_FILE` to choose another local file.

## Local auth flow

1. Direct login: `npm run dev -- copilot-auth login`
2. Import existing Headroom token: `npm run dev -- copilot-auth import-headroom`
3. Check auth status: `npm run dev -- copilot-auth status`
4. Refresh expired API token: `npm run dev -- copilot-auth refresh`

Device-login options:

- Enterprise/custom GitHub host:
  npm run dev -- copilot-auth login --domain github.example.com
- Store OAuth token without Copilot API token exchange:
  npm run dev -- copilot-auth login --no-exchange

Automatic runtime behavior:

- If a stored token is OAuth, proxy auto-exchanges it to a Copilot API token.
- If a stored API token is expired and refresh token exists, proxy auto-refreshes it.
- If upstream returns 401 once, proxy attempts one forced refresh retry.
- If caller sends Authorization: Bearer <token>, proxy forwards that token first.
- Proxy applies lightweight prompt compaction before forwarding requests.
- Proxy honors x-headroom-base-url and x-headroom-original-path headers for upstream override routing.
- All upstream model and inference calls use COPILOT_TIMEOUT_MS (default 60000).

Optimization toggle:

- Enabled by default.
- Disable with environment variable:
  COPILOT_PARITY_ENABLE_OPTIMIZATION=0

Optional manual token setup:

1. Set token directly:
   npm run dev -- copilot-auth set-token --token <TOKEN>
2. Remove stored token:
   npm run dev -- copilot-auth logout

Status output fields include:

- configured
- expired
- tokenType (api or oauth)
- hasRefreshToken

## Telemetry endpoints

- Health: GET /health
- Auth status: GET /stats/auth
- Latest request telemetry: GET /stats/latest
- Request telemetry history: GET /stats/requests
- Request summary totals: GET /stats/summary

## Comparison endpoint

- Compare baseline and optimized runs for one payload:
  POST /v1/responses/compare
  POST /v1/chat/completions/compare
  POST /v1/messages/compare

## Request endpoints

- Responses API passthrough:
  POST /v1/responses
- Chat Completions passthrough:
  POST /v1/chat/completions
- Anthropic Messages passthrough:
  POST /v1/messages
- GHCP model discovery passthrough:
  GET /models
  GET /v1/models

## Model compatibility

- Some models are endpoint-specific and may be rejected with 400 errors.
- To discover supported models for your account, query:
  GET https://api.githubcopilot.com/models
- Use models whose supported_endpoints include the route you call
  (for example /chat/completions for chat-completions passthrough).

Response includes:

- baseline.status and baseline.usage
- optimized.status and optimized.usage
- telemetry with before/after/saved token and AIU values

Telemetry measurement field:

- provider: usage from upstream provider fields
- estimated: usage estimated locally when provider usage is missing
- unavailable: no usable token metrics available
