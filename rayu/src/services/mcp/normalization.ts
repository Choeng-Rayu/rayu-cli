/**
 * Pure utility functions for MCP name normalization.
 * This file has no dependencies to avoid circular imports.
 */

/**
 * Normalize server names to be compatible with the API pattern ^[a-zA-Z0-9_-]{1,64}$
 * Replaces any invalid characters (including dots and spaces) with underscores.
 */
export function normalizeNameForMCP(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}
