# dsh-qwen38-compaction-fix

Thinking-off compaction and session-title fix for local **qwen3.8-27b** gateways, as a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) plugin.

## The problem

Local qwen3.8-27b deployments think at their default level — `xhigh` in a typical route config — on every call that does not explicitly set a reasoning effort. DSH issues two auxiliary LLM calls on the conversation's own route:

1. **Compaction summarization** (`purpose: "compaction"`, dsh-compaction-basic) — condenses the conversation into a checkpoint when context pressure builds.
2. **Session-title generation** (`purpose: "session-title"`, dsh-session-title-llm) — produces the sidebar title with a tiny output budget (`maxTokens: 64`).

When the gateway honors `reasoning_effort`, the model spends its entire small output budget on *reasoning* tokens: the summary comes back truncated ("summarization truncated at the token cap") or the title finishes `length` with empty content and falls back to the deterministic first-prompt title. On top of that, pi-ai's client-side context clamp can collapse the compaction request's `max_tokens` to 1 for large conversations, guaranteeing a one-token result.

## What this plugin does

For calls targeting an allowed model (default: exactly `qwen3.8-27b`), it:

- **Turns thinking off** on compaction calls — stamps `reasoningEffort: "off"` on the `llm/stream` waterfall, which the pi-ai adapter resolves through the model's `reasoningEfforts` declaration (`off: none`) and sends as `reasoning_effort: "none"` on the wire: zero reasoning tokens.
- **Applies non-thinking sampling settings** (`temperature`, `top_p`, `top_k`, `min_p`, `presence_penalty`, `repetition_penalty`) to the compaction request body via a process-local `fetch` wrapper.
- **Restores the output budget**: raises the wire `max_tokens` of compaction bodies to a configurable floor (never lowers it), undoing pi-ai's collapsed clamp.
- **Fixes session titles**: writes the configured `reasoning_effort` wire value into title request bodies (the title provider deep-freezes its LLM options before the waterfall, so only the wire body is reachable).

Everything else is untouched: the gates are purpose-based AND model-based (waterfall) / signature-based AND model-based (HTTP), so conversation turns, subagents, and any other model pass through byte-identical with route defaults.

## Install

```sh
dsh plugin --profile web add zhubaohi/dsh-qwen38-compaction-fix
```

Then restart `dsh web` (or refresh the GUI page). No API keys, no network access, no telemetry.

## Configuration

All keys are optional; defaults are applied by the schema. Precedence (highest first):

1. `qwen38-compaction-fix:` section of `$DSH_HOME/settings.yaml` (applies live, no restart)
2. the `config:` block of the plugin row in your profile's `cordis.patch.yml`
3. built-in defaults

Example `settings.yaml`:

```yaml
qwen38-compaction-fix:
  effort: off            # "" disables the effort policy
  models: [qwen3.8-27b]  # exact ids; [] disables the whole policy
  sampling:              # wire field names, written verbatim into the body
    temperature: 0.7
    top_p: 0.8
    top_k: 20
    min_p: 0.0
    presence_penalty: 1.5
    repetition_penalty: 1.0
  maxTokensFloor: 16384  # 0 disables the floor
  titleReasoning: none   # "" disables the title gate
```

| Key | Default | Meaning |
|---|---|---|
| `effort` | `"off"` | Reasoning effort stamped onto matched calls. Preference order: configured → `off` → `low`; a model offering none of them keeps its own default (one-time warning). `""` disables the effort policy. |
| `purposes` | `["compaction"]` | `purpose` tags of LLM calls the waterfall layer applies to. |
| `models` | `["qwen3.8-27b"]` | Exact model ids (case-sensitive) the policy applies to, checked at every layer. Empty list disables the whole policy. |
| `sampling.*` | `{}` | Sampling settings written verbatim into compaction request bodies. Absent keys stay absent. |
| `maxTokensFloor` | `16384` | Compaction bodies' wire `max_tokens`/`max_completion_tokens` are raised to at least this value (never lowered). `0` disables. |
| `titleReasoning` | `"none"` | Wire `reasoning_effort` value written into session-title request bodies. `""` disables the gate. |

A per-call explicit `reasoningEffort` always wins over the plugin default.

## How it works

Four cooperating layers:

1. **`llm/stream` waterfall** — for calls whose `purpose` is in `purposes` and whose `options.model` is in `models`, resolves the model's offered reasoning efforts and stamps the chosen effort in place before dispatch.
2. **HTTP sampling** — wraps the process-global `fetch`; when a chat-completion body carries the compaction engine's final instruction (a stable signature) AND its `model` field is allowed, applies the configured sampling entries.
3. **HTTP max_tokens floor** — same gate; raises the output cap to the floor (raise-only).
4. **HTTP session-title reasoning** — when a body carries the title provider's system prompt (stable signature) AND its `model` is allowed, writes the configured `reasoning_effort` wire value.

Identity at the HTTP layer relies on the instruction text shipped by dsh-compaction-basic and dsh-session-title-llm. If a future dsh release changes those instructions, the matching HTTP gate silently stops matching and the body keeps its wire defaults — the other gates are unaffected, and nothing ever breaks LLM traffic (every guard fails open).

## Limitations

- The model allow-list is an **exact id match** against the id declared under `llm-pi-ai.providers.<provider>.models[].id` in `settings.yaml` — not a family/substring match.
- The HTTP-layer signatures track specific dsh releases; see "How it works" for the fail-open behavior.
- This plugin shapes requests for the *local gateway* you run; it does not change the harness's own routing or the server's real capacity limits (the server still enforces them).

## Testing

The gating logic is covered by a smoke test (see [CHANGELOG.md](./CHANGELOG.md#verification)): allowed-model bodies are rewritten with the expected sampling/floor/reasoning values; disallowed-model, missing-model, and empty-allow-list bodies pass through byte-identical.

## License

MIT — see [LICENSE](./LICENSE).
