import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeRules, resolveConfig, loadRawConfig, DEFAULT_RULES } from "../src/config";

describe("mergeRules", () => {
  test("splices built-ins in at the position of the $defaults marker", () => {
    expect(mergeRules(["first", "$defaults", "last"], ["a", "b"])).toEqual(["first", "a", "b", "last"]);
  });

  test("omits built-ins entirely when the marker is absent", () => {
    expect(mergeRules(["only"], ["a", "b"])).toEqual(["only"]);
  });

  test("uses built-ins when the user supplies nothing", () => {
    expect(mergeRules(undefined, ["a", "b"])).toEqual(["a", "b"]);
  });

  test("tolerates a repeated marker without duplicating built-ins", () => {
    expect(mergeRules(["$defaults", "x", "$defaults"], ["a"])).toEqual(["a", "x"]);
  });
});

describe("resolveConfig", () => {
  test("defaults match the Pi adapter: gate, sanitize, and verify active", () => {
    const config = resolveConfig({});
    expect(config.modes).toMatchObject({ gate: "active", sanitize: "active", verify: "active", select: "off", focus: "off" });
    expect(config.trust).toBe(0.3);
    expect(config.classifyAllShell).toBe(false);
  });

  test("steer defaults to shadow because there is no routing boundary", () => {
    expect(resolveConfig({}).modes.steer).toBe("shadow");
  });

  test("user rules layer over the built-ins", () => {
    const config = resolveConfig({ allow: ["$defaults", "staging deploys are routine"] });
    expect(config.allow).toEqual([...DEFAULT_RULES.allow, "staging deploys are routine"]);
  });

  test("rejects a trust value outside 0..1", () => {
    expect(() => resolveConfig({ trust: 1.5 })).toThrow(/trust must be between 0 and 1/);
  });

  test("rejects an unknown reflex mode", () => {
    expect(() => resolveConfig({ modes: { gate: "sometimes" } as never })).toThrow(/invalid mode "sometimes" for gate/);
  });
});

describe("loadRawConfig", () => {
  function fixture(files: { user?: object; project?: object }) {
    const base = mkdtempSync(join(tmpdir(), "bs-config-"));
    const home = join(base, "home");
    const projectDir = join(base, "project");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(projectDir, ".claude"), { recursive: true });
    if (files.user) writeFileSync(join(home, ".claude", "brainstem.json"), JSON.stringify(files.user));
    if (files.project) writeFileSync(join(projectDir, ".claude", "brainstem.json"), JSON.stringify(files.project));
    return { home, projectDir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
  }

  test("a checked-in project file cannot loosen policy", () => {
    const f = fixture({ project: { trust: 1, allow: ["everything is routine"], modes: { gate: "off" }, hard_deny: ["no prod"] } });
    const { raw, ignored } = loadRawConfig(f);
    expect(raw.trust).toBeUndefined();
    expect(raw.allow).toBeUndefined();
    expect(raw.modes).toBeUndefined();
    expect(ignored.map((entry) => entry.split(": ").at(-1))).toEqual(["trust", "allow", "modes"]);
    f.cleanup();
  });

  test("project deny rules are appended after the user's and keep the built-ins", () => {
    const f = fixture({ user: { hard_deny: ["$defaults", "user rule"] }, project: { hard_deny: ["project rule"] } });
    expect(resolveConfig(loadRawConfig(f).raw).hard_deny).toEqual([...DEFAULT_RULES.hard_deny, "user rule", "project rule"]);
    f.cleanup();
  });

  test("a user per-project override applies only to that project", () => {
    const f = fixture({});
    writeFileSync(join(f.home, ".claude", "brainstem.json"), JSON.stringify({ trust: 0.2, projects: { [f.projectDir]: { trust: 0.6 } } }));
    expect(loadRawConfig(f).raw.trust).toBe(0.6);
    expect(loadRawConfig({ home: f.home, projectDir: "/elsewhere" }).raw.trust).toBe(0.2);
    f.cleanup();
  });

  test("reports which file is malformed", () => {
    const f = fixture({});
    writeFileSync(join(f.home, ".claude", "brainstem.json"), "{ nope");
    expect(() => loadRawConfig(f)).toThrow(/invalid brainstem config at .*brainstem\.json/);
    f.cleanup();
  });

  test("a hostile project config cannot raise trust or add allow rules over a real user config", () => {
    const f = fixture({
      user: { trust: 0.1, allow: ["$defaults", "user rule"] },
      project: { trust: 1, allow: ["everything is routine"], modes: { gate: "off" }, hard_deny: ["project rule"] },
    });
    const { raw, ignored } = loadRawConfig(f);
    const config = resolveConfig(raw);

    // The user's own values survive untouched.
    expect(config.trust).toBe(0.1);
    expect(config.allow).toEqual([...DEFAULT_RULES.allow, "user rule"]);
    expect(config.modes.gate).toBe("active");

    // The project file's only legitimate contribution lands.
    expect(config.hard_deny).toEqual([...DEFAULT_RULES.hard_deny, "project rule"]);
    expect(ignored.map((entry) => entry.split(": ").at(-1))).toEqual(["trust", "allow", "modes"]);
    f.cleanup();
  });
});
