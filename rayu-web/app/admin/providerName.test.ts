import { nameLeaksProvider } from './providerName'

// A model's Name is customer-facing (the CLI shows it), while the provider is an
// internal commercial detail. This warning is what stops "GLM-5.2 (Ollama Cloud)"
// reaching users again — so it has to fire on the real cases and stay quiet on
// legitimate names, since a noisy warning gets ignored.

describe('nameLeaksProvider', () => {
  it('flags a name that names the upstream provider', () => {
    expect(nameLeaksProvider('GLM-5.2 (Ollama Cloud)', 'rayu-ollama')).toBe(true)
    expect(nameLeaksProvider('Kimi K2.7 (Ollama Cloud)', 'rayu-ollama')).toBe(true)
    expect(nameLeaksProvider('Claude Sonnet 4.6 on Bedrock', 'bedrock')).toBe(true)
    // Case and punctuation must not hide it.
    expect(nameLeaksProvider('GLM-5.2 [OLLAMA]', 'rayu-ollama')).toBe(true)
  })

  it('stays quiet on names that only describe the model', () => {
    expect(nameLeaksProvider('GLM-5.2', 'rayu-ollama')).toBe(false)
    expect(nameLeaksProvider('Claude Sonnet 4.6', 'bedrock')).toBe(false)
    expect(nameLeaksProvider('MiniMax M3 (1M context)', 'rayu-ollama')).toBe(false)
    expect(nameLeaksProvider('', 'rayu-ollama')).toBe(false)
  })

  it('ignores the operator\'s own name, which identifies nothing', () => {
    // Every hosted provider slug may contain "rayu"; matching on it would flag
    // every name and train admins to ignore the warning.
    expect(nameLeaksProvider('Rayu Turbo', 'rayu-ollama')).toBe(false)
  })

  it('ignores short slug fragments that would collide with real words', () => {
    // A 3-letter provider slug ("aws") is too generic to match words inside a
    // model name without false positives.
    expect(nameLeaksProvider('Claws v2', 'aws')).toBe(false)
  })

  it('matches a model name that is exactly the provider', () => {
    expect(nameLeaksProvider('deepseek', 'deepseek')).toBe(true)
  })
})
