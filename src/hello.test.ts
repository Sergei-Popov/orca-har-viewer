import { assert, test } from 'orca/testing'
import { helloArrived } from './hello'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function fakeTheme() {
  const handlers: Array<() => void> = []
  let disposed = 0
  return {
    onTheme: (handler: () => void) => {
      handlers.push(handler)
      return { dispose: () => void disposed++ }
    },
    fire: () => handlers.forEach((handler) => handler()),
    disposed: () => disposed,
  }
}

test('the strings wait for Orca\'s hello, not the system language', async () => {
  const theme = fakeTheme()
  let arrived = false
  const done = helloArrived({ themed: () => false, onTheme: theme.onTheme, timeoutMs: 10_000 }).then(() => {
    arrived = true
  })
  await tick()
  await tick()
  assert.equal(arrived, false)
  theme.fire()
  await done
  assert.equal(arrived, true)
  assert.equal(theme.disposed(), 1)
})

test('hello that came before the editor loaded needs no wait', async () => {
  const theme = fakeTheme()
  await helloArrived({ themed: () => true, onTheme: theme.onTheme })
  assert.equal(theme.disposed(), 0)
})

test('outside Orca, and when hello brings no theme, it stops waiting', async () => {
  await helloArrived({ themed: () => false })
  const theme = fakeTheme()
  const started = Date.now()
  await helloArrived({ themed: () => false, onTheme: theme.onTheme, timeoutMs: 20 })
  assert.ok(Date.now() - started >= 15)
  assert.equal(theme.disposed(), 1)
})

test('a theme event fired while subscribing still counts', async () => {
  let disposed = 0
  await helloArrived({
    themed: () => false,
    onTheme: (handler) => {
      handler()
      return { dispose: () => void disposed++ }
    },
    timeoutMs: 10_000,
  })
  assert.equal(disposed, 1)
})
