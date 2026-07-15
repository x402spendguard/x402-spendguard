// POSIX file-permission helper, guarded for portability (PLAT-01). See the shared
// file-permission-gates note in REQUIREMENTS.md.
//
// On Windows, Node SYNTHESIZES stat().mode from the read-only attribute — a normal writable file
// reports 0o666 — so an *unguarded* `& 0o002` world-writable test would MISFIRE: it would refuse
// every policy file and every ledger version file, bricking the policy loader and the spend store
// into a deny-all. Windows privacy+integrity are ACL-based, not mode-based (place these files under
// %LOCALAPPDATA%, where inherited ACLs restrict them to the owner); the POSIX gates are skipped there.

/** True iff `mode` has the world-write bit set — but never on Windows, where the synthesized mode
 *  bits are not meaningful. This is the single guarded predicate both perm gates use. See PLAT-01. */
export function modeIsWorldWritable(mode: number): boolean {
  if (process.platform === "win32") return false; // synthesized mode bits are not meaningful here
  return (mode & 0o002) !== 0;
}
