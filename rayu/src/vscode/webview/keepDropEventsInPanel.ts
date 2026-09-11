/**
 * Stopping VS Code from taking the drag away from this panel.
 *
 * ── THE PROBLEM, MEASURED ──────────────────────────────────────────────────────
 *
 * Dragging a file onto a webview does nothing by default. Sampled against a real Extension
 * Host, mid-drag, on the iframe that hosts this panel:
 *
 *   drag an editor tab over the panel   → inline `pointer-events: none`, ZERO events in here
 *   the same drag with Shift held       → `pointer-events: auto`
 *
 * The cause is in VS Code's own webview preload (`webview/browser/pre/index.html`). On
 * `dragenter` it runs:
 *
 *     if (e.defaultPrevented) return;              // "Extension code has already handled this"
 *     if (!e.dataTransfer || e.shiftKey) return;
 *     if (every item is kind === 'file') hostMessaging.postMessage('drag-start')
 *
 * and the host answers `drag-start` with `element.style.pointerEvents = 'none'`
 * (`webviewElement._startBlockingIframeDragEvents`), which makes the whole panel transparent
 * for the rest of the gesture. The workbench then receives the drop instead — observed landing
 * on `.webview-overlay-content`.
 *
 * That condition catches ORDINARY internal drags too, not just drags from the operating
 * system: the workbench attaches a `DownloadURL` to editor and Explorer drags
 * (`fillEditorsDragData`), and Chromium reports a `DownloadURL` drag as containing a file.
 *
 * ── THE FIX IS THE ESCAPE HATCH THE PRELOAD ITSELF OFFERS ──────────────────────
 *
 * `if (e.defaultPrevented) return` is a documented opt-out: "Extension code has already
 * handled this event". Calling `preventDefault()` in the CAPTURE phase — before the preload's
 * own listener, which is registered in the bubble phase on the window — satisfies it, so
 * `drag-start` is never posted, `pointer-events` is never blanked, and the drag continues into
 * this panel where the ordinary handlers in `usePanelDrop` can read it.
 *
 * The listener is installed on this window AND on every ancestor window we are permitted to
 * touch, because the preload registers its copy on both the shell frame and this one.
 *
 * ── IT IS UNCONDITIONAL, AND THAT IS THE WHOLE POINT ───────────────────────────
 *
 * An earlier version only cancelled when the transfer carried a format this panel could use.
 * That looked careful and was self-defeating: `dataTransfer.types` can legitimately be EMPTY on
 * `dragenter`, and any drag whose types are not yet visible would slip through the gate, reach
 * the preload unprevented, and get the panel blanked for the rest of the gesture — the exact
 * failure this module exists to prevent, reintroduced by the guard meant to make it safe.
 *
 * Cancelling everything is safe here because `preventDefault` on `dragenter`/`dragover` means
 * only "a drop is allowed at this point". The ancestor document contains nothing but the frame
 * this panel renders in, so no other drop target is being deprived, and `usePanelDrop` still
 * decides independently whether a given payload is usable — a drag it cannot use ends with a
 * message saying so rather than with a silent no-op.
 *
 * ── FAILURE IS SILENT AND HARMLESS, DELIBERATELY ───────────────────────────────
 *
 * Every window hop is wrapped: a future VS Code that tightens the sandbox would make the
 * ancestor cross-origin, and reading it throws. That must degrade to the old behaviour rather
 * than break the panel, which is why nothing here rethrows.
 */

/**
 * Marker used to retire a previous installation from the same ancestor window.
 *
 * The ancestor OUTLIVES this document — VS Code reuses the shell frame across webview
 * reloads — so without this, every reload would leave another live listener behind on it.
 */
const INSTALLED = '__rayucodeDropUnblock'

/** How far up to walk. One hop is the real depth; the bound only stops a pathological loop. */
const MAX_ANCESTORS = 4

/**
 * Keep drag events inside this panel. Returns a disposer.
 *
 * Idempotent per window: installing twice retires the first installation, so React's
 * development double-invoke and a webview reload both end up with exactly one listener.
 */
export function keepDropEventsInPanel(): () => void {
  const disposers: Array<() => void> = []

  let current: Window | null = window
  for (let hop = 0; current && hop <= MAX_ANCESTORS; hop += 1) {
    const target: Window = current
    try {
      // Retire whatever a previous document of ours left on this window.
      const previous = (target as unknown as Record<string, unknown>)[INSTALLED]
      if (typeof previous === 'function') (previous as () => void)()

      const cancel = (event: Event): void => {
        event.preventDefault()
      }
      // `drag` as well as the pointer events: the preload listens on all three and any of them
      // reaching its handler unprevented is enough to trigger the block.
      const types = ['dragenter', 'dragover', 'drag'] as const
      for (const type of types) {
        target.addEventListener(type, cancel, { capture: true })
      }
      const dispose = (): void => {
        for (const type of types) {
          target.removeEventListener(type, cancel, { capture: true })
        }
        delete (target as unknown as Record<string, unknown>)[INSTALLED]
      }
      ;(target as unknown as Record<string, unknown>)[INSTALLED] = dispose
      disposers.push(dispose)
    } catch {
      // A cross-origin ancestor. Nothing can be done for it, and nothing needs to be: the
      // panel still works, it just needs the Shift gesture it already documents.
    }

    try {
      const parent: Window = target.parent
      current = parent === target ? null : parent
    } catch {
      current = null
    }
  }

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // The window went away with the panel. Nothing to detach from.
      }
    }
  }
}
