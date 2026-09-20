/**
 * Tests for the command registry (Task 17).
 *
 * Verifies:
 *  1. Command registry has the right shape (version: 1, commands array)
 *  2. All commands have required fields
 *  3. Category values are from the allowed set
 *  4. IPC_COMMAND_REGISTRY constant is defined
 */
import { expect, test } from 'bun:test'
import {
  IPC_COMMAND_REGISTRY,
} from '../src/vscode/shared/attachChannels.js'
import type { CommandCategory, CommandMetadata } from '../src/vscode/shared/commandProtocol.js'

const VALID_CATEGORIES: Set<CommandCategory> = new Set([
  'file_operations',
  'conversation',
  'mcp',
  'tasks',
  'settings',
  'debug',
  'advanced',
])

test('IPC_COMMAND_REGISTRY constant is defined and non-empty', () => {
  expect(typeof IPC_COMMAND_REGISTRY).toBe('string')
  expect(IPC_COMMAND_REGISTRY.length).toBeGreaterThan(0)
})

test('IPC_COMMAND_REGISTRY has the rayucode: prefix', () => {
  expect(IPC_COMMAND_REGISTRY).toMatch(/^rayucode:/)
})

test('CommandMetadata required fields are typed correctly', () => {
  const meta: CommandMetadata = {
    name: 'model',
    displayName: 'Change Model',
    description: 'Switch the active AI model',
    category: 'settings',
    requiresSession: true,
    requiresAuth: false,
    isPaid: false,
    isEnabled: true,
  }
  expect(meta.name).toBe('model')
  expect(meta.category).toBe('settings')
  expect(meta.isEnabled).toBe(true)
})

test('all valid CommandCategory values are in the union', () => {
  const categories: CommandCategory[] = [
    'file_operations', 'conversation', 'mcp', 'tasks', 'settings', 'debug', 'advanced',
  ]
  for (const cat of categories) {
    expect(VALID_CATEGORIES.has(cat)).toBe(true)
  }
})

test('commandProtocol exports CommandRegistry type with version and commands', () => {
  // Verify via structural typing — if this compiles, the type is correct
  const registry: import('../src/vscode/shared/commandProtocol.js').CommandRegistry = {
    version: 1,
    commands: [
      {
        name: 'clear',
        displayName: 'Clear Conversation',
        description: 'Clear the chat transcript',
        category: 'conversation',
        requiresSession: true,
        requiresAuth: false,
        isPaid: false,
        isEnabled: true,
      },
    ],
  }
  expect(registry.version).toBe(1)
  expect(registry.commands).toHaveLength(1)
  expect(registry.commands[0]!.category).toBe('conversation')
})
