#!/usr/bin/env python3
"""
Scoped, isolated filesystem executor for R2/R3 (see
docs/plans/2026-09-22-review-remediation.md). This is the ONLY thing that
actually writes a file under a managed write: every path component —
including the trust anchor itself, AND every intermediate directory between
it and the final file — is opened relative to the PREVIOUSLY VERIFIED
parent directory's own file descriptor, using O_NOFOLLOW, and its identity
(device+inode) is checked on that SAME opened descriptor against an
expectation the caller captured at AUTHORIZATION time — never against a
separate, later, re-racable path-based stat. A symlink OR a different real
directory substituted for the anchor, or for any intermediate ancestor, at
ANY point between authorization and this process running — however long
that window is — cannot redirect the write, because identity is verified on
the descriptor actually used to descend, not re-derived from a path string.

This is deliberately narrow: it does exactly one thing (verify a path
component-by-component via descriptor-relative syscalls, checking identity
on each opened descriptor, then atomically write and rename within the
final verified directory's fd) and nothing else. It is invoked once per
managed write by packages/cli/src/paths.ts, which is the only caller and is
responsible for (a) capturing every expected identity BEFORE any Jev/human-
approval wait, never after, and (b) validating that every argv path
component is a single safe path segment before invoking this script.

Protocol:
  argv:
    [0] anchor
    [1] expected-anchor-dev
    [2] expected-anchor-ino
    [3] expected-preimage-digest-or-"-"
    [4] expected-final-dev-or-"-"
    [5] expected-final-ino-or-"-"
    [6] n-intermediate (count of intermediate directory components)
    for i in 0..n-intermediate-1:
      [7+3i]   precondition kind: "E" (expected to exist) or "M" (expected
                missing, to be created)
      [7+3i+1] expected dev ("-" when kind is "M")
      [7+3i+2] expected ino ("-" when kind is "M")
    [7+3*n .. 7+3*n+n-1]  intermediate component NAMES, in descent order
    [last] final component name
  stdin: the raw bytes to write (read fully before any filesystem action)
  stdout on success: "OK <bytesWritten>"
  stderr + nonzero exit on failure: "<REASON_CODE>:<detail>"

<anchor> is the caller's TRUST ANCHOR directory — the project root for an
in-root write, or the deepest existing real ancestor directory of an
approved outside-root target — captured and canonicalized by the caller at
AUTHORIZATION time, never re-derived here. Its identity is verified exactly
like every intermediate component's below.

Each intermediate component carries its own precondition, captured by the
caller at the SAME authorization moment as the anchor:
  - "E" (exists): the component must open successfully with O_NOFOLLOW and
    its OPENED DESCRIPTOR's device+inode must match exactly. A component
    that was a real, existing directory at authorization time and is a
    DIFFERENT real directory (or a symlink, or missing) now is rejected —
    equal content at that path is never treated as equal identity.
  - "M" (missing): the component must still not exist right before it is
    created (an attacker pre-creating it between authorization and
    execution is not silently accepted as "the directory this call itself
    made"), then is created and descended into.

expected-preimage-digest is either "-" (skip the check), "absent" (the
caller expects no file exists there yet), or a lowercase hex sha256 of the
expected CURRENT content. expected-final-dev/ino are the final file's own
device+inode at authorization time ("-" when not applicable — the caller
expected absence, or opted out of the check), verified on the SAME opened
descriptor the preimage digest is read from — never a separate stat
followed by a separate reopen, and never satisfied by content equality
alone: a file replaced by a byte-identical copy (same digest, different
inode) is rejected exactly like a directory replaced by a byte-identical
one is. All final-file checks happen inside the SAME verified fd chain,
immediately before the write, so a concurrent edit, a concurrent identity
swap, AND a concurrent ancestor symlink/directory swap are all bound to
execution by the same boundary.

Exit codes: 2 anchor open or identity check failed, 3 an intermediate
component's open, precondition, or identity check failed, 4 the final
component is an existing symlink, 5 the final component exists but is not a
regular file, 6 an argv path component is not a single safe path segment,
7 unexpected OS error during the write/rename itself, 8 the existing
content's digest or identity did not match what was expected, 9 malformed
numeric argv values.

Requires a platform where Python's `os` module supports dir_fd for open,
mkdir, rename, and stat, and follow_symlinks=False for stat (verified by
the caller via --probe before ever relying on this script for a real
write). On a platform without that support, the caller must treat managed
writes as unavailable and refuse execution — this script does not attempt
a lesser-safety fallback.
"""
import hashlib
import os
import stat
import sys


def fail(code, msg):
    sys.stderr.write(msg + "\n")
    sys.exit(code)


def is_safe_component(name):
    return name not in ("", ".", "..") and "/" not in name and "\0" not in name


def probe():
    required_dir_fd = (os.open, os.mkdir, os.rename, os.stat, os.unlink, os.chmod)
    ok = all(fn in os.supports_dir_fd for fn in required_dir_fd) and os.stat in os.supports_follow_symlinks
    sys.exit(0 if ok else 1)


def parse_int(value, code, label):
    try:
        return int(value)
    except ValueError:
        fail(code, "BAD_NUMERIC_ARG:%s:%s" % (label, value))


def open_dir_nofollow(name, dir_fd, fail_code, fail_label):
    """Opens `name` relative to `dir_fd` with O_NOFOLLOW and returns the new
    fd, or fails with `fail_code`. O_NOFOLLOW alone rejects a symlink at
    open time; the caller still must fstat the result to check identity and
    that it is actually a directory (O_DIRECTORY does the latter here too,
    but callers additionally verify on the fstat'd result for one uniform
    identity-check code path)."""
    try:
        return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dir_fd)
    except OSError as e:
        fail(fail_code, "%s:%s:%s" % (fail_label, name, e))


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "--probe":
        probe()
        return

    args = sys.argv[1:]
    if len(args) < 7:
        fail(1, "USAGE: anchor expected_dev expected_ino expected_digest_or_dash expected_final_dev_or_dash expected_final_ino_or_dash n_intermediate [kind dev ino]... [names]... final_name  (content on stdin)")
    anchor = args[0]
    expected_anchor_dev = parse_int(args[1], 9, "anchor_dev")
    expected_anchor_ino = parse_int(args[2], 9, "anchor_ino")
    expected_digest = args[3]
    expected_final_dev = None if args[4] == "-" else parse_int(args[4], 9, "final_dev")
    expected_final_ino = None if args[5] == "-" else parse_int(args[5], 9, "final_ino")
    n_intermediate = parse_int(args[6], 9, "n_intermediate")
    if n_intermediate < 0:
        fail(9, "BAD_NUMERIC_ARG:n_intermediate:%d" % n_intermediate)

    idx = 7
    preconditions = []
    for _ in range(n_intermediate):
        if idx + 3 > len(args):
            fail(1, "USAGE: truncated precondition list")
        kind, dev_s, ino_s = args[idx], args[idx + 1], args[idx + 2]
        if kind not in ("E", "M"):
            fail(9, "BAD_PRECONDITION_KIND:%s" % kind)
        preconditions.append((kind, dev_s, ino_s))
        idx += 3

    names_start = idx
    if names_start + n_intermediate + 1 != len(args):
        fail(1, "USAGE: component name count does not match n_intermediate")
    intermediate_names = args[names_start:names_start + n_intermediate]
    final_name = args[-1]

    for comp in intermediate_names + [final_name]:
        if not is_safe_component(comp):
            fail(6, "INVALID_COMPONENT:%s" % comp)

    content = sys.stdin.buffer.read()

    try:
        dir_fd = os.open(anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError as e:
        fail(2, "ANCHOR_OPEN_FAILED:%s" % e)

    try:
        # Identity is verified on the descriptor actually opened above, not
        # a separate path-based stat of `anchor` — this is what distinguishes
        # "the same directory that was here at authorization time" from "a
        # different real directory an attacker swapped in under the same
        # name", which a plain re-open-and-trust cannot.
        anchor_st = os.fstat(dir_fd)
        if anchor_st.st_dev != expected_anchor_dev or anchor_st.st_ino != expected_anchor_ino:
            fail(
                2,
                "ANCHOR_IDENTITY_MISMATCH:expected dev=%s ino=%s but found dev=%s ino=%s"
                % (expected_anchor_dev, expected_anchor_ino, anchor_st.st_dev, anchor_st.st_ino),
            )

        for comp, (kind, dev_s, ino_s) in zip(intermediate_names, preconditions):
            if kind == "E":
                new_fd = open_dir_nofollow(comp, dir_fd, 3, "COMPONENT_OPEN_FAILED")
                st = os.fstat(new_fd)
                if not stat.S_ISDIR(st.st_mode):
                    os.close(new_fd)
                    fail(3, "SYMLINK_OR_NON_DIR:%s" % comp)
                expected_dev = parse_int(dev_s, 9, "component_dev")
                expected_ino = parse_int(ino_s, 9, "component_ino")
                if st.st_dev != expected_dev or st.st_ino != expected_ino:
                    os.close(new_fd)
                    fail(
                        3,
                        "COMPONENT_IDENTITY_MISMATCH:%s expected dev=%s ino=%s but found dev=%s ino=%s"
                        % (comp, expected_dev, expected_ino, st.st_dev, st.st_ino),
                    )
                os.close(dir_fd)
                dir_fd = new_fd
            else:  # "M": expected missing at authorization time
                # Verify it is STILL missing before creating it — an
                # attacker pre-creating this exact path between
                # authorization and execution must not be silently accepted
                # as "the directory this call itself made".
                try:
                    os.stat(comp, dir_fd=dir_fd, follow_symlinks=False)
                    fail(3, "COMPONENT_UNEXPECTEDLY_EXISTS:%s" % comp)
                except FileNotFoundError:
                    pass
                try:
                    os.mkdir(comp, dir_fd=dir_fd)
                except FileExistsError:
                    fail(3, "COMPONENT_UNEXPECTEDLY_EXISTS:%s" % comp)
                new_fd = open_dir_nofollow(comp, dir_fd, 3, "COMPONENT_OPEN_FAILED")
                st = os.fstat(new_fd)
                if not stat.S_ISDIR(st.st_mode):
                    os.close(new_fd)
                    fail(3, "SYMLINK_OR_NON_DIR:%s" % comp)
                os.close(dir_fd)
                dir_fd = new_fd

        # The final component is opened ONCE (O_NOFOLLOW alone rejects a
        # symlink at open time — no separate stat-then-open gap), and every
        # subsequent check (type, identity, preimage digest) is performed on
        # THAT SAME descriptor, never a later path-based reopen. This is
        # what lets identity be verified on "the descriptor actually used",
        # matching the anchor/intermediate components above, rather than
        # trusting a stat that could already be stale by the time anything
        # else happens.
        mode = None
        existed = False
        final_fd = None
        try:
            # O_NONBLOCK: a plain O_RDONLY open of a FIFO blocks until a
            # writer opens it, which would hang this process indefinitely if
            # something other than a regular file occupies the path.
            # O_NONBLOCK makes that open return immediately instead; it has
            # no effect on a regular file, so ordinary reads below (which
            # explicitly loop on os.read) are unaffected.
            final_fd = os.open(final_name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dir_fd)
        except FileNotFoundError:
            pass
        except OSError as e:
            fail(4, "FINAL_IS_SYMLINK:%s:%s" % (final_name, e))

        if final_fd is not None:
            try:
                st = os.fstat(final_fd)
                if not stat.S_ISREG(st.st_mode):
                    fail(5, "FINAL_NOT_REGULAR:%s" % final_name)
                mode = st.st_mode & 0o777
                existed = True
                if expected_final_dev is not None and expected_final_ino is not None:
                    if st.st_dev != expected_final_dev or st.st_ino != expected_final_ino:
                        fail(
                            8,
                            "FINAL_IDENTITY_MISMATCH:%s expected dev=%s ino=%s but found dev=%s ino=%s"
                            % (final_name, expected_final_dev, expected_final_ino, st.st_dev, st.st_ino),
                        )
                if expected_digest not in ("-",):
                    if expected_digest == "absent":
                        fail(8, "PREIMAGE_MISMATCH:expected absent but found an existing file")
                    hasher = hashlib.sha256()
                    while True:
                        chunk = os.read(final_fd, 1024 * 1024)
                        if not chunk:
                            break
                        hasher.update(chunk)
                    actual_digest = hasher.hexdigest()
                    if actual_digest != expected_digest:
                        fail(8, "PREIMAGE_MISMATCH:expected %s but found %s" % (expected_digest, actual_digest))
            finally:
                os.close(final_fd)
        elif expected_digest not in ("-", "absent"):
            fail(8, "PREIMAGE_MISMATCH:expected %s but no file exists" % expected_digest)

        tmp_name = ".%s.%d.tmp" % (final_name, os.getpid())
        try:
            fd = os.open(tmp_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dir_fd)
        except OSError as e:
            fail(7, "TMP_CREATE_FAILED:%s" % e)
        try:
            with os.fdopen(fd, "wb", closefd=True) as f:
                f.write(content)
                f.flush()
                os.fsync(f.fileno())
            if mode is not None:
                os.chmod(tmp_name, mode, dir_fd=dir_fd)
            os.rename(tmp_name, final_name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
        except OSError as e:
            try:
                os.unlink(tmp_name, dir_fd=dir_fd)
            except OSError:
                pass
            fail(7, "WRITE_OR_RENAME_FAILED:%s" % e)

        print("OK %d" % len(content))
    finally:
        try:
            os.close(dir_fd)
        except OSError:
            pass


main()
