# Root Cause: Pasting two or more images into the CLI prompt keeps only one

**Surface:** RAYU CLI (terminal), reported on Windows.
**Symptom:** A user pastes 2+ images into the prompt input, but only one image
attaches. Pasting 3 still yields 1.
**Status:** Root cause verified against source + a repro (run, then removed). Not
an assumption.

There are two independent layers. Layer 1 is a bug in our code and is the
actionable fix. Layer 2 is an upstream Windows Terminal limitation that explains
why the *plain Explorer copy* route can never deliver more than one file.

---

## Layer 1 — the CLI bug: multi-image paste keeps only the LAST image

### The flow

1. A paste that contains image file paths is collected by `usePasteHandler`.
2. On paste completion it reads every path and fires `onImagePaste` **in a
   synchronous loop** — once per image, all in the same event-loop turn.

   `src/hooks/usePasteHandler.ts:148-157`
   ```ts
   for (const imageData of validImages) {
     onImagePaste(imageData.base64, imageData.mediaType, filename, ...)
   }
   ```

3. `onImagePaste` does two things per image:
   - stores the image with a **functional** state update (correct — accumulates), and
   - inserts an `[Image #N]` pill into the input via `insertTextAtCursor`.

   `src/components/PromptInput/PromptInput.tsx:1173-1182`
   ```ts
   setPastedContents(prev => ({ ...prev, [pasteId]: newContent })) // functional: OK
   const prefix = pendingSpaceAfterPillRef.current ? ' ' : ''
   insertTextAtCursor(prefix + formatImageRef(pasteId))           // closure: BROKEN
   ```

### The defect

`insertTextAtCursor` reads `input` and `cursorOffset` **from the render closure**:

`src/components/PromptInput/PromptInput.tsx:1247-1253`
```ts
function insertTextAtCursor(text: string) {
  pushToBuffer(input, cursorOffset, pastedContents);
  const newInput = input.slice(0, cursorOffset) + text + input.slice(cursorOffset);
  trackAndSetInput(newInput);                  // overwrites — never appends
  setCursorOffset(cursorOffset + text.length);
}
```

- `input` is a **prop** (`PromptInput.tsx:207`), owned by `REPL.tsx:1394` state.
- `cursorOffset` is local **state** (`PromptInput.tsx:252`).

React cannot re-render inside the synchronous loop, so **every iteration computes
from the same stale base**. Iteration 2 overwrites iteration 1's pill instead of
appending to it. Only the last pill survives in `input`.

Note the contrast: `setPastedContents` uses the functional form `prev => ...`, so
the *images* accumulate correctly. The *text insertion* does not — it is the one
half of `onImagePaste` that was never made loop-safe.

### The prune finishes the job

An effect deletes every image whose `[Image #N]` reference is missing from `input`:

`src/components/PromptInput/PromptInput.tsx:1189-1200`
```ts
const referencedIds = new Set(parseReferences(input).map(r => r.id));
// ...delete every image content whose id is not referenced
```

Because only the last pill survived the overwrite, **all earlier images are
pruned**. The stored images and the visible pills end up consistent — at one.

### Repro evidence

Real `formatImageRef` / `parseReferences` plus the verbatim insertion logic, on a
`win32` platform, two images pasted in one turn:

```
pastedContents after loop:  [ "1", "2" ]     <- both images stored
committed input after loop: " [Image #2]"    <- pill #1 overwritten
pastedContents after prune: [ "2" ]          <- image #1 deleted
```

Net result: paste 2 → 1 attaches; paste 3 → 1 attaches. Matches the report exactly.

The author already anticipated the loop — the `pendingSpaceAfterPillRef` comment
at `PromptInput.tsx:1177` handles the lazy space between pills — but the insertion
itself was never made accumulate.

### Fix direction

Make the pill insertion loop-safe so each iteration appends to the latest value
rather than overwriting the closure snapshot. Mirror what `setPastedContents`
already does: drive the text/cursor update from the freshest committed value
(functional update or a ref that tracks the latest input/cursor), so N synchronous
`onImagePaste` calls produce N pills and N surviving images.

---

## Layer 2 — Windows Terminal upstream: plain Explorer copy pastes only the FIRST file

If the user copies 2+ files in Explorer (Ctrl+C) and pastes into the terminal,
Windows Terminal's clipboard reader handles the `CF_HDROP` format but queries
**only index 0** — there is no loop over the dropped files:

`microsoft/terminal` — `src/cascadia/TerminalApp/TerminalPage.cpp:199-206`
```cpp
const auto cap = DragQueryFileW(drop, 0, nullptr, 0);          // index 0 only
const auto len = DragQueryFileW(drop, 0, buffer.data(), cap + 1);
```

So the CLI receives a single path regardless of how many files were copied. This
is a terminal limitation, not ours, and cannot be fixed from the CLI.

**Reliable multi-file route on Windows:** "Copy as path" (Ctrl+Shift+C in Windows
11, or Shift + right-click → "Copy as path"). This puts all quoted paths on the
clipboard as plain text (CRLF-separated). Verified: our parser splits that payload
into 2 valid image paths — which then hits Layer 1.

---

## Bottom line

The actionable root cause in the CLI is that **`insertTextAtCursor`
(`PromptInput.tsx:1247`) is not safe for the synchronous multi-image loop** in
`usePasteHandler.ts:148-157`, compounded by the orphan-prune effect
(`PromptInput.tsx:1189`). Fix the insertion to accumulate, and multi-image paste
attaches every image. The plain-Explorer-copy single-file behavior is upstream
Windows Terminal and is worked around with "Copy as path".

## References

- `src/hooks/usePasteHandler.ts:148-157` — synchronous `onImagePaste` loop
- `src/components/PromptInput/PromptInput.tsx:1151-1183` — `onImagePaste`
- `src/components/PromptInput/PromptInput.tsx:1247-1253` — `insertTextAtCursor` (defect)
- `src/components/PromptInput/PromptInput.tsx:1189-1200` — orphan-prune effect
- `src/components/PromptInput/PromptInput.tsx:207,252` — `input` prop / `cursorOffset` state
- `src/screens/REPL.tsx:1394` — owner of the `input` state
- [Windows Terminal TerminalPage.cpp (CF_HDROP paste)](https://github.com/microsoft/terminal/blob/main/src/cascadia/TerminalApp/TerminalPage.cpp)
- [Windows Terminal Clipboard.cpp](https://github.com/microsoft/terminal/blob/main/src/interactivity/win32/Clipboard.cpp)
