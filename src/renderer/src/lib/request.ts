/**
 * Identity for one asynchronous read.
 *
 * Views begin a request with the values that select its target (repository,
 * file, side or tab) and apply the result only while its token is still
 * current. Beginning another request, or invalidating the guard, rejects every
 * earlier token so a late response, error or `finally` cannot touch the newer
 * editor state.
 */
export interface RequestToken {
  readonly id: number
  readonly key: string
}

export interface RequestGuard {
  begin(key: string): RequestToken
  isCurrent(token: RequestToken): boolean
  invalidate(): void
}

export function createRequestGuard(): RequestGuard {
  let generation = 0
  let activeKey: string | null = null
  return {
    begin(key) {
      generation += 1
      activeKey = key
      return { id: generation, key }
    },
    isCurrent(token) {
      return token.id === generation && token.key === activeKey
    },
    invalidate() {
      generation += 1
      activeKey = null
    }
  }
}
