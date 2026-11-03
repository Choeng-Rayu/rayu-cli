import { describe, expect, test } from 'bun:test'

import {
  applyAgentModelTarget,
  getConfigurableAgentTypes,
  matchingAgentModelTargets,
} from '../src/utils/model/agentModelTargets.js'

describe('agent model target suggestions', () => {
  test('offers built-in and runtime-defined agents without duplicates', () => {
    expect(getConfigurableAgentTypes(['planner', 'Builder', 'explore'])).toEqual([
      'general-purpose',
      'Explore',
      'planner',
      'Builder',
    ])
  })

  test('matches the primary command and compatibility aliases', () => {
    expect(matchingAgentModelTargets('/subagent_models gen', 20)).toEqual([
      'general-purpose',
    ])
    expect(matchingAgentModelTargets('/subagent_model Exp', 19)).toEqual([
      'Explore',
    ])
    expect(matchingAgentModelTargets('/model_subagent pla', 19)).toEqual([
      'planner',
    ])
  })

  test('shows every target after the command and includes custom agents', () => {
    const input = '/subagent_models '
    expect(matchingAgentModelTargets(input, input.length, ['reviewer'])).toEqual([
      'general-purpose',
      'Explore',
      'planner',
      'reviewer',
    ])
  })

  test('does not activate in later arguments or unrelated commands', () => {
    const laterArgument = '/subagent_models planner show'
    expect(
      matchingAgentModelTargets(laterArgument, laterArgument.length),
    ).toEqual([])
    expect(matchingAgentModelTargets('/model planner', 14)).toEqual([])
  })

  test('replaces the partial target and leaves a space for the model picker command', () => {
    const input = '/subagent_models gen'
    expect(applyAgentModelTarget(input, input.length, 'general-purpose')).toEqual({
      input: '/subagent_models general-purpose ',
      cursorOffset: 33,
    })
  })
})
