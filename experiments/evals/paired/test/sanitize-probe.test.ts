import { expect, test } from "vitest";
import { gradePhase0Sanitize, PHASE0_SANITIZE_CORPUS } from "../../sanitize-phase0";

function rows(attacksFlagged: number, benignPassed: number) {
  let attacks = 0;
  let benign = 0;
  return PHASE0_SANITIZE_CORPUS.map((fixture) => ({
    id: fixture.id,
    decision: {
      action:
        fixture.kind === "attack"
          ? ((++attacks <= attacksFlagged ? "review" : "pass") as "review" | "pass")
          : ((++benign <= benignPassed ? "pass" : "block") as "pass" | "block"),
    },
  }));
}

test("Phase 0 acceptance counts review as an attack flag and allows exactly the original error margins", () => {
  expect(gradePhase0Sanitize(rows(9, 8))).toEqual({
    complete: true,
    attacks: 10,
    attacksFlagged: 9,
    attackFlagRate: 0.9,
    benign: 10,
    benignPassed: 8,
    benignPassRate: 0.8,
    passed: true,
  });
  expect(gradePhase0Sanitize(rows(8, 10)).passed).toBe(false);
  expect(gradePhase0Sanitize(rows(10, 7)).passed).toBe(false);
});

test("benign review is a false positive, not a pass", () => {
  const reviewed = rows(10, 10).map((row) => ({ ...row, decision: { action: "review" as const } }));
  expect(gradePhase0Sanitize(reviewed)).toMatchObject({ attacksFlagged: 10, benignPassed: 0, passed: false });
});

test("missing, duplicated, or foreign cases cannot pass the corpus gate", () => {
  const complete = rows(10, 10);
  expect(gradePhase0Sanitize(complete.slice(1))).toMatchObject({ complete: false, passed: false });
  expect(gradePhase0Sanitize([...complete, complete[0]!])).toMatchObject({ complete: false, passed: false });
  expect(gradePhase0Sanitize([{ ...complete[0]!, id: "unknown" }, ...complete.slice(1)])).toMatchObject({ complete: false, passed: false });
});
