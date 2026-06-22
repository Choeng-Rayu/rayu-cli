// Reconstructed generic utility types — absent from the leaked source.
// Type-only (erased at build). `DeepImmutable` is the identity here (rather
// than a deep-readonly mapped type) so it never introduces spurious
// "cannot assign to readonly" errors in the generated consumers.

export type DeepImmutable<T> = T

// A permissive stand-in for the original tuple-permutations helper.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Permutations<T = any> = T[]
