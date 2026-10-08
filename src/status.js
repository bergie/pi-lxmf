/**
 * @file status.js
 *
 * Parsing for the Program Status Protocol (OSC 7501) — the terminal escape
 * sequence a program uses to tell the terminal what it is doing (idle,
 * working, blocked, done, error, and why). See
 * https://www.superlogical.com/rex/docs/build/program-status
 *
 * Two pieces:
 *
 * - {@link parseStatusReport} validates one report body (`key=value:pairs`)
 *   against the protocol grammar and limits, and returns a normalized
 *   record (or `null` when the whole report must be discarded).
 * - {@link createStatusFilter} is a chunk-stream filter that extracts
 *   `OSC 7501` sequences from a byte stream (handling sequences split
 *   across chunks) and passes everything else through untouched. pi-lxmf
 *   runs `pi --mode rpc` with `PI_PROGRAM_STATUS=1`, so pi may interleave
 *   these sequences into its stdout/stderr; stripping them here protects
 *   the strict JSONL RPC framing on stdout.
 *
 * The bridge only reacts to reports; nothing is ever written back (the
 * protocol's feature-detection reply is deliberately not answered — pi
 * treats silence as "unsupported" and still sends reports because the
 * environment variable forces them on).
 */

import { StringDecoder } from "node:string_decoder";

/** The full sequence prefix: `ESC ] 7501 ;`. */
const SEQ_PREFIX = "\x1b]7501;";
/** ST (`ESC \`), one of the two permitted terminators. */
const ST = "\x1b\\";
/** BEL (`0x07`), the other permitted terminator. */
const BEL = "\x07";

/** Hard cap from the spec: a longer sequence is discarded whole. */
export const MAX_SEQUENCE_BYTES = 4096;

/**
 * Builds one complete report sequence (test helper and documentation of
 * the wire format).
 *
 * @param {string} body - Pairs body, e.g. `state=working:app=pi`.
 * @param {"st"|"bel"} [terminator]
 * @returns {string}
 */
export function statusSequence(body, terminator = "st") {
  return `${SEQ_PREFIX}${body}${terminator === "bel" ? BEL : ST}`;
}

const STATES = new Set([
  "idle",
  "working",
  "done",
  "blocked",
  "error",
  "clear",
]);
const KINDS = new Set(["permission", "question", "auth"]);
/** Value character set — excludes `:` and `;`, so nothing needs escaping. */
const VALUE_RE = /^[A-Za-z0-9_.,+/=-]*$/;
const KEY_RE = /^[a-z]+$/;
const APP_RE = /^[A-Za-z0-9_.+-]{1,32}$/;
const SEGMENT_RE = /^[A-Za-z0-9_.+-]{1,32}$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
/** C0/C1 controls the spec forbids inside decoded free text. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the protocol mandates rejecting exactly these control characters in decoded text
const CONTROL_RE = /[\u0000-\u001f\u007f\u0080-\u009f]/;

const KEY_MAX_BYTES = 16;
const MSG_MAX_ENCODED = 2732;
const MSG_MAX_DECODED = 2048;
const TITLE_MAX_ENCODED = 256;
const TITLE_MAX_DECODED = 192;
const ID_MAX_BYTES = 128;
const ID_MAX_SEGMENTS = 8;

/**
 * A normalized Program Status record: exactly the keys of the report that
 * are present and valid (absent/invalid optional keys are left out, per
 * the protocol's "treated as absent" rules).
 *
 * @typedef {object} ProgramStatus
 * @property {"idle"|"working"|"done"|"blocked"|"error"|"clear"} state
 * @property {string} [id]
 * @property {"permission"|"question"|"auth"} [kind]
 * @property {number} [progress]
 * @property {string} [app]
 * @property {string} [title] - Decoded UTF-8.
 * @property {string} [msg] - Decoded UTF-8.
 */

/**
 * Decodes a standard-base64 value (padding optional) into UTF-8 text,
 * enforcing the spec: charset, length mod 4, decode-size limit, and the
 * no-control-characters rule.
 *
 * @param {string} value
 * @param {number} maxEncoded
 * @param {number} maxDecoded
 * @returns {string|null} Decoded text, or `null` when invalid.
 */
function decodeBase64Text(value, maxEncoded, maxDecoded) {
  if (value.length === 0) return "";
  if (value.length > maxEncoded) return null;
  if (value.length % 4 === 1) return null;
  if (!BASE64_RE.test(value)) return null;
  let text;
  try {
    text = Buffer.from(value, "base64").toString("utf8");
  } catch {
    return null;
  }
  if (Buffer.byteLength(text, "utf8") > maxDecoded) return null;
  if (CONTROL_RE.test(text)) return null;
  return text;
}

/**
 * Validates an `id` path (`segment ("/" segment)*`) with the spec's size
 * limits.
 *
 * @param {string} value
 * @returns {string|null}
 */
function validateId(value) {
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > ID_MAX_BYTES) {
    return null;
  }
  const segments = value.split("/");
  if (segments.length > ID_MAX_SEGMENTS) return null;
  for (const segment of segments) {
    if (!SEGMENT_RE.test(segment)) return null;
  }
  return value;
}

/**
 * Parses and validates one report body. Follows the protocol's error
 * handling exactly:
 *
 * - A malformed pair is skipped; the rest of the report still applies.
 * - Unknown keys are ignored; a repeated key's last value wins.
 * - The whole report is discarded (`null`) when it misses `state`, uses an
 *   unrecognized state, carries a malformed `id`, has undecodable base64,
 *   decoded free text with control characters, or breaks a size limit.
 * - An invalid `kind`, `progress`, or `app` is treated as absent.
 *
 * @param {string} body - The bytes between `OSC 7501 ;` and the terminator.
 * @returns {ProgramStatus|null}
 */
export function parseStatusReport(body) {
  if (typeof body !== "string") return null;
  /** @type {Map<string, string>} */
  const pairs = new Map();
  for (const rawPair of body.split(":")) {
    const pair = rawPair.trim();
    const eq = pair.indexOf("=");
    if (eq <= 0) continue; // no `=` or empty key: skip, keep processing
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!KEY_RE.test(key) || Buffer.byteLength(key, "utf8") > KEY_MAX_BYTES) {
      // An over-long key breaks the key limit → discard the whole report.
      if (Buffer.byteLength(key, "utf8") > KEY_MAX_BYTES) return null;
      continue;
    }
    if (!VALUE_RE.test(value)) continue; // byte outside the value set: skip
    pairs.set(key, value); // repeated key: last value wins
  }

  const state = /** @type {ProgramStatus["state"]} */ (pairs.get("state"));
  if (!state || !STATES.has(state)) return null;

  /** @type {ProgramStatus} */
  const report = { state };

  const id = pairs.get("id");
  if (id !== undefined) {
    const validId = validateId(id);
    if (validId === null) return null; // never fall back to the root record
    report.id = validId;
  }

  const kind = pairs.get("kind");
  if (kind !== undefined && KINDS.has(kind)) {
    report.kind = /** @type {NonNullable<ProgramStatus["kind"]>} */ (kind);
  }

  const progress = pairs.get("progress");
  if (
    progress !== undefined &&
    /^[0-9]+$/.test(progress) &&
    progress.length <= 3
  ) {
    const n = Number(progress);
    if (n >= 0 && n <= 100) report.progress = n;
  }

  const app = pairs.get("app");
  if (app !== undefined && APP_RE.test(app)) report.app = app;

  const title = pairs.get("title");
  if (title !== undefined) {
    const decoded = decodeBase64Text(
      title,
      TITLE_MAX_ENCODED,
      TITLE_MAX_DECODED,
    );
    if (decoded === null) return null;
    report.title = decoded;
  }

  const msg = pairs.get("msg");
  if (msg !== undefined) {
    const decoded = decodeBase64Text(msg, MSG_MAX_ENCODED, MSG_MAX_DECODED);
    if (decoded === null) return null;
    report.msg = decoded;
  }

  return report;
}

/**
 * @typedef {object} StatusFilterOptions
 * @property {(body: string) => void} [onQuery] - A feature-detection query (`?`) was seen. The filter swallows it; the daemon never answers (pi treats the missing reply as "unsupported" and keeps reporting, since `PI_PROGRAM_STATUS=1` forces reports on).
 * @property {(reason: string) => void} [onInvalid] - A sequence was seen but its report was discarded (limit breach, malformed grammar, …).
 */

/**
 * A chunk-stream filter that extracts OSC 7501 sequences.
 *
 * `push()` accepts a string or Buffer chunk (multi-byte UTF-8 sequences may
 * straddle chunks) and returns the chunk content with every recognized
 * OSC 7501 sequence removed — ready to feed a JSONL reader. Sequences may
 * split across chunks in any way; a sequence still unterminated after
 * MAX_SEQUENCE_BYTES is dropped. `flush()` emits a final unterminated tail.
 *
 * @param {(report: ProgramStatus) => void} onReport - Called per valid report.
 * @param {StatusFilterOptions} [options]
 * @returns {{push: (chunk: string|Buffer) => string, flush: () => string}}
 */
export function createStatusFilter(onReport, options = {}) {
  const decoder = new StringDecoder("utf8");
  /** Text not yet classified (pass-through tail or an in-flight sequence). */
  let buffer = "";
  /** True while the buffer starts with (or awaits) `OSC 7501 ;`. */
  let collecting = false;

  /**
   * Consumes the current buffer as far as it can be classified.
   *
   * @param {(text: string) => void} pass - Emit pass-through text.
   * @returns {boolean} Whether more input is needed before progress resumes.
   */
  function step(pass) {
    if (collecting) {
      const stAt = buffer.indexOf(ST);
      const belAt = buffer.indexOf(BEL);
      /** @type {number} */
      let endAt;
      /** @type {number} */
      let endLen;
      if (stAt !== -1 && (belAt === -1 || stAt < belAt)) {
        endAt = stAt;
        endLen = ST.length;
      } else if (belAt !== -1) {
        endAt = belAt;
        endLen = BEL.length;
      } else {
        if (buffer.length > MAX_SEQUENCE_BYTES) {
          // No terminator within the hard cap: discard the sequence whole.
          options.onInvalid?.("sequence exceeded 4096 bytes without ST/BEL");
          buffer = "";
          collecting = false;
          return false;
        }
        return true; // wait for the terminator
      }
      const body = buffer.slice(SEQ_PREFIX.length, endAt);
      buffer = buffer.slice(endAt + endLen);
      collecting = false;
      handleBody(body);
      return false;
    }

    const escAt = buffer.indexOf("\x1b");
    if (escAt === -1) {
      if (buffer.length > 0) pass(buffer);
      buffer = "";
      return false;
    }
    if (escAt > 0) pass(buffer.slice(0, escAt));
    buffer = buffer.slice(escAt);
    // A partial prefix at the chunk end may complete with the next chunk.
    if (buffer.length < SEQ_PREFIX.length) {
      if (SEQ_PREFIX.startsWith(buffer)) return true;
      pass("\x1b");
      buffer = buffer.slice(1);
      return false;
    }
    if (buffer.startsWith(SEQ_PREFIX)) {
      collecting = true;
      return false; // step again to look for the terminator
    }
    // An unrelated escape sequence: let it through byte by byte so a
    // 7501 sequence right behind it is still found.
    pass("\x1b");
    buffer = buffer.slice(1);
    return false;
  }

  /**
   * @param {string} body
   */
  function handleBody(body) {
    if (body.trim() === "?") {
      options.onQuery?.(body);
      return;
    }
    const report = parseStatusReport(body);
    if (report) {
      onReport(report);
    } else {
      options.onInvalid?.("report failed grammar or limit validation");
    }
  }

  return {
    /**
     * @param {string|Buffer} chunk
     * @returns {string} The chunk content minus extracted sequences.
     */
    push(chunk) {
      buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
      /** @type {string} */
      let passthrough = "";
      /** @param {string} text */
      const pass = (text) => {
        passthrough += text;
      };
      while (!step(pass)) {
        if (!collecting && buffer.length === 0) break;
      }
      return passthrough;
    },
    /**
     * @returns {string} Any unterminated tail (pass-through).
     */
    flush() {
      buffer += decoder.end();
      const tail = buffer;
      buffer = "";
      collecting = false;
      return tail;
    },
  };
}
