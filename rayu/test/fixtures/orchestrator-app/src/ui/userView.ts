import type { User } from '../types/user'

export function renderUser(user: User): string {
  return user.id
}
