/**
 * The Rayucode chooser for `/model_image_generation` and `/model_video_generation`.
 *
 * A media chooser carries its own list (fetched live by the connect helper); it must
 * show THAT list, never the session's chat-model catalogue, and its loading and error
 * states must stay distinguishable from an empty catalog.
 */
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { ModelChooserCard } from '../src/vscode/webview/components/ModelChooserCard.js'
import type {
  ModelCatalogueView,
  ModelChooserView,
} from '../src/vscode/shared/webviewProtocol.js'

const noop = () => {}

const CHAT_CATALOGUE: ModelCatalogueView = {
  options: [
    {
      value: 'rayu-hosted\u0000deepseek-v4-pro',
      label: 'DeepSeek V4 Pro',
      description: 'rayu-hosted · deepseek-v4-pro',
      model: 'deepseek-v4-pro',
    },
  ],
  loading: false,
  error: null,
}

function mediaChooser(overrides: Partial<ModelChooserView> = {}): ModelChooserView {
  return {
    target: 'image',
    title: 'Select an image generation model',
    tip: 'Used by /generate-image and /image-editor.',
    current: null,
    defaultNote: 'Rayu-hosted when signed in',
    catalogue: { options: [], loading: true, error: null },
    ...overrides,
  }
}

function render(chooser: ModelChooserView): string {
  return renderToStaticMarkup(
    createElement(ModelChooserCard, {
      chooser,
      catalogue: CHAT_CATALOGUE,
      onChoose: noop,
      onDismiss: noop,
      onRefresh: noop,
      onRefreshOwnList: noop,
    }),
  )
}

describe('media model chooser', () => {
  test('opens in its own loading state, not on the chat models', () => {
    const html = render(mediaChooser())
    expect(html).toContain('Select an image generation model')
    expect(html).toContain('Loading models…')
    expect(html).toContain('Currently: default')
    expect(html).not.toContain('DeepSeek V4 Pro')
  })

  test('lists the live models in order, with the note and the current mark', () => {
    const html = render(
      mediaChooser({
        current: 'rayu-wan2.7-image-pro',
        note: 'Could not refresh the list from Rayu; showing the last list it sent.',
        catalogue: {
          options: [
            {
              value: 'rayu-wan2.7-image-pro',
              label: 'Wan 2.7 Image Pro',
              description: 'rayu-wan2.7-image-pro · Rayu-hosted · generate, edit',
              model: 'rayu-wan2.7-image-pro',
            },
            {
              value: 'rayu-wan2.7-image',
              label: 'Wan 2.7 Image',
              description: 'rayu-wan2.7-image · Rayu-hosted · generate, edit',
              model: 'rayu-wan2.7-image',
            },
          ],
          loading: false,
          error: null,
        },
      }),
    )
    expect(html.indexOf('Wan 2.7 Image Pro')).toBeLessThan(
      html.indexOf('>Wan 2.7 Image<'),
    )
    expect(html).toContain('rayu-wan2.7-image · Rayu-hosted · generate, edit')
    expect(html).toContain('showing the last list it sent')
    expect(html).toContain('codicon-check')
    expect(html).toContain('Active')
    expect(html).toContain('Reset to default')
    expect(html).not.toContain('DeepSeek V4 Pro')
  })

  test('a failed fetch offers a retry instead of an empty list', () => {
    const html = render(
      mediaChooser({
        catalogue: { options: [], loading: false, error: 'Loading image generation models timed out.' },
      }),
    )
    expect(html).toContain('Loading image generation models timed out.')
    expect(html).toContain('Try again')
  })

  test('an empty catalog says where models come from', () => {
    const html = render(
      mediaChooser({ catalogue: { options: [], loading: false, error: null } }),
    )
    expect(html).toContain('Admin → Media Catalogs')
  })

  test('the chat-model choosers still list the session catalogue', () => {
    const html = render({
      target: 'webfetch',
      title: 'Select a model for WebFetch (page summarization)',
      tip: 'tip',
      current: null,
      defaultNote: 'your current model',
    })
    expect(html).toContain('DeepSeek V4 Pro')
  })
})
