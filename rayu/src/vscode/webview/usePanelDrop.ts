/**
 * Panel-wide drag and drop.
 *
 * ── THE DROP TARGET IS THE WHOLE PANEL, NOT THE COMPOSER ───────────────────────
 *
 * The handlers used to live on the composer card alone. That is a strip a few rows tall at
 * the bottom of a sidebar, and a file dragged from an editor tab naturally lands on the
 * conversation above it — where nothing was listening, so the drop was silently discarded.
 * From the user's side that is indistinguishable from the feature being broken.
 *
 * ── LISTENERS GO ON `document`, AND `dragover` MUST BE PREVENTED ───────────────
 *
 * A `drop` event is only dispatched if a `dragover` handler called `preventDefault()` first;
 * otherwise the browser keeps its default action and no drop ever arrives. Because the
 * target is the whole panel, that prevention has to happen at the document level — a React
 * prop on one subtree cannot cover the gaps between subtrees.
 *
 * Native listeners rather than React props for the same reason: React attaches at its root
 * container, so a drop over padding outside that container would not be seen.
 *
 * ── WHY THE OVERLAY NEEDS MORE THAN A DEPTH COUNTER ───────────────────────────
 *
 * `dragenter`/`dragleave` fire for every element boundary the pointer crosses, so a boolean
 * flickers as the pointer moves over children; the counter fixes that. But a counter alone
 * gets STUCK in this host, and not rarely:
 *
 * VS Code blanks the webview iframe's pointer events for the duration of any drag that looks
 * like it carries a file, unless Shift is held (see `dropPayload.ts` for the measurement). If
 * that happens after our `dragenter` has run, the overlay is showing and the matching
 * `dragleave` never arrives — the iframe has stopped receiving events entirely. A permanently
 * lit drop target on a panel that will not accept a drop is worse than no target at all.
 *
 * So the overlay is also cleared by `dragend` (which the source frame still delivers), by the
 * window losing focus, and by a watchdog refreshed on every `dragover`. Belt, braces and a
 * timeout, because each covers a case the others do not.
 *
 * ── A DROP WE CANNOT USE IS REPORTED, NOT SWALLOWED ────────────────────────────
 *
 * Chromium deliberately withholds local file PATHS from web content for drags that originate
 * outside the browser. So a non-image file dragged from the operating system arrives as a
 * `File` with no path: it cannot be attached (only images are embedded) and it cannot be
 * referenced. Doing nothing there is indistinguishable from the whole feature being broken,
 * which is exactly the report this module was revised to answer, so the caller is told.
 */
import { useEffect, useRef, useState } from 'react'

import {
  extractPlainText,
  extractUriList,
  hasDroppableTypes,
} from './components/dropPayload.js'
import { keepDropEventsInPanel } from './keepDropEventsInPanel.js'
import { partitionDroppedFiles } from './components/composerAttachments.js'

/** How long the overlay may stay up without a `dragover` before it is assumed abandoned. */
const DRAG_WATCHDOG_MS = 1_500

/**
 * How long a `dragenter` may stand alone before the drag is presumed intercepted.
 *
 * A live drag emits `dragover` continuously — Chromium fires it roughly every animation frame —
 * so a few hundred milliseconds of total silence cannot be a drag that is still in progress.
 * Long enough not to trip on a slow first frame, short enough to explain itself while the user
 * is still holding the mouse button.
 */
const INTERCEPTION_MS = 400

export interface PanelDropHandlers {
  /** File references, already normalised to a `text/uri-list` payload for the host. */
  onPaths: (uriList: string) => void
  /** Images dropped from the OS, which arrive as real `File` objects. */
  onImages: (files: File[]) => void
  /** A selection dragged out of an editor. */
  onText: (text: string) => void
  /**
   * The drop carried files this panel can neither embed nor reference.
   *
   * Reported so the user is told why nothing happened — see the header. Called with the file
   * names, which is all a pathless `File` can offer.
   */
  onUnusable: (names: string[]) => void
  /**
   * VS Code took the drag away before it could be dropped.
   *
   * Detected from a signature that has exactly one cause: a `dragenter` arrives and then NOTHING
   * follows — no `dragover`, no `dragleave`, no `drop`. An ordinary drag that leaves the panel
   * always produces a `dragleave`, and one that continues always produces `dragover`, so silence
   * means the panel stopped receiving events mid-gesture. That is what
   * `_startBlockingIframeDragEvents` does when the preload's opt-out did not take effect.
   *
   * Worth reporting rather than swallowing: without it the user drags a file, sees the drop
   * target light up for an instant, and then nothing at all — which is the report that started
   * this whole investigation. With it, they are told what happened and what to do instead.
   */
  onIntercepted: () => void
}

/**
 * Returns whether a drag is currently over the panel, for the drop overlay.
 *
 * The handlers are held in a ref so the effect can register ONCE. Passing them directly
 * would re-register on every render, and a re-registration mid-drag loses the depth count
 * and leaves the overlay stuck on.
 */
export function usePanelDrop(handlers: PanelDropHandlers): boolean {
  const [isDragging, setIsDragging] = useState(false)
  const depth = useRef(0)
  const watchdog = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Fires if a `dragenter` is never followed by anything. See `onIntercepted`. */
  const interception = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef(handlers)
  latest.current = handlers

  useEffect(() => {
    // Installed FIRST, and on the ancestor frames as well as this one: without it VS Code
    // blanks this panel's pointer events as soon as the drag arrives and none of the handlers
    // below ever run. See that module for the measurement.
    const releaseUnblock = keepDropEventsInPanel()

    function clearWatchdog(): void {
      if (watchdog.current !== null) {
        clearTimeout(watchdog.current)
        watchdog.current = null
      }
    }

    /** Cancel the interception check: the drag is demonstrably still reaching us. */
    function clearInterception(): void {
      if (interception.current !== null) {
        clearTimeout(interception.current)
        interception.current = null
      }
    }

    function stop(): void {
      clearWatchdog()
      clearInterception()
      depth.current = 0
      setIsDragging(false)
    }

    function armWatchdog(): void {
      clearWatchdog()
      watchdog.current = setTimeout(stop, DRAG_WATCHDOG_MS)
    }

    function onDragEnter(event: DragEvent): void {
      // `preventDefault` unconditionally: `keepDropEventsInPanel` already cancels every drag at
      // the window level for the reason documented there, and repeating the decision with a
      // different rule here is how the panel ended up blanked despite the unblock being
      // installed. The type check below governs only the OVERLAY — a text selection dragged
      // inside our own transcript should not light up a drop target.
      event.preventDefault()
      if (!hasDroppableTypes(event.dataTransfer)) return
      depth.current += 1
      setIsDragging(true)
      armWatchdog()
      // Armed on EVERY dragenter and cancelled by the next event of any kind. Only a drag that
      // was taken away leaves it to fire.
      clearInterception()
      interception.current = setTimeout(() => {
        interception.current = null
        stop()
        latest.current.onIntercepted()
      }, INTERCEPTION_MS)
    }

    function onDragOver(event: DragEvent): void {
      // REQUIRED. Without this the browser's default action wins and `drop` never fires.
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
      // Proof the drag is still ours.
      clearInterception()
      // Only refresh the watchdog while a drag we accepted is live, so a drag that was
      // already dismissed cannot keep the overlay alive.
      if (depth.current > 0) armWatchdog()
    }

    function onDragLeave(event: DragEvent): void {
      event.preventDefault()
      // A real dragleave means the gesture reached us and moved on: not an interception.
      clearInterception()
      if (depth.current === 0) return
      depth.current -= 1
      if (depth.current <= 0) stop()
    }

    function onDrop(event: DragEvent): void {
      event.preventDefault()
      stop()

      const data = event.dataTransfer
      if (!data) return

      // Images are embedded; every other file is referenced by path. Reading a source file
      // into the prompt would duplicate the engine's own @-mention expansion, and do it
      // worse — no truncation policy, no permission checks.
      const dropped = Array.from(data.files ?? [])
      const { images, others } = partitionDroppedFiles(dropped)
      if (images.length > 0) latest.current.onImages(images)

      const uriList = extractUriList(data)
      if (uriList) {
        latest.current.onPaths(uriList)
        return
      }

      if (images.length > 0) return

      const text = extractPlainText(data)
      if (text) {
        latest.current.onText(text)
        return
      }

      // Files arrived but nothing could be made of them: no path, and not an image. Saying so
      // is the difference between a limitation and an apparently broken panel.
      if (others.length > 0) {
        latest.current.onUnusable(others.map(file => file.name).filter(Boolean))
      }
    }

    // Capture phase: registered before any handler inside the document can call
    // `stopPropagation`, so a stray listener in rendered content cannot swallow a drop
    // meant for the panel. Also guarantees our `dragover` prevention runs first, which is
    // what makes `drop` fire at all.
    const options: AddEventListenerOptions = { capture: true }
    document.addEventListener('dragenter', onDragEnter, options)
    document.addEventListener('dragover', onDragOver, options)
    document.addEventListener('dragleave', onDragLeave, options)
    document.addEventListener('drop', onDrop, options)
    // `dragend` fires in the frame the drag STARTED in, so it arrives for a drag that began
    // inside the panel. `blur` covers the case where the workbench took the drag over and
    // this frame will hear nothing further.
    document.addEventListener('dragend', stop, options)
    window.addEventListener('blur', stop)
    return () => {
      clearWatchdog()
      clearInterception()
      releaseUnblock()
      document.removeEventListener('dragenter', onDragEnter, options)
      document.removeEventListener('dragover', onDragOver, options)
      document.removeEventListener('dragleave', onDragLeave, options)
      document.removeEventListener('drop', onDrop, options)
      document.removeEventListener('dragend', stop, options)
      window.removeEventListener('blur', stop)
    }
  }, [])

  return isDragging
}
