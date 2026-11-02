/**
 * Commands reach `eval` byte for byte. shell-quote's double-quote mode used to rewrite
 * `!` to `\!` in any command holding both ' and ", so `node -e "a!==b"` (and jq/awk
 * filters with !=) failed to parse. Run through the engine's real shell executor.
 */
import { describe, expect, test } from 'bun:test'
import { exec as runShell } from '../src/utils/Shell.ts'
import { quoteShellCommand, singleQuoteForEval } from '../src/utils/bash/shellQuoting.ts'

async function run(command: string): Promise<{ code: number; out: string }> {
  const handle = await runShell(command, new AbortController().signal, 'bash', { timeout: 30_000 })
  const result = await handle.result
  return { code: result.code, out: `${result.stdout}${result.stderr}` }
}

describe('quoting a command for eval', () => {
  test('single quotes inside are closed and reopened, nothing else is touched', () => {
    expect(singleQuoteForEval(`a!=b "q" $X \`c\` \\n`)).toBe(`'a!=b "q" $X \`c\` \\n'`)
    expect(singleQuoteForEval(`it's`)).toBe(`'it'"'"'s'`)
    expect(quoteShellCommand('echo hi', true)).toBe(`'echo hi' \\< /dev/null`)
    expect(quoteShellCommand('echo hi', false)).toBe(`'echo hi'`)
  })

  test('a node one-liner with !== and both quote kinds parses and runs', async () => {
    const result = await run(`node -e "const a=1,b=2;if(a!==b){console.log('differs');process.exit(0)}process.exit(1)"`)
    expect(result).toEqual({ code: 0, out: 'differs\n' })
  })

  test('a jq-style filter keeps its !=', async () => {
    const result = await run(`echo '1 2' | awk '{ if ($1 != $2) print "unequal" }'`)
    expect(result.out).toBe('unequal\n')
  })

  test('variables, backticks, backslashes and pipes behave as in a plain shell', async () => {
    expect((await run(`X=5; echo "$X" '$X' | cat`)).out).toBe('5 $X\n')
    expect((await run('echo "`echo inner`"')).out).toBe('inner\n')
    expect((await run(`printf '%s\\n' "a\\\\b"`)).out).toBe('a\\b\n')
    expect((await run(`echo it\\'s "fine"`)).out).toBe("it's fine\n")
  })

  test('the command is not left reading the terminal: its stdin is /dev/null', async () => {
    expect((await run(`cat`)).out).toBe('')
    expect((await run(`echo a; cat`)).out).toBe('a\n')
  })

  test('heredocs and multiline strings are unchanged', async () => {
    expect((await run(`cat <<'EOF'\nline!=1\nEOF`)).out).toBe('line!=1\n')
    expect((await run(`echo "a\nb!c"`)).out).toBe('a\nb!c\n')
  })
})
