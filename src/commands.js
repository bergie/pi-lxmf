/**
 * @file commands.js
 *
 * The bridge-command layer for chat messages (SPEC §7): parsing, the
 * command table, model matching, and the formatters used by command
 * replies. Commands are executed by the bridge with a `ctx` bundling the
 * `PiRpcClient` and bridge state; each implementation returns the reply
 * text (or a `{ text, shutdown }` action).
 */

import { basename } from "node:path";
import { formatDuration, formatTokens } from "./text.js";

/**
 * Parses bridge-command syntax out of a chat message.
 *
 * - `/name args…` and `!name args…` are commands (name lowercased).
 * - A bare `!` is the quick interrupt (name `""`).
 * - Anything else is not a command (a prompt).
 *
 * @param {string} text
 * @returns {{name: string, args: string}|null}
 */
export function parseCommand(text) {
  const trimmed = text.trim();
  if (trimmed === "!") return { name: "", args: "" };
  if (!trimmed.startsWith("/") && !trimmed.startsWith("!")) return null;
  const rest = trimmed.slice(1);
  if (rest.length === 0) return null;
  const match = rest.match(/^(\S+)\s*([\s\S]*)$/);
  if (!match) return null;
  return { name: match[1].toLowerCase(), args: match[2].trim() };
}

/**
 * Fuzzy-matches a model query against the available models: exact
 * `provider/id` (case-insensitive) first, then substring on `provider/id`,
 * then substring on the display name.
 *
 * @param {Array<{id?: string, provider?: string, name?: string}>} models
 * @param {string} query
 * @returns {{id?: string, provider?: string, name?: string}|null}
 */
export function matchModel(models, query) {
  const q = query.trim().toLowerCase();
  if (!q || !Array.isArray(models) || models.length === 0) return null;
  const full = models.find((m) => `${m.provider}/${m.id}`.toLowerCase() === q);
  if (full) return full;
  const byId = models.find((m) =>
    `${m.provider}/${m.id}`.toLowerCase().includes(q),
  );
  if (byId) return byId;
  return models.find((m) => (m.name ?? "").toLowerCase().includes(q)) ?? null;
}

/**
 * Formats the model list with the current model marked.
 *
 * @param {Array<{id?: string, provider?: string, name?: string}>} models
 * @param {{provider?: string, id?: string}|null} current
 * @returns {string}
 */
export function formatModelList(models, current) {
  const currentKey =
    current?.provider && current?.id
      ? `${current.provider}/${current.id}`.toLowerCase()
      : null;
  const lines = models.map((m) => {
    const key = `${m.provider}/${m.id}`;
    const marker = key.toLowerCase() === currentKey ? " ← current" : "";
    const name = m.name && m.name !== m.id ? ` — ${m.name}` : "";
    return `${key}${name}${marker}`;
  });
  return [`Models (${models.length}):`, ...lines].join("\n");
}

/**
 * Formats `get_state` + bridge info as the `/status` reply.
 *
 * @param {any} state - `get_state` data.
 * @param {object} bridgeInfo
 * @param {string} bridgeInfo.identityHash - This node's Reticulum identity hash.
 * @param {string} bridgeInfo.deliveryHash - This node's `lxmf.delivery` destination hash.
 * @param {string|null} bridgeInfo.owner - Paired owner hash.
 * @param {number} bridgeInfo.uptimeMs
 * @returns {string}
 */
export function formatStatus(state, bridgeInfo) {
  const model = state?.model
    ? `${state.model.provider}/${state.model.id}`
    : "(none)";
  const session = state?.sessionFile
    ? `${state.sessionName ?? "(unnamed)"} · ${basename(state.sessionFile)}`
    : "(none)";
  return [
    `model: ${model}`,
    `thinking: ${state?.thinkingLevel ?? "off"}`,
    `busy: ${state?.isStreaming ? "yes" : "no"}`,
    `session: ${session}`,
    `node: ${bridgeInfo.identityHash}`,
    `lxmf: ${bridgeInfo.deliveryHash}`,
    `owner: ${bridgeInfo.owner ?? "(pairing: first contact)"}`,
    `uptime: ${formatDuration(bridgeInfo.uptimeMs)}`,
  ].join("\n");
}

/**
 * Formats `get_session_stats` data as the `/session` reply.
 *
 * @param {any} stats
 * @returns {string}
 */
export function formatSessionStats(stats) {
  if (!stats) return "No session stats available.";
  return [
    `messages: ${stats.userMessages ?? 0} in / ${stats.assistantMessages ?? 0} out` +
      ` (${stats.toolCalls ?? 0} tool calls)`,
    `usage: ${formatTokens(stats)}`,
    `session: ${stats.sessionId ?? "?"}`,
  ].join("\n");
}

/**
 * @typedef {object} CommandContext
 * @property {import("./rpc.js").PiRpcClient} rpc
 * @property {() => string} getTitle - Reply title (session name or node name).
 * @property {() => {identityHash: string, deliveryHash: string, owner: string|null, uptimeMs: number}} getBridgeInfo
 */

/**
 * @typedef {object} CommandResult
 * @property {string} [text] - Reply text; omitted when there is nothing to say.
 * @property {boolean} [shutdown] - Shut the bridge down (after replying).
 */

/**
 * The bridge command table. `run` returns the reply text or a result object.
 *
 * @type {Record<string, {description: string, run: (ctx: CommandContext, args: string) => Promise<string|CommandResult|void>}>}
 */
export const bridgeCommands = {
  help: {
    description: "List bridge commands",
    async run(ctx) {
      const mine = Object.entries(bridgeCommands).map(
        ([name, def]) => `/${name} — ${def.description}`,
      );
      /** @type {string[]} */
      let piCommands = [];
      try {
        const commands = await ctx.rpc.getCommands();
        piCommands = commands.map(
          (/** @type {{name?: string, description?: string}} */ c) =>
            `/${c.name}${c.description ? ` — ${c.description}` : ""}`,
        );
      } catch {
        /* pi unavailable: bridge commands still listed */
      }
      const parts = [
        ["Bridge commands:", ...mine, "! (bare) — quick interrupt"].join("\n"),
      ];
      if (piCommands.length > 0) {
        parts.push(
          ["Pi commands (sent as prompts):", ...piCommands].join("\n"),
        );
      }
      parts.push("Anything else is sent to the agent as a prompt.");
      return parts.join("\n\n");
    },
  },

  status: {
    description: "Show model, session and bridge status",
    async run(ctx) {
      const state = await ctx.rpc.getState();
      return formatStatus(state, ctx.getBridgeInfo());
    },
  },

  session: {
    description: "Show session stats (messages, tokens, cost)",
    async run(ctx) {
      return formatSessionStats(await ctx.rpc.getSessionStats());
    },
  },

  new: {
    description: "Start a fresh Pi session",
    async run(ctx) {
      const data = await ctx.rpc.newSession();
      if (data?.cancelled) return "New session was cancelled by an extension.";
      return "New session started.";
    },
  },

  name: {
    description: "Show or set the session display name",
    async run(ctx, args) {
      if (!args) {
        const state = await ctx.rpc.getState();
        return `Session name: ${state?.sessionName ?? "(none)"}`;
      }
      await ctx.rpc.setSessionName(args);
      return `Session name set to: ${args}`;
    },
  },

  compact: {
    description: "Compact the conversation context",
    async run(ctx, args) {
      const result = await ctx.rpc.compact(args || undefined);
      const before = result?.tokensBefore;
      const after = result?.estimatedTokensAfter;
      if (typeof before === "number" && typeof after === "number") {
        return `Compacted: ~${before.toLocaleString()} → ~${after.toLocaleString()} tokens.`;
      }
      return "Compacted.";
    },
  },

  model: {
    description: "List models, or switch: /model <provider/id or search>",
    async run(ctx, args) {
      const models = await ctx.rpc.getAvailableModels();
      if (!args) {
        const state = await ctx.rpc.getState();
        return formatModelList(models, state?.model ?? null);
      }
      const match = matchModel(models, args);
      if (!match?.provider || !match?.id) {
        return `No model matched "${args}". Use /model without arguments to list models.`;
      }
      await ctx.rpc.setModel(match.provider, match.id);
      return `Model set to ${match.provider}/${match.id}.`;
    },
  },

  think: {
    description: "Set thinking level: /think <off|minimal|low|medium|high|max>",
    async run(ctx, args) {
      const levels = await ctx.rpc.getAvailableThinkingLevels();
      const level = (args || "").toLowerCase();
      if (!level || !levels.includes(level)) {
        return `Thinking levels: ${levels.join(", ")} (current model).`;
      }
      await ctx.rpc.setThinkingLevel(level);
      return `Thinking level set to ${level}.`;
    },
  },

  abort: {
    description: "Abort the current run and drop queued messages",
    async run(ctx) {
      /** @type {string[]} */
      const dropped = [];
      try {
        const response = await ctx.rpc.clearQueue();
        if (response?.success) {
          dropped.push(...(response.data?.steering ?? []));
          dropped.push(...(response.data?.followUp ?? []));
        }
      } catch {
        /* older pi without clear_queue: abort alone still works */
      }
      ctx.rpc.abort();
      return dropped.length > 0
        ? `Aborted. Dropped ${dropped.length} queued message(s).`
        : "Aborted.";
    },
  },

  quit: {
    description: "Shut down the bridge and Pi",
    async run() {
      return { text: "Shutting down. Bye!", shutdown: true };
    },
  },
};

/**
 * The recovery prompt used when a run settles without any reply text
 * (SPEC §6.3 — a run that ends on a tool call never wrote its answer).
 */
export const EMPTY_REPLY_RECOVERY_PROMPT =
  "You are being driven over LXMF messaging. Your previous run finished " +
  "without writing any reply text. Write the reply to the user's message " +
  "now; if the work is not finished, describe the current state and what " +
  "you still need to do.";
