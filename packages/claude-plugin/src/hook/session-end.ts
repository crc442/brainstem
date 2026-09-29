import { readStdin, runIfEntry, sessionIdOf } from "./io";
import { requestOrDefer } from "./client";
import { socketPath } from "../socket";

export async function main(): Promise<void> {
  const sessionId = sessionIdOf(await readStdin());
  // No respawn here: a missing daemon at session end is the desired state.
  if (sessionId) await requestOrDefer(socketPath(sessionId), { kind: "shutdown" }, 2_000);
}

runIfEntry(import.meta.url, main);
