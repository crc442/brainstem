// Policy path resolution remains shared with the core static floor.
export { isInside, resolveParentForWrite, resolvePath } from "@brainstem/core";

export type WriteCapability = "unavailable";

export const WRITE_UNAVAILABLE_REASON =
  "managed write capability unavailable: this runtime has no executor that protects staging and atomically commits only against the approved file version; no files were changed";

/**
 * Descriptor-relative traversal prevents path substitution while opening
 * files, but does not provide conditional replacement at commit. A final
 * check followed by rename can still overwrite a concurrent edit. Until an
 * isolated or transactional backend enforces that contract, the R2/R3
 * release rule is to refuse managed writes on every platform.
 */
export function writeCapability(): WriteCapability {
  return "unavailable";
}

export type WriteResult = { ok: false; reason: string };

/** Kept as a refusing entry point for direct callers of the former executor. */
export function writeFileVerified(_root: string, _target: string, _content: string): WriteResult {
  return { ok: false, reason: WRITE_UNAVAILABLE_REASON };
}
