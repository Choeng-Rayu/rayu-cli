/**
 * Exit codes with a meaning the extension host acts on.
 *
 * A dependency-free leaf, shared by the engine entrypoint (`src/entrypoints/vscodeHost.ts`)
 * and the host, so the two cannot disagree about a number.
 */

/**
 * The compiled engine stopped itself at its memory limit (see
 * `src/utils/engineMemoryWatchdog.ts`). The conversation is intact on disk and resumes on
 * the next message.
 *
 * 75 is `EX_TEMPFAIL` from sysexits.h — "temporary failure, the user is invited to
 * retry" — and nothing else in the engine exits with it.
 */
export const ENGINE_EXIT_MEMORY_LIMIT = 75
