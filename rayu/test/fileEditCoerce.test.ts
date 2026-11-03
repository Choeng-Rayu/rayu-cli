// Key-name repair for Edit / Write inputs.
//
// Both schemas are z.strictObject, so a semantically perfect call using camelCase
// keys threw inside normalizeToolInput and the throw was swallowed — the model
// then saw a schema error listing every canonical field as missing, with no hint
// that only the KEY NAMES were wrong.
import { describe, expect, test } from 'bun:test'
import {
  coerceFileEditInput,
  coerceFileWriteInput,
} from '../src/tools/FileEditTool/coerce.ts'
import { FileEditTool } from '../src/tools/FileEditTool/FileEditTool.ts'
import { FileWriteTool } from '../src/tools/FileWriteTool/FileWriteTool.ts'

describe('canonical input is a strict no-op', () => {
  test('Edit: the SAME object reference comes back', () => {
    const input = {
      file_path: '/a.ts',
      old_string: 'x',
      new_string: 'y',
      replace_all: false,
    }
    expect(coerceFileEditInput(input)).toBe(input)
  })

  test('Write: the SAME object reference comes back', () => {
    const input = { file_path: '/a.ts', content: 'hello' }
    expect(coerceFileWriteInput(input)).toBe(input)
  })

  test('non-objects pass through untouched', () => {
    expect(coerceFileEditInput(null)).toBeNull()
    expect(coerceFileEditInput('nope')).toBe('nope')
    const arr: unknown[] = []
    expect(coerceFileEditInput(arr)).toBe(arr)
  })
})

describe('Edit aliases map to canonical keys', () => {
  const fileAliases = [
    'filePath',
    'path',
    'file',
    'filename',
    'fileName',
    'target_file',
    'targetFile',
  ]
  for (const alias of fileAliases) {
    test(`${alias} → file_path`, () => {
      const out = coerceFileEditInput({
        [alias]: '/a.ts',
        old_string: 'x',
        new_string: 'y',
      }) as Record<string, unknown>
      expect(out.file_path).toBe('/a.ts')
      expect(alias in out).toBe(false)
    })
  }

  const oldAliases = [
    'oldString',
    'old_str',
    'oldStr',
    'old',
    'search',
    'searchString',
    'find',
  ]
  for (const alias of oldAliases) {
    test(`${alias} → old_string`, () => {
      const out = coerceFileEditInput({
        file_path: '/a.ts',
        [alias]: 'x',
        new_string: 'y',
      }) as Record<string, unknown>
      expect(out.old_string).toBe('x')
      expect(alias in out).toBe(false)
    })
  }

  const newAliases = [
    'newString',
    'new_str',
    'newStr',
    'new',
    'replace',
    'replacement',
    'replaceWith',
  ]
  for (const alias of newAliases) {
    test(`${alias} → new_string`, () => {
      const out = coerceFileEditInput({
        file_path: '/a.ts',
        old_string: 'x',
        [alias]: 'y',
      }) as Record<string, unknown>
      expect(out.new_string).toBe('y')
      expect(alias in out).toBe(false)
    })
  }

  for (const alias of ['replaceAll', 'all', 'global', 'replaceAllOccurrences']) {
    test(`${alias} → replace_all`, () => {
      const out = coerceFileEditInput({
        file_path: '/a.ts',
        old_string: 'x',
        new_string: 'y',
        [alias]: true,
      }) as Record<string, unknown>
      expect(out.replace_all).toBe(true)
      expect(alias in out).toBe(false)
    })
  }

  test('the full camelCase payload validates against the real schema', () => {
    const coerced = coerceFileEditInput({
      filePath: '/a.ts',
      oldString: 'x',
      newString: 'y',
      replaceAll: true,
    })
    const parsed = FileEditTool.inputSchema.safeParse(coerced)
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data).toEqual({
      file_path: '/a.ts',
      old_string: 'x',
      new_string: 'y',
      replace_all: true,
    })
  })

  test('the raw camelCase payload does NOT validate (proves the repair is needed)', () => {
    const parsed = FileEditTool.inputSchema.safeParse({
      filePath: '/a.ts',
      oldString: 'x',
      newString: 'y',
    })
    expect(parsed.success).toBe(false)
  })
})

describe('Write aliases map to canonical keys', () => {
  for (const alias of [
    'text',
    'contents',
    'file_text',
    'fileText',
    'body',
    'data',
    'source',
  ]) {
    test(`${alias} → content`, () => {
      const out = coerceFileWriteInput({
        file_path: '/a.ts',
        [alias]: 'hello',
      }) as Record<string, unknown>
      expect(out.content).toBe('hello')
      expect(alias in out).toBe(false)
    })
  }

  test('the full camelCase payload validates against the real schema', () => {
    const coerced = coerceFileWriteInput({ filePath: '/a.ts', text: 'hello' })
    const parsed = FileWriteTool.inputSchema.safeParse(coerced)
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data).toEqual({ file_path: '/a.ts', content: 'hello' })
  })
})

describe('the empty string is a legitimate value, not "absent"', () => {
  test('old_string:"" via an alias survives (new-file creation)', () => {
    const out = coerceFileEditInput({
      filePath: '/new.ts',
      oldString: '',
      newString: 'content',
    }) as Record<string, unknown>
    expect(out.old_string).toBe('')
    expect(out.file_path).toBe('/new.ts')
  })

  test('new_string:"" via an alias survives (region deletion)', () => {
    const out = coerceFileEditInput({
      file_path: '/a.ts',
      old_string: 'gone',
      newString: '',
    }) as Record<string, unknown>
    expect(out.new_string).toBe('')
  })

  test('content:"" via an alias survives (truncate to empty)', () => {
    const out = coerceFileWriteInput({
      file_path: '/a.ts',
      text: '',
    }) as Record<string, unknown>
    expect(out.content).toBe('')
  })
})

describe('never overrides, never guesses', () => {
  test('a present canonical key wins over an alias', () => {
    const out = coerceFileEditInput({
      file_path: '/canonical.ts',
      path: '/alias.ts',
      old_string: 'x',
      new_string: 'y',
    }) as Record<string, unknown>
    expect(out.file_path).toBe('/canonical.ts')
    // The now-redundant alias is removed so strictObject does not reject it.
    expect('path' in out).toBe(false)
  })

  test('two aliases with DIFFERENT values are left unresolved', () => {
    const out = coerceFileEditInput({
      filePath: '/one.ts',
      path: '/two.ts',
      old_string: 'x',
      new_string: 'y',
    }) as Record<string, unknown>
    // Refuses to pick — picking wrong could edit the wrong file.
    expect(out.file_path).toBeUndefined()
    // The aliases stay, so the validation error shows what was actually sent.
    expect(out.filePath).toBe('/one.ts')
    expect(out.path).toBe('/two.ts')
  })

  test('two aliases with the SAME value are harmless duplication', () => {
    const out = coerceFileEditInput({
      filePath: '/same.ts',
      path: '/same.ts',
      old_string: 'x',
      new_string: 'y',
    }) as Record<string, unknown>
    expect(out.file_path).toBe('/same.ts')
    expect('filePath' in out).toBe(false)
    expect('path' in out).toBe(false)
  })

  test('a wrongly-typed alias value is ignored', () => {
    const out = coerceFileEditInput({
      filePath: 42,
      old_string: 'x',
      new_string: 'y',
    }) as Record<string, unknown>
    expect(out.file_path).toBeUndefined()
    expect(out.filePath).toBe(42)
  })

  test('replace_all accepts the quoted forms semanticBoolean handles', () => {
    const out = coerceFileEditInput({
      file_path: '/a.ts',
      old_string: 'x',
      new_string: 'y',
      replaceAll: 'true',
    }) as Record<string, unknown>
    expect(out.replace_all).toBe('true')
    const parsed = FileEditTool.inputSchema.safeParse(out)
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.replace_all).toBe(true)
  })

  test('Edit does NOT accept a whole-file "content" as new_string', () => {
    // Confusing a partial replacement with a whole-file rewrite would silently
    // truncate the file, so this mapping is deliberately absent.
    const out = coerceFileEditInput({
      file_path: '/a.ts',
      old_string: 'x',
      content: 'entire new file',
    }) as Record<string, unknown>
    expect(out.new_string).toBeUndefined()
  })

  test('Write does NOT accept new_string as content', () => {
    const out = coerceFileWriteInput({
      file_path: '/a.ts',
      new_string: 'partial',
    }) as Record<string, unknown>
    expect(out.content).toBeUndefined()
  })
})
