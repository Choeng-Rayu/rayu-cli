// Stub: ink global side-effect module. The upstream ink `global.ts` performs
// runtime/type augmentation absent from this tree; `import '../global'` in
// Box.tsx/ScrollBox.tsx is a side-effect import, so it needs a real runtime
// module here (a `.d.ts` alone is type-only and the bundler can't resolve it).
export {}
