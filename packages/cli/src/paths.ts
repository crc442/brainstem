import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { contentHash, expandHome, isInside, normalizeAbsolute, realpathIfExists, resolveParentForWrite, resolvePath } from "@brainstem/core";

// The canonical path resolvers live in @brainstem/core/paths.ts so that
// packages/core/src/floor.ts (policy) and this module (execution) share one
// resolver — see R2 in docs/plans/2026-09-22-review-remediation.md. This
// module re-exports them and adds the write-side verification/execution
// helpers that only make sense where files are actually written.
export { isInside, resolveParentForWrite, resolvePath };

const NATIVE_HELPER_PATH = join(dirname(fileURLToPath(import.meta.url)), "native", "verified-write.py");
const DEFAULT_PYTHON_CANDIDATES = ["python3", "python"];
const HELPER_TIMEOUT_MS = 10_000;

export type WriteCapability = "descriptor-relative" | "unavailable";

/** Sentinel meaning "no file is expected to exist yet" — matches packages/cli/src/change-summary.ts's ABSENT_DIGEST. */
export const ABSENT_PREIMAGE_DIGEST = "absent";

export interface WriteExecutorOptions {
  /**
   * Test-only override: forces which interpreter name(s) to probe/use for
   * the descriptor-relative executor, so the "unavailable" fallback can be
   * exercised deterministically via a genuinely failing probe — not a
   * mocked boolean. Production code never sets this.
   */
  pythonBinCandidates?: string[];
  /**
   * sha256 hex digest the file's CURRENT content is expected to match
   * (ABSENT_PREIMAGE_DIGEST if no file is expected yet). Only meaningful to
   * writeFileVerified's convenience one-shot form — see its doc comment.
   * Omit to skip the check.
   */
  expectedPreimageDigest?: string;
}

let cachedCapability: WriteCapability | undefined;
let cachedPythonBin: string | undefined;

function detectPythonBin(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, [NATIVE_HELPER_PATH, "--probe"], { stdio: "ignore", timeout: HELPER_TIMEOUT_MS });
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Resolves which interpreter (if any) to use for the descriptor-relative
 * write executor. Cached across calls (availability doesn't change
 * mid-process) unless `options.pythonBinCandidates` is given, which always
 * runs a fresh, uncached probe — used only by tests exercising the
 * "unavailable" fallback against a real (deliberately failing) probe.
 */
function resolvePythonBin(options: WriteExecutorOptions): string | undefined {
  if (options.pythonBinCandidates) return detectPythonBin(options.pythonBinCandidates);
  if (cachedCapability !== undefined) return cachedCapability === "descriptor-relative" ? cachedPythonBin : undefined;
  if (process.platform === "win32") {
    cachedCapability = "unavailable";
    return undefined;
  }
  cachedPythonBin = detectPythonBin(DEFAULT_PYTHON_CANDIDATES);
  cachedCapability = cachedPythonBin !== undefined ? "descriptor-relative" : "unavailable";
  return cachedPythonBin;
}

/**
 * What this platform actually provides for write safety.
 *
 * "descriptor-relative" means a real isolated filesystem executor
 * (`packages/cli/src/native/verified-write.py`, invoked as a subprocess) is
 * available and is what actually performs every managed write, in-root or
 * approved outside-root alike: it opens the caller's TRUST ANCHOR directory
 * once — verifying its device+inode identity against what was captured at
 * authorization time, not just that the path string still resolves to
 * something — then walks each remaining path component relative to the
 * PREVIOUSLY VERIFIED parent directory's own file descriptor with
 * O_NOFOLLOW, so a symlink (or a different real directory swapped in under
 * the same name) substituted into any ancestor — at any point before or
 * during that walk — cannot redirect the write. This is the real
 * descriptor-relative/no-follow traversal-and-commit the plan requires, not
 * a second preflight check layered on top of ordinary path-based I/O.
 *
 * "unavailable" means no such executor could be confirmed (no working
 * `python3`/`python` with the required `os.*(dir_fd=...)` support, or an
 * unsupported platform such as Windows). On "unavailable", managed writes
 * are REFUSED outright — there is no silent fallback to a check-then-write
 * path pretending to be equivalently safe, for in-root OR outside-root
 * targets. The plan does not contain an escape hatch that permits an unsafe
 * managed write to stay enabled; "unavailable" is that explicit, honest
 * outcome, not a completion of the race guarantee.
 */
export function writeCapability(options: WriteExecutorOptions = {}): WriteCapability {
  return resolvePythonBin(options) !== undefined ? "descriptor-relative" : "unavailable";
}

/** Test-only: clears the cached capability/interpreter so the next unparameterized call re-probes. */
export function _resetWriteCapabilityCacheForTests(): void {
  cachedCapability = undefined;
  cachedPythonBin = undefined;
}

export interface WriteTargetCheck {
  ok: boolean;
  resolvedTarget: string;
  reason?: string;
  /** Permission bits of the file currently at resolvedTarget, when one exists — read via the SAME lstat used to reject a symlink, so it's never a second, separately racy stat. Absent when nothing exists there yet. */
  existingMode?: number;
}

/**
 * Resolves the canonical write target and rejects any request whose final
 * path component is a symlink — existing (pointing inside or outside the
 * root) or dangling — or any existing non-regular-file occupant. Rejection,
 * not silent substitution, is the contract: the caller decides which target
 * it meant, never the filesystem's current symlink state.
 *
 * This function is GATE-TIME evidence and diagnostics (deciding ask/deny,
 * showing a diff, an early clear error message) — it is deliberately still
 * path-based and re-resolves on every call. It is NOT what makes the actual
 * write safe; that guarantee lives in the prepareWritePermit/executeWritePermit
 * pair's descriptor-relative executor. Do not treat a passing checkWriteTarget
 * call as proof that a subsequent write is safe from a concurrent
 * substitution — only the executor's own live traversal, anchored to an
 * identity captured at authorization time, provides that.
 */
export function checkWriteTarget(root: string, target: string): WriteTargetCheck {
  const resolvedTarget = resolveParentForWrite(root, target);
  let st;
  try {
    st = lstatSync(resolvedTarget);
  } catch {
    st = undefined;
  }
  if (st?.isSymbolicLink()) {
    return {
      ok: false,
      resolvedTarget,
      reason: `refusing to write through a symlink at "${target}": the final path component is a symlink, not a regular file`,
    };
  }
  if (st && !st.isFile()) {
    return {
      ok: false,
      resolvedTarget,
      reason: `refusing to write "${target}": an existing non-regular file occupies that path`,
    };
  }
  return { ok: true, resolvedTarget, ...(st ? { existingMode: st.mode & 0o777 } : {}) };
}

export type WriteResult = { ok: true; resolvedTarget: string; bytesWritten: number } | { ok: false; reason: string };

function absoluteLexicalPath(root: string, target: string): string {
  const expanded = expandHome(target);
  return normalizeAbsolute(isAbsolute(expanded) ? expanded : join(root, expanded));
}

/**
 * The canonical identity a write's target must still match at execution
 * time for it to be the SAME write that was authorized — computed from the
 * SAME (root, target) pair prepareWritePermit uses, so a caller can detect
 * "the tool call's own arguments changed after authorization" (R3: the
 * changed_action reproduction) with a cheap string comparison, independent
 * of and in addition to the descriptor-relative executor's own filesystem-
 * level checks.
 */
export function writeTargetKey(root: string, target: string): string {
  return absoluteLexicalPath(realpathIfExists(root), target);
}

/**
 * Splits `absLexical` into path segments relative to `canonicalRoot`, or
 * returns null if it does not resolve under the root. Deliberately LEXICAL
 * (never realpath'd): a component list built from a realpath would already
 * have silently followed any symlink present at check time, which is
 * exactly the defect this function exists to avoid feeding into the
 * descriptor-relative executor — the executor's own live, no-follow walk is
 * what must discover a symlink, never a string resolver upstream of it.
 */
function componentsUnderRoot(canonicalRoot: string, absLexical: string): string[] | null {
  const prefix = canonicalRoot.endsWith("/") ? canonicalRoot : `${canonicalRoot}/`;
  if (absLexical === canonicalRoot) return [];
  if (!absLexical.startsWith(prefix)) return null;
  return absLexical
    .slice(prefix.length)
    .split("/")
    .filter((seg) => seg.length > 0);
}

type AnchorProbe = { kind: "ok"; dev: string; ino: string } | { kind: "missing" } | { kind: "invalid"; reason: string };

/** lstat (never follows) a candidate anchor path, distinguishing "does not exist yet" (caller may walk further up) from "exists but isn't a usable real directory" (caller must refuse, never skip past it). */
function probeAnchor(path: string): AnchorProbe {
  let st;
  try {
    st = lstatSync(path, { bigint: true });
  } catch {
    return { kind: "missing" };
  }
  if (st.isSymbolicLink()) {
    return { kind: "invalid", reason: `refusing to write: "${path}" is a symlink, not a real directory` };
  }
  if (!st.isDirectory()) {
    return { kind: "invalid", reason: `refusing to write: "${path}" is not a directory` };
  }
  return { kind: "ok", dev: st.dev.toString(), ino: st.ino.toString() };
}

interface AnchorFound {
  ok: true;
  anchorPath: string;
  anchorDev: string;
  anchorIno: string;
  components: string[];
}
type AnchorResult = AnchorFound | { ok: false; reason: string };

function anchorForInRoot(canonicalRoot: string, components: string[]): AnchorResult {
  const probe = probeAnchor(canonicalRoot);
  if (probe.kind === "missing") return { ok: false, reason: `refusing to write: project root "${canonicalRoot}" does not exist` };
  if (probe.kind === "invalid") return { ok: false, reason: probe.reason };
  return { ok: true, anchorPath: canonicalRoot, anchorDev: probe.dev, anchorIno: probe.ino, components };
}

/**
 * For a target OUTSIDE the configured root: the trust anchor is the DEEPEST
 * EXISTING real directory on the path to it, captured (identity included)
 * at authorization time — the same "pin an anchor, walk the rest
 * descriptor-relative" strategy used for the in-root case, generalized to
 * an arbitrary approved outside location instead of assuming a single fixed
 * anchor (like "/") could safely walk every possible target (it cannot:
 * ordinary system symlinks such as macOS's /tmp -> /private/tmp would
 * themselves be rejected as "a component is a symlink").
 *
 * This anchor is pinned only as deep as something already exists: a symlink
 * or non-directory found while walking up is refused outright (never
 * silently skipped past), but an ancestor ABOVE the chosen anchor that gets
 * swapped later is not covered by this mechanism — the same category of
 * narrow, documented residual as an in-root ancestor swap two or more
 * levels above an already-descended-into directory. See README "Write
 * safety".
 */
function anchorForOutsideRoot(absLexical: string): AnchorResult {
  let dir = dirname(absLexical);
  const trailing: string[] = [basename(absLexical)];
  for (;;) {
    const probe = probeAnchor(dir);
    if (probe.kind === "ok") return { ok: true, anchorPath: dir, anchorDev: probe.dev, anchorIno: probe.ino, components: trailing };
    if (probe.kind === "invalid") return { ok: false, reason: probe.reason };
    const parent = dirname(dir);
    if (parent === dir) return { ok: false, reason: `refusing to write: no existing real ancestor directory found above "${absLexical}"` };
    trailing.unshift(basename(dir));
    dir = parent;
  }
}

/**
 * An immutable, single-use authorization record: everything the
 * descriptor-relative executor needs to actually perform (or refuse) a
 * write, captured ONCE at authorization time and never recomputed from
 * live, possibly-attacker-mutated tool-call arguments. `targetKey` and
 * `contentDigest` let a caller (tools.ts's write execute()) detect that the
 * ACTUAL arguments it was asked to execute no longer match what this permit
 * authorizes — the R3 "changed_action" gap — before ever touching the
 * filesystem; `anchorPath`/`anchorDev`/`anchorIno`/`components` let the
 * executor detect that the filesystem itself no longer matches what was
 * authorized, independent of what the tool-call arguments say.
 */
export interface WritePermit {
  anchorPath: string;
  anchorDev: string;
  anchorIno: string;
  components: string[];
  targetKey: string;
  contentDigest: string;
  preimageDigest: string;
}

export type PreparedWrite = { ok: true; permit: WritePermit } | { ok: false; reason: string };

/**
 * Builds a WritePermit from (root, target, content, preimageDigest) — call
 * this exactly ONCE, at authorization time, using values captured BEFORE
 * any await (a Jev judgment, a human approval wait) that an attacker could
 * act within. The resulting permit is inert data: nothing about it changes
 * if the caller's own `target`/`content` variables are mutated afterward.
 */
export function prepareWritePermit(root: string, target: string, content: string, preimageDigest: string): PreparedWrite {
  const canonicalRoot = realpathIfExists(root);
  const absLexical = absoluteLexicalPath(canonicalRoot, target);
  const inRootComponents = componentsUnderRoot(canonicalRoot, absLexical);
  const anchor =
    inRootComponents !== null && inRootComponents.length > 0
      ? anchorForInRoot(canonicalRoot, inRootComponents)
      : anchorForOutsideRoot(absLexical);
  if (!anchor.ok) return anchor;
  return {
    ok: true,
    permit: {
      anchorPath: anchor.anchorPath,
      anchorDev: anchor.anchorDev,
      anchorIno: anchor.anchorIno,
      components: anchor.components,
      targetKey: absLexical,
      contentDigest: contentHash(content),
      preimageDigest,
    },
  };
}

function describeHelperFailure(status: number | null | undefined, stderr: string): string {
  const trimmed = stderr.trim();
  if (trimmed.startsWith("SYMLINK_OR_NON_DIR:")) {
    return `refusing to write through a symlink or non-directory ancestor: ${trimmed.slice("SYMLINK_OR_NON_DIR:".length)}`;
  }
  if (trimmed.startsWith("FINAL_IS_SYMLINK:")) {
    return "refusing to write through a symlink: the final path component is a symlink, not a regular file";
  }
  if (trimmed.startsWith("FINAL_NOT_REGULAR:")) {
    return "refusing to write: an existing non-regular file occupies that path";
  }
  if (trimmed.startsWith("INVALID_COMPONENT:")) {
    return `refusing to write: invalid path component ${trimmed.slice("INVALID_COMPONENT:".length)}`;
  }
  if (trimmed.startsWith("ANCHOR_IDENTITY_MISMATCH:")) {
    return `refusing to write: the trust anchor directory changed since authorization (${trimmed.slice("ANCHOR_IDENTITY_MISMATCH:".length)})`;
  }
  if (trimmed.startsWith("ANCHOR_OPEN_FAILED:")) {
    return `refusing to write: the trust anchor directory could not be opened without following a symlink (${trimmed.slice("ANCHOR_OPEN_FAILED:".length)})`;
  }
  if (trimmed.startsWith("PREIMAGE_MISMATCH:")) {
    return `file contents changed since approval was requested: ${trimmed.slice("PREIMAGE_MISMATCH:".length)}`;
  }
  return `managed write failed (exit ${status ?? "unknown"}): ${trimmed || "unknown error"}`;
}

function runDescriptorRelativeWrite(pythonBin: string, permit: WritePermit, content: string): WriteResult {
  const finalName = permit.components[permit.components.length - 1]!;
  const intermediate = permit.components.slice(0, -1);
  let stdout: string;
  try {
    stdout = execFileSync(
      pythonBin,
      [NATIVE_HELPER_PATH, permit.anchorPath, permit.anchorDev, permit.anchorIno, permit.preimageDigest, ...intermediate, finalName],
      {
        input: content,
        encoding: "utf8",
        timeout: HELPER_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        // Fully capture stderr rather than the execFileSync default of also
        // inheriting it to our own stderr — a rejected write (e.g. a real
        // symlink attempt) is an expected, structured outcome here, not
        // something that should print raw subprocess diagnostics to the
        // terminal.
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  } catch (err) {
    const e = err as { status?: number | null; stderr?: string | Buffer };
    const stderr = typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString("utf8") ?? "");
    return { ok: false, reason: describeHelperFailure(e.status, stderr) };
  }
  const match = stdout.trim().match(/^OK (\d+)$/);
  const bytesWritten = match ? Number(match[1]) : Buffer.byteLength(content, "utf8");
  return { ok: true, resolvedTarget: join(permit.anchorPath, ...permit.components), bytesWritten };
}

/**
 * Executes a previously prepared WritePermit. This is the actual execution
 * boundary: it verifies the content being written still matches what the
 * permit authorized (closing R3's "changed_action" gap — the tool call's
 * own payload cannot drift after authorization and still execute), then
 * hands off to the descriptor-relative executor (or explicitly refuses when
 * unavailable — never a silent downgrade to an unverified path-based
 * write). Target-identity verification (the R2 "root swapped for a
 * symlink" / "approved outside directory swapped" gap) happens inside the
 * executor itself, anchored to the permit's own captured identity, not
 * re-derived from anything the caller could have mutated.
 */
export function executeWritePermit(permit: WritePermit, content: string, options: WriteExecutorOptions = {}): WriteResult {
  if (contentHash(content) !== permit.contentDigest) {
    return { ok: false, reason: "write blocked: content no longer matches what was authorized (changed since approval)" };
  }
  const pythonBin = resolvePythonBin(options);
  if (pythonBin === undefined) {
    return {
      ok: false,
      reason:
        'managed write capability unavailable on this platform (no working descriptor-relative write executor found — see README "Write safety"): refusing to write rather than using an unverified check-then-write path',
    };
  }
  return runDescriptorRelativeWrite(pythonBin, permit, content);
}

/**
 * Convenience one-shot wrapper: prepares a permit and immediately executes
 * it, back to back, with no async gap in between. Safe for tests and any
 * direct (non-harness) caller that has no separate authorization step to
 * bind against — but NOT what the write tool uses when running under the
 * harness (see tools.ts), because a single synchronous call cannot express
 * "authorize now, execute later after a Jev judgment or a human approval
 * wait" — the exact gap R2/R3's prepareWritePermit/executeWritePermit split
 * exists to close. Use prepareWritePermit + executeWritePermit directly
 * whenever authorization and execution are genuinely separated in time.
 */
export function writeFileVerified(root: string, target: string, content: string, options: WriteExecutorOptions = {}): WriteResult {
  const prepared = prepareWritePermit(root, target, content, options.expectedPreimageDigest ?? "-");
  if (!prepared.ok) return prepared;
  return executeWritePermit(prepared.permit, content, options);
}
