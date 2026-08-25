# dsh-qwen38-compaction-fix

Fix for a local **qwen3.8-27b** gateway that fails to compact: the model thinks at `xhigh`, spends its entire output token budget on reasoning before reaching a conclusion, and the compaction checkpoint comes back truncated. This [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) plugin disables thinking **for compaction calls only** — and applies the model's non-thinking sampling parameters to those calls.

## The symptom

When context pressure builds, dsh compacts the conversation into a checkpoint. With a local qwen3.8-27b running at its default reasoning level, compaction sometimes fails, and the session is left with exactly this line:

> summarization truncated at the token cap (incomplete checkpoint)

That is dsh-compaction-basic's verdict that the summarizer hit its output token cap without finishing. The conversation is condensed only into the truncated text — everything the summary never reached is effectively lost from context.

## Why it happens

Local qwen3.8-27b deployments think at their default effort — `xhigh` in a typical route config — on every call that does not explicitly set a reasoning effort. Compaction is one such call: the model is asked to write a long summary of the whole conversation. At `xhigh`, it spends the **entire `max_tokens` output budget on reasoning tokens before ever writing a word of the summary**. The response hits the cap with no conclusion → the truncated checkpoint above.

## The fix

1. **Disable thinking for compaction only.** Stamps `reasoning_effort: "off"` onto the compaction call (waterfall layer, resolved through the model's `reasoningEfforts` declaration to the wire value `reasoning_effort: "none"`): zero reasoning tokens, and the whole output budget is available for the summary. Every other call — normal turns, subagents, any other model — keeps the route's `xhigh`. Thinking is never disabled globally.
2. **Apply the non-thinking sampling parameters.** qwen3.8-27b publishes different recommended sampling parameters for thinking mode and non-thinking mode. The plugin writes the non-thinking set (`temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0.0, presence_penalty: 1.5, repetition_penalty: 1.0`) into the compaction request body, so the request actually matches the mode it is in.
3. **Restore the output budget.** Raises the wire `max_tokens` of compaction bodies to a configurable floor (default `16384`, raise-only — never lowered), undoing pi-ai's client-side context clamp that can collapse the compaction request's `max_tokens` on large conversations.
4. **Fix session titles (secondary).** Session-title generation runs on the same route with a tiny output budget (`maxTokens: 64`), so xhigh thinking truncates titles too. The plugin writes the configured `reasoning_effort` wire value into title request bodies (the title provider deep-freezes its LLM options before the waterfall, so only the wire body is reachable).

Everything else is untouched: every gate is purpose-based AND model-based (waterfall) or signature-based AND model-based (HTTP), so conversation turns, subagents, and any other model pass through byte-identical with route defaults. Every gate fails open.

## ⚠️ The model name must match — read this first

The plugin only acts when the `model` field of the outgoing request matches an id in its allow-list: `models`, default **exactly `qwen3.8-27b`**, case-sensitive. It is an **exact id match — not a family or substring match** — because the sampling parameters written into the body are model-specific and would be wrong for any other model.

**What id is being compared:** the model `id` your route serves — the one declared under `llm-pi-ai.providers.<provider>.models[].id` in `$DSH_HOME/settings.yaml`. That is the value dsh puts in the `model` field of every outgoing request to your gateway (it is *not* whatever name your gateway internally calls the model).

**Make it match — either of two places works:**

1. The `qwen38-compaction-fix:` section of `$DSH_HOME/settings.yaml` (applies live, no restart):

   ```yaml
   qwen38-compaction-fix:
     models: [your-actual-model-id]
   ```

2. The `config:` block of the plugin row in your profile's `cordis.patch.yml` (applies on the next GUI load):

   ```yaml
   - id: qwen38-compaction-fix
     config:
       models: [your-actual-model-id]
   ```

If your gateway serves the model under a different id — a custom model name, a suffixed variant, different casing — add *that* id to `models`. The sampling values stay the same; only the id has to match.

**If nothing matches, the plugin silently does nothing:** every request passes through byte-identical, and there is no warning on a miss. If you installed this plugin and you still see the truncated checkpoint, check the model id first.

## Install

```sh
dsh plugin --profile web add zhubaohi/dsh-qwen38-compaction-fix
```

Then restart `dsh web` (or refresh the GUI page).

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
| `models` | `["qwen3.8-27b"]` | Exact model ids (case-sensitive) the policy applies to, checked at every layer. Empty list disables the whole policy. See [the model-name section](#-the-model-name-must-match--read-this-first). |
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

- Model matching is an **exact id match** against the id declared under `llm-pi-ai.providers.<provider>.models[].id` in `settings.yaml` — see [the model-name section](#-the-model-name-must-match--read-this-first).
- The HTTP-layer signatures track specific dsh releases; see "How it works" for the fail-open behavior.
- This plugin shapes requests for the *local gateway* you run; it does not change the harness's own routing or the server's real capacity limits (the server still enforces them).

## Testing

The gating logic is covered by a smoke test (see [CHANGELOG.md](./CHANGELOG.md#verification)): allowed-model bodies are rewritten with the expected sampling/floor/reasoning values; disallowed-model, missing-model, and empty-allow-list bodies pass through byte-identical.

## License

MIT — see [LICENSE](./LICENSE).