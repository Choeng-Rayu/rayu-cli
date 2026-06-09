// Deterministic project stack detection from manifest files.
//
// Pure + synchronous: no network, no model calls, no side effects. Reads only
// well-known manifest/lockfile names from `cwd`. Used to make PA-AGENT (and the
// swarm) respect an existing codebase instead of redesigning it.
//
// This replaces the ad-hoc, model-driven manifest reading scattered across
// init.ts / init-verifiers.ts with one reusable, testable function.
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

export interface DetectedStack {
  /** Detected languages, e.g. ['typescript'] or ['go']. */
  languages: string[]
  /** Detected frameworks/libraries, e.g. ['nextjs','react'] or ['fastapi']. */
  frameworks: string[]
  /** Package/dependency manager, e.g. 'bun' | 'pnpm' | 'npm' | 'cargo' | 'pip'. */
  packageManager?: string
  /** Detected database/datastore when inferable, e.g. 'postgres' | 'mongodb'. */
  database?: string
  /** True when any recognised manifest was found (i.e. NOT greenfield). */
  hasExistingStack: boolean
  /** Manifest/lockfile names that were found (relative to cwd). */
  manifests: string[]
}

// dependency name (substring match) -> framework label
const JS_FRAMEWORKS: Array<[RegExp, string]> = [
  [/^next$/, 'nextjs'],
  [/^nuxt$/, 'nuxt'],
  [/^@angular\/core$/, 'angular'],
  [/^svelte$/, 'svelte'],
  [/^@sveltejs\/kit$/, 'sveltekit'],
  [/^vue$/, 'vue'],
  [/^react$/, 'react'],
  [/^react-native$/, 'react-native'],
  [/^expo$/, 'expo'],
  [/^@nestjs\/core$/, 'nestjs'],
  [/^express$/, 'express'],
  [/^fastify$/, 'fastify'],
  [/^koa$/, 'koa'],
  [/^@hapi\/hapi$/, 'hapi'],
  [/^hono$/, 'hono'],
  [/^@remix-run\//, 'remix'],
  [/^astro$/, 'astro'],
]

// dependency name -> database label
const JS_DATABASES: Array<[RegExp, string]> = [
  [/^pg$|^postgres$|^@prisma\/client$/, 'postgres'],
  [/^mysql2?$/, 'mysql'],
  [/^mongodb$|^mongoose$/, 'mongodb'],
  [/^better-sqlite3$|^sqlite3$/, 'sqlite'],
  [/^redis$|^ioredis$/, 'redis'],
]

function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function parseJsonSafe(text: string | null): Record<string, unknown> | null {
  if (!text) return null
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}

function detectPackageManager(cwd: string): string | undefined {
  // Order matters: most specific lockfile wins.
  if (existsSync(join(cwd, 'bun.lockb')) || existsSync(join(cwd, 'bun.lock')))
    return 'bun'
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(cwd, 'package-lock.json'))) return 'npm'
  if (existsSync(join(cwd, 'Cargo.lock'))) return 'cargo'
  if (existsSync(join(cwd, 'poetry.lock'))) return 'poetry'
  if (existsSync(join(cwd, 'Pipfile.lock'))) return 'pipenv'
  if (existsSync(join(cwd, 'go.sum'))) return 'go'
  return undefined
}

/** Infer a database from docker-compose image names + prisma/drizzle config. */
function detectDatabaseFromInfra(cwd: string): string | undefined {
  for (const f of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml']) {
    const text = readFileSafe(join(cwd, f))
    if (!text) continue
    if (/postgres|pgvector/i.test(text)) return 'postgres'
    if (/mysql|mariadb/i.test(text)) return 'mysql'
    if (/mongo/i.test(text)) return 'mongodb'
    if (/redis/i.test(text)) return 'redis'
  }
  const prisma = readFileSafe(join(cwd, 'prisma', 'schema.prisma'))
  if (prisma) {
    const m = prisma.match(/provider\s*=\s*"(\w+)"/)
    if (m) {
      const p = m[1].toLowerCase()
      if (p === 'postgresql') return 'postgres'
      if (['mysql', 'sqlite', 'mongodb'].includes(p)) return p
    }
  }
  return undefined
}

function uniq(arr: string[]): string[] {
  return [...new Set(arr)]
}

/**
 * Detect the project's stack by reading manifest files under `cwd`.
 * Deterministic and dependency-free.
 */
export function detectStack(cwd: string): DetectedStack {
  const languages: string[] = []
  const frameworks: string[] = []
  const manifests: string[] = []
  let database: string | undefined

  // --- JavaScript / TypeScript ---
  const pkgText = readFileSafe(join(cwd, 'package.json'))
  if (pkgText !== null) {
    manifests.push('package.json')
    const pkg = parseJsonSafe(pkgText)
    const deps: Record<string, unknown> = {
      ...((pkg?.dependencies as Record<string, unknown>) ?? {}),
      ...((pkg?.devDependencies as Record<string, unknown>) ?? {}),
    }
    const depNames = Object.keys(deps)
    const isTs =
      existsSync(join(cwd, 'tsconfig.json')) || depNames.includes('typescript')
    languages.push(isTs ? 'typescript' : 'javascript')
    for (const name of depNames) {
      for (const [re, label] of JS_FRAMEWORKS) {
        if (re.test(name)) frameworks.push(label)
      }
      for (const [re, label] of JS_DATABASES) {
        if (re.test(name) && !database) database = label
      }
    }
    if (depNames.includes('drizzle-orm') && !database) database = 'sql (drizzle)'
  } else if (existsSync(join(cwd, 'tsconfig.json'))) {
    manifests.push('tsconfig.json')
    languages.push('typescript')
  }

  // --- Go ---
  const goMod = readFileSafe(join(cwd, 'go.mod'))
  if (goMod !== null) {
    manifests.push('go.mod')
    languages.push('go')
    if (/gin-gonic\/gin/.test(goMod)) frameworks.push('gin')
    if (/labstack\/echo/.test(goMod)) frameworks.push('echo')
    if (/gofiber\/fiber/.test(goMod)) frameworks.push('fiber')
    if (/go-chi\/chi/.test(goMod)) frameworks.push('chi')
  }

  // --- Rust ---
  const cargo = readFileSafe(join(cwd, 'Cargo.toml'))
  if (cargo !== null) {
    manifests.push('Cargo.toml')
    languages.push('rust')
    if (/\bactix-web\b/.test(cargo)) frameworks.push('actix-web')
    if (/\baxum\b/.test(cargo)) frameworks.push('axum')
    if (/\brocket\b/.test(cargo)) frameworks.push('rocket')
    if (/\bwarp\b/.test(cargo)) frameworks.push('warp')
  }

  // --- Python ---
  const pyproject = readFileSafe(join(cwd, 'pyproject.toml'))
  const requirements = readFileSafe(join(cwd, 'requirements.txt'))
  if (pyproject !== null || requirements !== null) {
    manifests.push(pyproject !== null ? 'pyproject.toml' : 'requirements.txt')
    languages.push('python')
    const pyText = `${pyproject ?? ''}\n${requirements ?? ''}`
    if (/\bdjango\b/i.test(pyText)) frameworks.push('django')
    if (/\bflask\b/i.test(pyText)) frameworks.push('flask')
    if (/\bfastapi\b/i.test(pyText)) frameworks.push('fastapi')
  }

  // --- Java / Kotlin ---
  if (existsSync(join(cwd, 'pom.xml'))) {
    manifests.push('pom.xml')
    languages.push('java')
    const pom = readFileSafe(join(cwd, 'pom.xml'))
    if (pom && /spring-boot|springframework/.test(pom)) frameworks.push('spring')
  }
  for (const g of ['build.gradle', 'build.gradle.kts']) {
    if (existsSync(join(cwd, g))) {
      manifests.push(g)
      languages.push(g.endsWith('.kts') ? 'kotlin' : 'java')
      const gradle = readFileSafe(join(cwd, g))
      if (gradle && /spring-boot|springframework/.test(gradle))
        frameworks.push('spring')
    }
  }

  // --- PHP ---
  const composer = readFileSafe(join(cwd, 'composer.json'))
  if (composer !== null) {
    manifests.push('composer.json')
    languages.push('php')
    if (/laravel\/framework/.test(composer)) frameworks.push('laravel')
    if (/symfony\//.test(composer)) frameworks.push('symfony')
  }

  // --- Ruby ---
  const gemfile = readFileSafe(join(cwd, 'Gemfile'))
  if (gemfile !== null) {
    manifests.push('Gemfile')
    languages.push('ruby')
    if (/\brails\b/.test(gemfile)) frameworks.push('rails')
    if (/\bsinatra\b/.test(gemfile)) frameworks.push('sinatra')
  }

  if (!database) database = detectDatabaseFromInfra(cwd)
  const packageManager = detectPackageManager(cwd)

  return {
    languages: uniq(languages),
    frameworks: uniq(frameworks),
    ...(packageManager ? { packageManager } : {}),
    ...(database ? { database } : {}),
    hasExistingStack: manifests.length > 0,
    manifests: uniq(manifests),
  }
}

/** One-line human summary of a detected stack (for prompts/logs). */
export function summarizeStack(s: DetectedStack): string {
  if (!s.hasExistingStack) return 'no existing stack detected (greenfield)'
  const parts: string[] = []
  if (s.languages.length) parts.push(s.languages.join('/'))
  if (s.frameworks.length) parts.push(s.frameworks.join('+'))
  if (s.packageManager) parts.push(`pm:${s.packageManager}`)
  if (s.database) parts.push(`db:${s.database}`)
  return parts.join(', ')
}
