// The fixture's integration check: the UI must render the name the API returns.
// Named `.check.ts`, not `.test.ts`, so the repository's own `bun test` never runs it
// against the unfinished fixture.
import { fetchUser } from '../src/api/userApi'
import { renderUser } from '../src/ui/userView'

const rendered = renderUser(fetchUser('u1'))
if (rendered !== 'Ada Lovelace') {
  console.error(`consistency check failed: the UI rendered ${JSON.stringify(rendered)} for the API's user`)
  process.exit(1)
}
console.log('consistency check passed')
