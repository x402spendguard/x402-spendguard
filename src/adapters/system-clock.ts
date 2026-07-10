// Adapter: the real wall clock. This is the ONE sanctioned place a system clock is
// read — the composition-root boundary INJ-01 talks about. Everything else takes a
// Clock by injection and never reads time ambiently. The static test enforces that
// Date.now appears only under src/adapters/.
import type { Clock } from "../accounting/guard.js";
import type { UnixSeconds } from "../types.js";

export const systemClock: Clock = {
  now(): UnixSeconds {
    return BigInt(Math.floor(Date.now() / 1000)) as UnixSeconds;
  },
};
