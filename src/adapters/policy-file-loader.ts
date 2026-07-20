// Adapter: load a policy from a JSON file on disk. This is an edge module — the
// filesystem meets the pure core here. The pure structural parse lives in parse.ts
// (`parsePolicy`); this module only does the I/O and the one deterministic startup
// gate that needs the filesystem: CONF-01, refusing a world-writable policy file.
//
// Format is JSON (D-023): dep-free, so the guard adds no parser to its own supply
// chain — the exact class of transitive dependency it exists to be skeptical of.
import { statSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { modeIsWorldWritable } from "./fs-perms.js";
import { parsePolicy } from "../parse.js";
import type { Result } from "../parse.js";
import type { Policy } from "../types.js";

const fail = (reason: string, detail: string): Result<Policy> => ({ ok: false, reason, detail });

/**
 * Read, permission-check, and parse a policy file into a trustworthy `Policy`.
 * Never throws: every failure is a specific, stable reason code (fail-closed).
 *
 * Order matters — permissions are checked BEFORE the contents are read, so a
 * world-writable file is refused without its (possibly tampered) bytes being trusted.
 */
export function loadPolicyFile(path: string): Result<Policy> {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    return fail("config.file_unreadable", `Policy file "${path}" could not be stat'd.`);
  }
  // CONF-01: a world-writable policy could be silently rewritten by any local user.
  // Scoped exactly to the world-write bit — not group, not owner: mechanism, not judgment.
  // Guarded for Windows (PLAT-01), where synthesized mode bits would misfire into a deny-all.
  if (modeIsWorldWritable(mode)) {
    return fail("config.world_writable", `Policy file "${path}" is world-writable; refusing to load it.`);
  }
  // CONF-03: refuse a world-writable *directory* too. Directory-write governs rename/replace of its
  // entries, so a world-writable dir lets any local user swap `policy.json` for a permissive one (also
  // 0o600, passing the file check above). Same predicate, world-only + sticky-blind, same rationale as
  // the file gate — and POSIX-only (PLAT-01), since `modeIsWorldWritable` is a no-op on win32.
  let dirMode: number;
  try {
    dirMode = statSync(dirname(path)).mode;
  } catch {
    return fail("config.file_unreadable", `Policy directory for "${path}" could not be stat'd.`);
  }
  if (modeIsWorldWritable(dirMode)) {
    return fail("config.dir_world_writable", `Policy directory "${dirname(path)}" is world-writable; refusing to load "${path}".`);
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return fail("config.file_unreadable", `Policy file "${path}" could not be read.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("config.json_malformed", `Policy file "${path}" is not valid JSON.`);
  }
  return parsePolicy(parsed);
}
