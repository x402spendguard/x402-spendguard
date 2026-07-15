// Adapter: load a policy from a JSON file on disk. This is an edge module — the
// filesystem meets the pure core here. The pure structural parse lives in parse.ts
// (`parsePolicy`); this module only does the I/O and the one deterministic startup
// gate that needs the filesystem: CONF-01, refusing a world-writable policy file.
//
// Format is JSON (D-023): dep-free, so the guard adds no parser to its own supply
// chain — the exact class of transitive dependency it exists to be skeptical of.
import { statSync, readFileSync } from "node:fs";
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
