/**
 * Bundled by test/vscodeZodLocales.test.ts, the way the extension host bundles zod.
 *
 * Imports zod through both entries host code uses (`zod/v4` in src/protocol, `zod` in
 * formatActivityForVSCode.ts), fails one parse, and prints what a user would see.
 */
import { z } from 'zod/v4'
import { z as zRoot } from 'zod'

const result = z.object({ name: z.string() }).safeParse({ name: 42 })
const rootResult = zRoot.number().safeParse('not a number')

process.stdout.write(
  JSON.stringify({
    locales: Object.keys(z.locales).sort(),
    rootLocales: Object.keys(zRoot.locales).sort(),
    message: result.success ? null : (result.error.issues[0]?.message ?? null),
    rootMessage: rootResult.success ? null : (rootResult.error.issues[0]?.message ?? null),
  }),
)
