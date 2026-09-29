import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectJudge, unavailableJudge } from "../src/judge";
import { createDaemon } from "../src/daemon/main";
import { request } from "../src/hook/client";
import { resolveConfig } from "../src/config";

describe("selectJudge", () => {
  test("prefers Jev when TYPESAFE_API_KEY is present", () => {
    expect(selectJudge({ TYPESAFE_API_KEY: "k" })).toMatchObject({ kind: "jev", autoApprovalAvailable: true });
  });

  test("uses a generic judge module when one is configured instead", () => {
    const selected = selectJudge({ BRAINSTEM_JUDGE_MODULE: "/p/judge.mjs" });
    expect(selected).toMatchObject({ kind: "generic", modulePath: "/p/judge.mjs", autoApprovalAvailable: false });
    expect(selected.note).toContain("never auto-approve");
  });

  test("reports floor-only operation when neither is configured", () => {
    const selected = selectJudge({});
    expect(selected.kind).toBe("unavailable");
    expect(selected.note).toContain("TYPESAFE_API_KEY");
    expect(selected.note).toContain("static floor");
  });

  test("prefers Jev even when both are configured", () => {
    expect(selectJudge({ TYPESAFE_API_KEY: "k", BRAINSTEM_JUDGE_MODULE: "/p/judge.mjs" }).kind).toBe("jev");
  });
});

describe("a daemon with no judge", () => {
  let dir = "";
  let stop: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await stop?.();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("still enforces the static floor and defers everything else", async () => {
    dir = mkdtempSync(join(tmpdir(), "bs-nojudge-"));
    const socket = join(dir, "d.sock");
    const daemon = await createDaemon({ socket, judge: unavailableJudge("none"), config: resolveConfig({}), root: dir });
    stop = () => daemon.close();

    expect(await request(socket, { kind: "reviewAction", tool: "Bash", input: { command: "rm -rf /" }, task: "t" })).toMatchObject({
      action: "deny",
    });
    expect(await request(socket, { kind: "reviewAction", tool: "Bash", input: { command: "ls" }, task: "t" })).toMatchObject({
      action: "skip",
    });
  });
});
