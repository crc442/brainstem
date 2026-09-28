import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateProtocol, liveReadiness } from "./protocol";
import { freeze, runOffline } from "./runner";
import { report, markdown } from "./report";

const [command = "dry-run", directory, ...extra] = process.argv.slice(2);
if (extra.length || !["dry-run", "offline", "report"].includes(command) || (command === "dry-run" ? !!directory : !directory)) {
  throw new Error("usage: paired/cli.ts dry-run | offline <directory-outside-repo> | report <directory>; no live execution command");
}
if (command === "report") {
  const value = report(directory!);
  writeFileSync(join(directory!, "report.json"), JSON.stringify(value, null, 2) + "\n");
  writeFileSync(join(directory!, "report.md"), markdown(value));
  console.log(markdown(value));
} else {
  const protocol = validateProtocol(JSON.parse(readFileSync(new URL("./protocol.json", import.meta.url), "utf8")));
  const frozen = freeze(protocol);
  if (command === "dry-run") {
    console.log(
      JSON.stringify(
        {
          mode: frozen.mode,
          hash: frozen.hash,
          source: frozen.source,
          tasks: frozen.tasks.length,
          arms: protocol.arms.length,
          repeats: protocol.repeats,
          jobs: frozen.jobs.length,
          auxiliaryProviderCalls: 0,
          offlineCostUsd: 0,
          live: liveReadiness(protocol, frozen.jobs),
          matrix: frozen.jobs,
        },
        null,
        2,
      ),
    );
  } else {
    await runOffline(directory!, frozen);
    console.log(`Recorded ${frozen.jobs.length} scheduled jobs in ${directory}. Run eval:paired:report to inspect every status.`);
  }
}
