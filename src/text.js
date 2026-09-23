/**
 * @file text.js
 *
 * Pure text helpers shared by the bridge and the LXMF sender: reply
 * chunking and human-friendly formatting. Kept dependency-free so tests
 * stay light.
 */

/**
 * Splits `text` into chunks of at most `maxChars` characters, preferring
 * paragraph (`\n\n`) boundaries, then single newlines, then hard cuts. Only
 * the *content* is measured; the `[… n/N]` markers are appended by the
 * caller (the sender) so chunk sizes stay predictable here.
 *
 * @param {string} text
 * @param {number} maxChars - Maximum characters per chunk (>= 1).
 * @returns {string[]}
 */
export function chunkText(text, maxChars) {
  if (!Number.isFinite(maxChars) || maxChars < 1) {
    throw new Error(`maxChars must be a positive number, got ${maxChars}`);
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  /** @type {string[]} */
  const chunks = [];
  let rest = trimmed;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    let cut = window.lastIndexOf("\n\n");
    if (cut < maxChars * 0.5) cut = window.lastIndexOf("\n");
    if (cut < maxChars * 0.5) cut = window.lastIndexOf(" ");
    if (cut < maxChars * 0.5) cut = -1;
    if (cut === -1) {
      chunks.push(window);
      rest = rest.slice(maxChars);
    } else {
      chunks.push(window.slice(0, cut));
      rest = rest.slice(cut).replace(/^\n+/, "");
    }
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks.filter((c) => c.length > 0);
}

/**
 * Formats an unknown thrown value as a short message.
 *
 * @param {unknown} e
 * @returns {string}
 */
export function errorText(e) {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Formats a duration in milliseconds as a compact human string
 * (`3d 4h 12m`, `4h 12m`, `12m 5s`, `8s`).
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const s = Math.floor(ms / 1000);
  const parts = [
    { unit: "d", n: Math.floor(s / 86400) },
    { unit: "h", n: Math.floor((s % 86400) / 3600) },
    { unit: "m", n: Math.floor((s % 3600) / 60) },
    { unit: "s", n: s % 60 },
  ];
  const nonzero = parts.filter((p) => p.n > 0);
  const kept = nonzero.slice(0, 2);
  if (kept.length === 0) return "0s";
  return kept.map((p) => `${p.n}${p.unit}`).join(" ");
}

/**
 * Formats a token/cost tally as returned by the `get_session_stats` RPC.
 *
 * @param {{tokens?: {total?: number|null}, cost?: number|null, contextUsage?: {percent?: number|null}|null}} stats
 * @returns {string}
 */
export function formatTokens(stats) {
  const tokens = stats?.tokens?.total;
  const cost = stats?.cost;
  const percent = stats?.contextUsage?.percent;
  const bits = [];
  if (typeof tokens === "number")
    bits.push(`${tokens.toLocaleString()} tokens`);
  if (typeof cost === "number") bits.push(`$${cost.toFixed(2)}`);
  if (typeof percent === "number") bits.push(`context ${Math.round(percent)}%`);
  return bits.length > 0 ? bits.join(", ") : "no usage recorded";
}
