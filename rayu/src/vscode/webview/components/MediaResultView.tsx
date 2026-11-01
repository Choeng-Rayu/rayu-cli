/**
 * Renders a generated image or video (`ImageGen` / `VideoGen` result).
 *
 * Images come inline as a `data:` URL; videos are served from the host's
 * `webview.asWebviewUri` and played in a native `<video>`. Every fallback path degrades to
 * a filename + Open button rather than an empty box — a preview we cannot draw is still a
 * file the user can open.
 */
import type { ToolResultView } from '../../shared/webviewProtocol.js'

export function MediaResultView({
  result,
  onOpenFile,
}: {
  result: Extract<ToolResultView, { kind: 'media' }>
  onOpenFile?: (path: string) => void
}): JSX.Element {
  const meta: string[] = []
  if (result.model) meta.push(result.model)
  if (result.width && result.height) meta.push(`${result.width}×${result.height}`)
  else if (result.resolution) meta.push(result.resolution)
  if (result.durationSeconds !== undefined) meta.push(`${result.durationSeconds}s`)

  const isVideo = result.media === 'video'
  // A video needs the resolved webview URL to play; the poster is a separate data URL.
  const videoPlayable = isVideo && result.webviewUri !== undefined
  const still = result.previewDataUri

  return (
    <div className="rc-media">
      <div className="rc-media-frame">
        {videoPlayable ? (
          <video
            className="rc-media-player"
            controls
            preload="metadata"
            src={result.webviewUri}
            poster={still}
          />
        ) : still ? (
          // An image, or a video we could not serve (no webviewUri) — show its poster frame.
          <img className="rc-media-player" src={still} alt={result.fileName} />
        ) : (
          <div className="rc-media-placeholder">{result.fileName}</div>
        )}
      </div>
      <div className="rc-media-footer">
        <span className="rc-media-meta" title={result.path}>
          {meta.length > 0 ? meta.join(' · ') : result.fileName}
        </span>
        <button
          type="button"
          className="rc-text-button rc-media-open"
          onClick={() => onOpenFile?.(result.path)}
          title={`Open ${result.path}`}
        >
          Open in editor
        </button>
      </div>
    </div>
  )
}
