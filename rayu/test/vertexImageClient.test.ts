import { describe, expect, test } from 'bun:test'
import { buildImagenBody } from '../src/tools/ImageGenTool/vertexImageClient.ts'
import { isVertexImageModel } from '../src/tools/ImageGenTool/models.ts'

describe('isVertexImageModel', () => {
  test('detects imagen models', () => {
    expect(isVertexImageModel('imagen-4.0-generate-001')).toBe(true)
    expect(isVertexImageModel('imagen-3.0-capability-001')).toBe(true)
  })
  test('rejects NVIDIA / undefined', () => {
    expect(isVertexImageModel('black-forest-labs/flux.1-schnell')).toBe(false)
    expect(isVertexImageModel(undefined)).toBe(false)
  })
})

describe('buildImagenBody', () => {
  test('generate: instances[{prompt}] + parameters{sampleCount, aspectRatio}', () => {
    const body = buildImagenBody({
      isEdit: false,
      params: { prompt: 'a cat', aspect_ratio: '16:9' },
    }) as any
    expect(body.instances[0].prompt).toBe('a cat')
    expect(body.parameters.sampleCount).toBe(1)
    expect(body.parameters.aspectRatio).toBe('16:9')
  })

  test('edit: raw reference image + EDIT_MODE_DEFAULT', () => {
    const body = buildImagenBody({
      isEdit: true,
      params: { prompt: 'make it night', image: 'BASE64DATA' },
    }) as any
    expect(body.instances[0].prompt).toBe('make it night')
    const ref = body.instances[0].referenceImages[0]
    expect(ref.referenceType).toBe('REFERENCE_TYPE_RAW')
    expect(ref.referenceImage.bytesBase64Encoded).toBe('BASE64DATA')
    expect(body.parameters.editMode).toBe('EDIT_MODE_DEFAULT')
  })
})
