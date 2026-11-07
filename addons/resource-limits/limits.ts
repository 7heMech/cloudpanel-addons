/** Maximum time for one service query. */
export const COMMAND_MS = 30_000;
/**
 * Everything `set-memory` changes, and its undoing when a step fails: one apply is at most ten
 * commands, and a few seconds when nothing hangs. A command that would outlast it is cut short.
 */
export const MEMORY_DEADLINE_MS = 120_000;
/**
 * The change and its undoing under their deadline, the 15 s settings lock wait, and memory.json's own
 * lock, waited on for up to 10 s at most three times in a change and three in its undoing; then the
 * reply. The page the browser repaints comes from a separate `state` request.
 */
export const MEMORY_GATEWAY_TIMEOUT_MS = MEMORY_DEADLINE_MS + 15_000 + 6 * 10_000 + 30_000;
