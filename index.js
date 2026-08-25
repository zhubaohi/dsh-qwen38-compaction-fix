/**
 * qwen3.8-27b (ninfer gateway) compaction thinking fix:
 * auxiliary LLM calls (compaction summarization AND session-title generation)
 * run with thinking OFF, exact sampling settings, and a `max_tokens` floor —
 * but ONLY for the models in the `models` allow-list (`qwen3.8-27b` by
 * default). Every other model passes through byte-identical with its route
 * defaults.
 *
 * Why this exists: local qwen3.8-27b deployments (e.g. served through the
 * ninfer gateway) think at their default level (`xhigh`) on every call that
 * does not explicitly set an effort. The two auxiliary calls DSH issues on
 * the conversation's own route — compaction summarization and session-title
 * generation — carry small output budgets; when the gateway honors
 * `reasoning_effort`, the model spends that entire budget on reasoning
 * tokens, finishes `length` with empty or truncated content, and the
 * summarizer reports "truncated at the token cap" while every generated
 * title fails back to the first-prompt fallback. This plugin turns thinking
 * off for exactly those calls (wire `reasoning_effort: none`), applies
 * non-thinking-appropriate sampling settings, and restores the collapsed
 * `max_tokens` budget — gated to a model allow-list so nothing else is
 * touched.
 *
 * Layer 1 (this file's core): the `llm/stream` waterfall stamps
 * `reasoningEffort: "off"` on calls whose `purpose` is in `purposes`
 * (default: `["compaction"]`, the compaction engine's own tag) AND whose
 * `options.model` is in `models`. The pi-ai adapter resolves "off" through
 * the model's `reasoningEfforts` declaration (`off: none`) and sends
 * `reasoning_effort: "none"` on the wire — zero reasoning tokens.
 *
 * Per-call semantics (waterfall layer):
 *   - only calls whose `purpose` is in `purposes` AND whose `options.model`
 *     is in `models` are touched;
 *   - a call that already carries an explicit `reasoningEffort` wins —
 *     per-call beats the plugin default;
 *   - effort preference order: configured, then `off`, then `low`; a model
 *     offering none of them is left at its own default (one-time warning);
 *   - `effort: ""` disables the effort policy.
 *
 * Configuration precedence (re-projected on every LLM call, so settings.yaml
 * edits apply without a restart):
 *   1. `qwen38-compaction-fix:` section of `$DSH_HOME/settings.yaml`
 *   2. the `config:` block of this plugin's row in the profile's
 *      `cordis.patch.yml`
 *   3. built-in defaults (effort `"off"`, purposes `["compaction"]`,
 *      models `["qwen3.8-27b"]`)
 */
import z from "@deepseek-ai/schemastery";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";

/** Cordis plugin name used by loader diagnostics. */
const name = "qwen38-compaction-fix";
/** Hard dependency: the LLM service owns the `llm/stream` waterfall. */
const inject = ["llm"];

/** Default summarization effort: thinking off, not the conversation's default. */
const DEFAULT_EFFORT = "off";
/** Primary fallback: the whole point is no thinking. */
const OFF_EFFORT = "off";
/** Secondary fallback when `off` is not expressible. */
const FALLBACK_EFFORT = "low";
/** LLM call purposes this policy applies to by default. */
const DEFAULT_PURPOSES = ["compaction"];
/**
 * Default model allow-list: the ninfer qwen3.8-27b deployment this plugin
 * was tuned for. Exact id match against `settings.yaml`'s
 * `llm-pi-ai.providers.qwen.models[].id`. An empty list disables the policy.
 */
const DEFAULT_MODELS = ["qwen3.8-27b"];

/** Plugin config (all keys optional; defaults applied by the schema). */
const Config = z.object({
  /** Reasoning effort stamped onto matched calls. `""` disables the effort policy. Default `"off"`. */
  effort: z.string().default(DEFAULT_EFFORT),
  /** `purpose` tags of LLM calls the policy applies to. Default `["compaction"]`. */
  purposes: z.array(z.string()).default(DEFAULT_PURPOSES),
  /**
   * Exact model ids the policy applies to (case-sensitive, as declared in
   * settings.yaml). A call/body whose model is not in this list passes
   * through untouched. Empty list disables the policy entirely.
   * Default `["qwen3.8-27b"]`.
   */
  models: z.array(z.string()).default(DEFAULT_MODELS)
});

/** Settings namespace carrying this plugin's policy. */
const COMPACT_EFFORT_SETTINGS_NAMESPACE = settingsNamespace("qwen38-compaction-fix");

/**
 * Pick the first level the model can express, in preference order: the
 * configured level, then `off`, then `low`.
 * @param configured - the configured (non-empty) effort.
 * @param offeredIds - effort ids the target model's reasoning metadata offers.
 * @returns the chosen effort id, or undefined when the model offers none.
 */
function chooseEffort(configured, offeredIds) {
  const seen = new Set();
  for (const candidate of [configured, OFF_EFFORT, FALLBACK_EFFORT]) {
    if (candidate.length === 0 || seen.has(candidate)) continue;
    seen.add(candidate);
    if (offeredIds.includes(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Install the compaction policy on the `llm/stream` waterfall.
 * @param ctx - plugin context owning the listener and the settings wiring.
 * @param config - composition entry config (base layer under settings.yaml).
 */
function apply(ctx, config = {}) {
  let current = () => config;
  installSettingsSection(ctx, COMPACT_EFFORT_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => {
      current = source;
    },
    onChange: () => {}
  });
  const warned = new Set();
  ctx.on("llm/stream", (options, next) => {
    const cfg = current();
    const configured = typeof cfg.effort === "string" ? cfg.effort : DEFAULT_EFFORT;
    if (configured.length === 0) return next();
    if (options === null || typeof options !== "object" || typeof options.purpose !== "string") return next();
    const purposes = Array.isArray(cfg.purposes) && cfg.purposes.length > 0 ? cfg.purposes : DEFAULT_PURPOSES;
    if (!purposes.includes(options.purpose)) return next();
    // Model gate: only stamp calls targeting an allowed model.
    const models = Array.isArray(cfg.models) ? cfg.models : DEFAULT_MODELS;
    if (!models.includes(options.model)) return next();
    // An explicit per-call effort always wins over the plugin default.
    if (options.reasoningEffort !== undefined) return next();
    // A lazy async generator (not a promise): every llm/stream stage and
    // consumer deals in iterables, and the capability lookup + stamp happen
    // when the stream is first pumped — before the adapter dispatch starts.
    return (async function* () {
      let info;
      try {
        info = await ctx.llm.resolveModelInfo(options.provider, options.model, options.signal);
      } catch {
        // Capability lookup failed: leave the call untouched; its own
        // dispatch reports the real error.
        yield* next();
        return;
      }
      const offered = ((info ?? {}).reasoning?.efforts ?? []).map((effort) => effort.id);
      const chosen = chooseEffort(configured, offered);
      if (chosen !== undefined) {
        // The compaction engine builds a plain (unfrozen) options object and
        // the llm/stream default dispatch closes over this exact object, so
        // the in-place stamp reaches the adapter's wire mapping.
        try {
          options.reasoningEffort = chosen;
        } catch {
          /* frozen options: leave the model default in place */
        }
      } else {
        const key = `${options.provider}/${options.model}`;
        if (!warned.has(key)) {
          warned.add(key);
          ctx.logger.warn(
            `qwen38-compaction-fix: model "${key}" offers no expressible reasoning effort (configured "${configured}"); compaction keeps the model default`
          );
        }
      }
      yield* next();
    })();
  });
}

export { name, inject, Config, COMPACT_EFFORT_SETTINGS_NAMESPACE, apply };