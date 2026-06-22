// Type stub for React Compiler's runtime memo-cache helper `c`.
//
// The committed Rayu source is React-Compiler OUTPUT, so every component starts
// with `import { c as _c } from "react/compiler-runtime"` and uses `_c(n)` to
// allocate a memo-slot array. react@19 ships the real implementation at
// node_modules/react/compiler-runtime.js but WITHOUT a declaration file, which
// makes `tsc` raise TS7016 on ~368 files. An ambient `declare module` can't
// override a physically-resolved module, so this stub is mapped in via the
// tsconfig "paths" entry for "react/compiler-runtime".
//
// `c` returns the untyped memo-slot array (`any[]`) — matching how the compiler
// reads/writes `$[i]` slots — so this introduces no false positives downstream.
// Bun uses the real module at build/runtime; this file only affects typechecking.
export function c(size: number): any[]
