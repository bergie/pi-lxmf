#!/usr/bin/env node
/**
 * @file fake-pi.mjs
 *
 * A minimal `pi --mode rpc` stand-in for the end-to-end smoketest: answers
 * the RPC commands the bridge uses and echoes prompts back as assistant
 * messages. Speaks the same strict JSONL framing.
 */

/** @param {any} obj */
function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newlineAt = buffer.indexOf("\n");
  while (newlineAt !== -1) {
    const line = buffer.slice(0, newlineAt);
    buffer = buffer.slice(newlineAt + 1);
    if (line.trim()) handle(JSON.parse(line));
    newlineAt = buffer.indexOf("\n");
  }
});
process.stdin.resume();

/**
 * @param {any} cmd
 */
function handle(cmd) {
  switch (cmd.type) {
    case "get_state":
      send({
        type: "response",
        id: cmd.id,
        success: true,
        data: {
          isStreaming: false,
          sessionFile: "/tmp/pi-lxmf-smoke-session.jsonl",
          sessionName: "smoke",
          model: { provider: "fake", id: "fake-1" },
          thinkingLevel: "off",
        },
      });
      break;
    case "get_commands":
      send({
        type: "response",
        id: cmd.id,
        success: true,
        data: { commands: [] },
      });
      break;
    case "prompt": {
      send({ type: "response", id: cmd.id, success: true });
      const message = String(cmd.message ?? "");
      const text = message.startsWith("LONG ")
        ? "x".repeat(6000)
        : `You said: ${message}`;
      send({ type: "agent_start" });
      send({ type: "message_start", message: { role: "assistant" } });
      send({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
      send({ type: "agent_settled" });
      break;
    }
    default:
      send({ type: "response", id: cmd.id, success: true, data: {} });
      break;
  }
}
