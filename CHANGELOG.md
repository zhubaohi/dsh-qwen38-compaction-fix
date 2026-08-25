# Changelog

## Unreleased (2026-08-25)

### Fixed

- **Signature gates no longer match conversation turns that quote the provider prompts.** The compaction and session-title fetch layers previously identified their target requests by searching for the prompt signatures *anywhere* in the request body. A conversation turn whose history quoted either signature — tool results, file reads of this plugin's own source, session-log dumps — matched the title gate and got `reasoning_effort: none` stamped onto a normal chat request, making thinking look globally disabled. Both gates now require structural prefix matches: the compaction instruction must start the final user message's text, and the title prompt must start a system/developer message's text. Real compaction/title calls are unaffected (both providers send their prompts verbatim as the first text of those messages).

## 1.0.0 (2026-08-25)

Initial release.

- `llm/stream` waterfall layer: stamps `reasoningEffort: "off"` on calls whose `purpose` is in `purposes` and whose `options.model` is in `models`; resolves the model's offered efforts with preference order configured → `off` → `low`.
- HTTP sampling layer: process-global `fetch` wrapper applies the configured `sampling` entries to compaction request bodies (identified by the dsh-compaction-basic instruction signature + allowed `model`).
- HTTP max_tokens floor layer: raises the wire `max_tokens`/`max_completion_tokens` of compaction bodies to at least `maxTokensFloor` (raise-only), restoring the output budget when pi-ai's client-side context clamp collapses it.
- HTTP session-title layer: writes the configured `reasoning_effort` wire value into session-title request bodies (identified by the dsh-session-title-llm system-prompt signature + allowed `model`); leaves the title plugin's own `max_tokens` untouched.
- Model allow-list (`models`, default `["qwen3.8-27b"]`) enforced at every layer; empty list disables the whole policy.
- Settings section `qwen38-compaction-fix:` in `$DSH_HOME/settings.yaml` overrides the bundle config live, without a restart.

### Verification

Gating smoke test against the published module (all cases pass):

| Case | Result |
|---|---|
| Compaction body, model `qwen3.8-27b` | rewritten: sampling applied, `max_tokens` raised to floor |
| Compaction body, model `gpt-4.1` | untouched |
| Compaction body, missing `model` field | untouched |
| Compaction body, empty `models` list | untouched |
| Title body, model `qwen3.8-27b` | rewritten: `reasoning_effort: none`, `max_tokens` left alone |
| Title body, model `Gemma4-12B-...` | untouched |
| Title body, `titleReasoning: ""` | untouched |
| Conversation turn quoting the compaction signature in a tool result | untouched (regression case) |
| Conversation turn quoting the title signature in a tool result | untouched (regression case — was the bug) |
| Last user message containing (not starting with) the compaction signature | untouched |
| User-role message starting with the title signature | untouched (signature must be in system/developer) |