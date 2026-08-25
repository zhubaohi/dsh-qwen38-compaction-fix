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
 * Layer 1: the `llm/stream` waterfall stamps `reasoningEffort: "off"` on
 * calls whose `purpose` is in `purposes` (default: `["compaction"]`, the
 * compaction engine's own tag) AND whose `options.model` is in `models`. The
 * pi-ai adapter resolves "off" through the model's `reasoningEfforts`
 * declaration (`off: none`) and sends `reasoning_effort: "none"` on the wire
 * — zero reasoning tokens.
 *
 * Layer 2 (HTTP sampling): compaction summarization also needs sampling
 * settings that the LLM options surface does not carry (`top_p`, `top_k`,
 * `min_p`, `presence_penalty`, `repetition_penalty`; `temperature` is
 * carried, but is applied here too so the whole parameter set lands in one
 * place). The OpenAI-compatible request body is built and stringified
 * downstream of the waterfall, so this plugin wraps the process-global
 * `fetch` and applies the configured `sampling` object to the body of
 * chat-completion requests that ARE the compaction summarization call AND
 * whose `model` field is in `models`.
 *
 * Layer 3 (HTTP max_tokens floor): pi-ai clamps every request's `max_tokens`
 * client-side (`clampMaxTokensToContext`): it estimates the context size from
 * the messages and requests at most `contextWindow − estimate − 4096` output
 * tokens, floored at 1. The estimator only uses real (server-reported) token
 * counts when a replayed assistant message carries usage — dsh-llm-pi-ai
 * rebuilds replayed assistant messages with zeroed usage, so for any large
 * conversation the estimator falls back to a chars/4 heuristic that
 * overestimates dense content severalfold. When the heuristic estimate
 * approaches the context window, the clamp collapses `max_tokens` to 1: the
 * model emits a single token, finishes `output_limit`, and dsh-compaction-
 * basic reports "summarization truncated at the token cap (incomplete
 * checkpoint)" even though the server (which knows the real prompt size) had
 * ample room. This layer restores the intended output budget on compaction
 * bodies only: it RAISES `max_tokens` to the configured floor, never lowers
 * it, and only on bodies carrying the compaction signature for an allowed
 * model. When headroom is genuinely scarce the server clamps to its real
 * capacity and finishes with an honest `context_capacity` stop — never worse
 * than today's 1-token result.
 *
 * Layer 4 (HTTP session-title reasoning off): the session-title provider
 * (dsh-session-title-llm) issues its auxiliary call with the route's DEFAULT
 * reasoning effort and a tiny output budget (`maxTokens: 64` by composition
 * default). On a route whose gateway honors `reasoning_effort` and thinks at
 * its default level, the model spends the entire 64-token budget on
 * reasoning tokens, finishes `length` with EMPTY content, and every
 * generated title fails back to the deterministic first-prompt fallback. The
 * title plugin also deep-freezes its LLM options BEFORE the `llm/stream`
 * waterfall, so layer 1's in-place stamp cannot reach it (the try/catch
 * around the stamp exists for exactly that case). This layer reaches the
 * call where the frozen object no longer matters — the wire body: when the
 * chat-completion body carries the title system prompt (see
 * `TITLE_SIGNATURE`) AND its `model` field is in `models`, it writes the
 * configured `reasoning_effort` wire value into the body, so the title model
 * emits plain text within the 64-token budget. `titleReasoning: ""` disables
 * the gate.
 *
 * Identity for layers 2+3 is the compaction engine's own instruction:
 * dsh-compaction-basic appends it as the FINAL user message of every
 * compaction call, so its first line is a stable signature in the body. (If
 * a future dsh release changes that instruction, the HTTP gate silently stops
 * matching and the body keeps its wire defaults; the effort layer is
 * unaffected.)
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
/**
 * Default `reasoning_effort` wire value written into session-title request
 * bodies (layer 4). The local ninfer gateway maps the provider's "off" level
 * to the wire spelling `none` (see the `reasoningEfforts` declaration in
 * settings.yaml); `""` disables the title-effort gate entirely.
 */
const DEFAULT_TITLE_REASONING = "none";
/**
 * Default `max_tokens` floor for compaction bodies. dsh-compaction-basic's
 * own budget defaults to 8192; 16384 gives the summary headroom while
 * staying far below the headroom a 190k-token window leaves a ~120k prompt.
 * `0` (or `null`) disables the floor.
 */
const DEFAULT_MAX_TOKENS_FLOOR = 16384;
/**
 * Wire field names of the supported sampling settings. Keys are written
 * verbatim into the OpenAI-compatible chat-completion body.
 */
const SAMPLING_KEYS = [
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "presence_penalty",
  "repetition_penalty"
];
/**
 * Wire field names of the output cap, in the order the OpenAI-compatible
 * surface may spell it (`max_tokens` vs `max_completion_tokens`).
 */
const MAX_TOKEN_KEYS = ["max_tokens", "max_completion_tokens"];

/**
 * Sampling settings object; every field optional (a plain schemastery field
 * is nullable: absent keys stay absent), wire-named.
 */
const SamplingParams = z.object({
  /** Sample temperature for the summarization call. */
  temperature: z.number(),
  /** Nucleus sampling probability mass. */
  top_p: z.number(),
  /** Keep the top-K candidate tokens. */
  top_k: z.number(),
  /** Minimum token probability relative to the best token. */
  min_p: z.number(),
  /** Bias against already-present tokens. */
  presence_penalty: z.number(),
  /** Multiplicative penalty for repeated tokens (1.0 = neutral). */
  repetition_penalty: z.number()
});

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
  models: z.array(z.string()).default(DEFAULT_MODELS),
  /** Sampling settings applied to compaction request bodies; `{}` leaves sampling untouched. */
  sampling: SamplingParams.default({}),
  /**
   * `max_tokens` floor applied to compaction request bodies: the wire value
   * is raised to at least this number so the summarizer gets its output
   * budget back when pi-ai's client-side context clamp collapsed it (the
   * clamp estimates context from a chars/4 heuristic for replayed history,
   * which overestimates dense conversations and can drive `max_tokens` to 1).
   * Never lowers the value. `0` or `null` disables the floor. Default 16384.
   */
  maxTokensFloor: z.number().default(DEFAULT_MAX_TOKENS_FLOOR),
  /**
   * `reasoning_effort` wire value written into session-title request bodies
   * (layer 4). The title provider freezes its LLM options before the
   * waterfall, so the route default (here: `xhigh`) would otherwise eat the
   * 64-token title budget in reasoning tokens and every generated title
   * fails to the fallback. `""` disables the gate. Default `"none"` (the
   * ninfer wire spelling of the "off" level).
   */
  titleReasoning: z.string().default(DEFAULT_TITLE_REASONING)
});

/** Settings namespace carrying this plugin's policy. */
const COMPACT_EFFORT_SETTINGS_NAMESPACE = settingsNamespace("qwen38-compaction-fix");

/**
 * First line of the dsh-compaction-basic summarization instruction, which
 * the engine appends as the final user message of every compaction call.
 * Used to identify those requests at the HTTP layer. (If a future dsh
 * release changes that instruction, the HTTP layers silently stop matching —
 * the effort layer is unaffected — and the body keeps its wire defaults.)
 */
export const COMPACTION_SIGNATURE = "You are now acting as a compaction engine for this AI coding assistant";

/**
 * First line of the dsh-session-title-llm system prompt, which the title
 * provider sends verbatim on every session-title call. Used to identify
 * those requests at the HTTP layer (layer 4): the title plugin's LLM options
 * are deep-frozen before the waterfall, so only the wire body is reachable.
 */
export const TITLE_SIGNATURE = "Create a concise title for an AI coding-assistant session from the supplied human messages";

/** Marks the wrapped global fetch so `apply` never double-wraps. */
const FETCH_WRAPPER_MARK = Symbol.for("qwen38-compaction-fix.fetch-wrapper");

/**
 * Current policy config source, rebound by every `apply` so a re-apply
 * (in-process profile reload) never leaves the installed wrapper pointing
 * at a stale config.
 */
let policySource = () => ({ entries: [], floor: 0, titleReasoning: "", models: [] });

/**
 * Numeric sampling entries from one resolved config, in wire-key order.
 * @returns `[]` when nothing finite is configured.
 */
function samplingEntries(sampling) {
  if (sampling === null || typeof sampling !== "object") return [];
  const entries = [];
  for (const key of SAMPLING_KEYS) {
    const value = sampling[key];
    if (typeof value === "number" && Number.isFinite(value)) entries.push([key, value]);
  }
  return entries;
}

/**
 * The active HTTP-layer policy from one resolved config: the sampling
 * entries, an enabled max_tokens floor (0 = disabled), the wire value
 * written into session-title bodies ("" = gate disabled), and the model
 * allow-list ([] = policy disabled).
 */
function policyOf(config) {
  const floorRaw = config?.maxTokensFloor;
  const floor = typeof floorRaw === "number" && Number.isFinite(floorRaw) && floorRaw > 0 ? Math.floor(floorRaw) : 0;
  const titleReasoning = typeof config?.titleReasoning === "string" ? config.titleReasoning : "";
  const models = Array.isArray(config?.models)
    ? config.models.filter((m) => typeof m === "string" && m.length > 0)
    : [];
  return { entries: samplingEntries(config?.sampling), floor, titleReasoning, models };
}

/**
 * Whether the parsed body's `model` field is in the allow-list. Conservative:
 * a missing or non-string `model` never matches (no rewrite).
 * @param body - the parsed JSON chat-completion body.
 * @param models - the allow-list of exact model ids.
 * @returns true when the body targets an allowed model.
 */
function modelAllowed(body, models) {
  return Array.isArray(models) && typeof body?.model === "string" && models.includes(body.model);
}

/**
 * Rewrite `init.body` in place when `init` carries the JSON chat-completion
 * body of a compaction summarization call FOR AN ALLOWED MODEL: apply the
 * sampling entries and raise the output cap to the floor. Every guard is
 * conservative: any shape mismatch, parse failure, missing signature, or
 * disallowed model leaves the request untouched.
 * @param init - the fetch init holding the stringified JSON body.
 * @param policy - `{entries, floor, models}` from the current config.
 * @returns true when the body was rewritten.
 */
export function rewriteCompactionBody(init, policy) {
  if (policy === null || typeof policy !== "object") return false;
  const entries = Array.isArray(policy.entries) ? policy.entries : [];
  const floor = typeof policy.floor === "number" && Number.isFinite(policy.floor) && policy.floor > 0 ? policy.floor : 0;
  const models = Array.isArray(policy.models) ? policy.models : [];
  if (entries.length === 0 && floor === 0) return false;
  if (models.length === 0) return false;
  if (init === null || typeof init !== "object") return false;
  if (typeof init.body !== "string" || init.body.length === 0) return false;
  // Cheap pre-filter before parsing a potentially large body.
  if (!init.body.includes(COMPACTION_SIGNATURE)) return false;
  const body = JSON.parse(init.body);
  if (body === null || typeof body !== "object") return false;
  // Model gate: only rewrite bodies targeting an allowed model.
  if (!modelAllowed(body, models)) return false;
  if (!Array.isArray(body.messages) || body.messages.length === 0) return false;
  const last = body.messages[body.messages.length - 1];
  if (last === null || typeof last !== "object" || last.role !== "user") return false;
  const text = typeof last.content === "string" ? last.content : JSON.stringify(last.content ?? "");
  if (!text.includes(COMPACTION_SIGNATURE)) return false;
  for (const [key, value] of entries) {
    if (typeof key === "string" && typeof value === "number") body[key] = value;
  }
  if (floor > 0) {
    for (const key of MAX_TOKEN_KEYS) {
      // RAISE ONLY: a cap the pipeline already set (larger or equal) is
      // never reduced; a collapsed cap (pi-ai's clamp) is restored.
      if (typeof body[key] === "number" && body[key] < floor) body[key] = floor;
    }
  }
  init.body = JSON.stringify(body);
  return true;
}

/**
 * Rewrite `init.body` in place when `init` carries the JSON chat-completion
 * body of a session-title call FOR AN ALLOWED MODEL: write the configured
 * `reasoning_effort` wire value so the gateway does not spend the 64-token
 * title budget on thinking. The compaction engine's own wire
 * `max_tokens`/`max_completion_tokens` is left exactly as the title plugin
 * set it (the floor is compaction-only). Every guard is conservative: any
 * shape mismatch, parse failure, missing signature, or disallowed model
 * leaves the request untouched.
 * @param init - the fetch init holding the stringified JSON body.
 * @param wire - the `reasoning_effort` wire value from the current config.
 * @param models - the allow-list of exact model ids.
 * @returns true when the body was rewritten.
 */
export function rewriteTitleBody(init, wire, models) {
  if (typeof wire !== "string" || wire.length === 0) return false;
  if (!Array.isArray(models) || models.length === 0) return false;
  if (init === null || typeof init !== "object") return false;
  if (typeof init.body !== "string" || init.body.length === 0) return false;
  // Cheap pre-filter before parsing the body.
  if (!init.body.includes(TITLE_SIGNATURE)) return false;
  let body;
  try {
    body = JSON.parse(init.body);
  } catch {
    return false;
  }
  if (body === null || typeof body !== "object") return false;
  // Model gate: only rewrite bodies targeting an allowed model.
  if (!modelAllowed(body, models)) return false;
  if (!Array.isArray(body.messages) || body.messages.length === 0) return false;
  // Confirm the signature actually sits inside a message (the title provider
  // sends it as the system prompt; the role is adapter-mapped, e.g. `developer`
  // or `system`, so scan every message's text instead of pinning a role).
  let matched = false;
  for (const message of body.messages) {
    if (message === null || typeof message !== "object") continue;
    const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
    if (text.includes(TITLE_SIGNATURE)) { matched = true; break; }
  }
  if (!matched) return false;
  body.reasoning_effort = wire;
  init.body = JSON.stringify(body);
  return true;
}

/**
 * Wrap the process-global `fetch` so compaction request bodies receive the
 * configured sampling settings and the max_tokens floor at send time — only
 * for bodies whose `model` field is in the allow-list. The OpenAI SDK
 * (pi-ai's transport) resolves `fetch` from the global at client
 * construction, and pi-ai builds a fresh client per request, so wrapping
 * here reaches every future LLM request in this process. Non-matching
 * requests pass through unmodified, and any failure inside the gate leaves
 * the request untouched. The wrapper is installed once per process; a
 * re-`apply` (profile reload in-process) only rebinds the current policy
 * source.
 */
function installSamplingFetch(ctx, readPolicy) {
  const g = globalThis;
  if (typeof g.fetch !== "function" || g.fetch[FETCH_WRAPPER_MARK] === true) {
    // Already wrapped (re-apply): just rebind the policy source.
    policySource = readPolicy;
    return;
  }
  const originalFetch = g.fetch;
  let applied = 0;
  let titleApplied = 0;
  const wrapper = async function compactionSamplingFetch(input, init) {
    let rewritten = false;
    let titleRewritten = false;
    let policy;
    try {
      policy = policySource();
      rewritten = rewriteCompactionBody(init, policy);
      // The title gate is independent of the compaction gate: a body is either
      // the compaction call or a title call, never both.
      if (!rewritten) titleRewritten = rewriteTitleBody(init, policy?.titleReasoning, policy?.models);
    } catch {
      /* Never break LLM traffic: proceed with the untouched request. */
    }
    if (rewritten && applied === 0) {
      const keys = (Array.isArray(policy?.entries) ? policy.entries : []).map(([key]) => key).join(", ");
      const floorNote = policy?.floor > 0 ? `; max_tokens floor ${policy.floor}` : "";
      ctx.logger.info(`qwen38-compaction-fix: rewriting compaction request bodies (sampling: ${keys}${floorNote})`);
    }
    if (rewritten) applied += 1;
    if (titleRewritten && titleApplied === 0) {
      ctx.logger.info(`qwen38-compaction-fix: rewriting session-title request bodies (reasoning_effort: ${policy?.titleReasoning})`);
    }
    if (titleRewritten) titleApplied += 1;
    return originalFetch.call(this, input, init);
  };
  wrapper[FETCH_WRAPPER_MARK] = true;
  g.fetch = wrapper;
  policySource = readPolicy;
}

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
  const readPolicy = () => policyOf(current());
  installSamplingFetch(ctx, readPolicy);
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