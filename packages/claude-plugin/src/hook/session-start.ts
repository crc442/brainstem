import { readStdin, runIfEntry, sessionIdOf, writeHookOutput } from "./io";
import { ensureDaemon } from "./launch";

export async function main(): Promise<void> {
  const sessionId = sessionIdOf(await readStdin());
  // SessionStart fires again on resume, clear, and compact; ensureDaemon pings before spawning.
  if (sessionId && !(await ensureDaemon(sessionId))) {
    writeHookOutput({
      systemMessage: "brainstem daemon failed to start (see the .log beside its socket); Claude Code's own permission rules apply.",
    });
  }
}

runIfEntry(import.meta.url, main);
