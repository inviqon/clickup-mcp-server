import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll } from 'vitest'

export const mswServer = setupServer()

export function useMsw() {
  beforeAll(() => mswServer.listen({ onUnhandledRequest: 'error' }))
  afterEach(() => mswServer.resetHandlers())
  afterAll(() => mswServer.close())
}
