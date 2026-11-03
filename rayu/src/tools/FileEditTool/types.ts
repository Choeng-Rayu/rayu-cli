import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'

// The input schema with optional replace_all
const inputSchema = lazySchema(() =>
  z.strictObject({
    file_path: z.string().describe('The absolute path to the file to modify'),
    old_string: z.string().describe('The text to replace'),
    new_string: z
      .string()
      .describe(
        'The text to replace it with (must be different from old_string)',
      ),
    replace_all: semanticBoolean(
      z.boolean().default(false).optional(),
    ).describe('Replace all occurrences of old_string (default false)'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

// Parsed output — what call() receives. z.output not z.input: with
// semanticBoolean the input side is unknown (preprocess accepts anything).
export type FileEditInput = z.output<InputSchema>

// Individual edit without file_path
export type EditInput = Omit<FileEditInput, 'file_path'>

// Runtime version where replace_all is always defined
export type FileEdit = {
  old_string: string
  new_string: string
  replace_all: boolean
}

export const hunkSchema = lazySchema(() =>
  z.object({
    oldStart: z.number(),
    oldLines: z.number(),
    newStart: z.number(),
    newLines: z.number(),
    lines: z.array(z.string()),
  }),
)

export const gitDiffSchema = lazySchema(() =>
  z.object({
    filename: z.string(),
    status: z.enum(['modified', 'added']),
    additions: z.number(),
    deletions: z.number(),
    changes: z.number(),
    patch: z.string(),
    repository: z
      .string()
      .nullable()
      .optional()
      .describe('GitHub owner/repo when available'),
  }),
)

// Output schema for FileEditTool
const outputSchema = lazySchema(() =>
  z.object({
    filePath: z.string().describe('The file path that was edited'),
    oldString: z.string().describe('The original string that was replaced'),
    newString: z.string().describe('The new string that replaced it'),
    // Deliberately the FIRST LINE, not the whole file. This field used to carry
    // `originalFile` — the entire pre-edit contents — and since a tool result is
    // serialized into the transcript (`tool_use_result`), every edited file was
    // written to disk in full. Measured on one real 28 MB session: 16.6 MB of it
    // was this field alone, 17.82 MB across 362 Edit calls, because the average
    // edited file is ~50 KB and nothing downstream reads the bytes. The only
    // consumer was language/shebang detection, which needs the first line.
    //
    // `.optional()` as well as `.nullable()` is load-bearing, not defensive
    // padding: a transcript written BEFORE this change holds `originalFile` and
    // no `firstLine`, and `UserToolSuccessMessage` validates a resumed record
    // against this schema and renders NOTHING when it fails. Requiring the key
    // therefore made every pre-change Edit result vanish from a resumed session
    // — the exact old-format breakage that guard exists to catch. Absent means
    // "old record", and the renderer treats it like null.
    firstLine: z
      .string()
      .nullable()
      .optional()
      .describe(
        'First line of the file before this edit, for language/shebang detection',
      ),
    structuredPatch: z
      .array(hunkSchema())
      .describe('Diff patch showing the changes'),
    userModified: z
      .boolean()
      .describe('Whether the user modified the proposed changes'),
    replaceAll: z.boolean().describe('Whether all occurrences were replaced'),
    gitDiff: gitDiffSchema().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type FileEditOutput = z.infer<OutputSchema>

export { inputSchema, outputSchema }
