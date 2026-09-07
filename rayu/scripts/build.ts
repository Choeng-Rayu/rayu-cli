// Rayu-CLI build: bundle the CLI entrypoint with Bun.
//
// Every knob — the `--define` map (including MACRO.*, RAYU_FEATURES.* and
// RAYU_BAKED_BUILD_CONFIG), the stub aliases, the external native/OTEL modules
// and the enabled feature list — lives in scripts/bundleConfig.ts, because the
// library bundle the Rayucode extension consumes must use the identical
// configuration or it will not link. See that file for why.
import { sharedBuildOptions } from './bundleConfig.ts'

const result = await Bun.build({
  ...sharedBuildOptions(),
  entrypoints: ['src/entrypoints/cli.tsx'],
  outdir: 'dist',
  banner: '#!/usr/bin/env node',
  naming: 'rayu.js',
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
console.log('Built dist/rayu.js')
