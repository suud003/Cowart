import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'

import {
  CODEX_APP_SERVER_PROTOCOL,
  CodexAppServerClient,
  normalizeUserInput
} from '../desktop/codex-app-server-client.mjs'

function fakeSidecar(onMessage) {
  const child = new EventEmitter()
  child.pid = 4242
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.messages = []
  child.kill = () => {
    queueMicrotask(() => child.emit('exit', 0, 'SIGTERM'))
    return true
  }
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const message = JSON.parse(String(chunk).trim())
      child.messages.push(message)
      queueMicrotask(() => onMessage?.(message, child))
      callback()
    },
    final(callback) {
      queueMicrotask(() => child.emit('exit', 0, null))
      callback()
    }
  })
  child.send = (message) => child.stdout.write(`${JSON.stringify(message)}\n`)
  return child
}

test('App Server client performs initialize/initialized and stdio JSONL requests', async () => {
  let child
  const client = new CodexAppServerClient({
    cwd: '/workspace',
    command: 'node',
    commandPrefixArgs: ['/tools/codex.js'],
    spawnProcess(command, args, options) {
      assert.equal(command, 'node')
      assert.deepEqual(args, ['/tools/codex.js', 'app-server', '--listen', 'stdio://'])
      assert.equal(options.shell, false)
      child = fakeSidecar((message, process) => {
        if (message.method === 'initialize') {
          process.send({ id: message.id, result: { platformFamily: 'windows' } })
        } else if (message.method === 'thread/start') {
          process.send({ id: message.id, result: { thread: { id: 'thr_1' } } })
        }
      })
      return child
    }
  })

  await client.start()
  const result = await client.startThread({ cwd: '/workspace' })

  assert.equal(result.thread.id, 'thr_1')
  assert.equal(child.messages[0].method, 'initialize')
  assert.equal(child.messages[0].params.capabilities.experimentalApi, false)
  assert.equal(child.messages[1].method, 'initialized')
  assert.equal(child.messages[2].method, 'thread/start')
  assert.equal(client.state.transport, 'stdio')
  await client.stop()
})

test('thread start uses a cold-start timeout longer than ordinary requests', async () => {
  const client = new CodexAppServerClient({
    requestTimeoutMs: 5,
    spawnProcess() {
      return fakeSidecar((message, process) => {
        if (message.method === 'initialize') {
          process.send({ id: message.id, result: {} })
        } else if (message.method === 'thread/start') {
          setTimeout(() => {
            process.send({ id: message.id, result: { thread: { id: 'thr_cold' } } })
          }, 25)
        }
      })
    }
  })

  await client.start()
  assert.equal((await client.startThread()).thread.id, 'thr_cold')
  assert.equal(CODEX_APP_SERVER_PROTOCOL.threadLifecycleTimeoutMs, 120_000)
  await client.stop()
})

test('App Server client exposes only fixed managed-account login requests', async () => {
  let child
  const client = new CodexAppServerClient({
    spawnProcess() {
      child = fakeSidecar((message, process) => {
        if (message.method === 'initialize') {
          process.send({ id: message.id, result: {} })
        } else if (message.method === 'account/read') {
          process.send({
            id: message.id,
            result: { account: null, requiresOpenaiAuth: true }
          })
        } else if (message.method === 'account/login/start') {
          process.send({
            id: message.id,
            result: {
              type: 'chatgpt',
              loginId: 'login_1',
              authUrl: 'https://auth.openai.com/codex/authorize'
            }
          })
        } else if (message.method === 'account/login/cancel') {
          process.send({ id: message.id, result: {} })
        }
      })
      return child
    }
  })

  assert.deepEqual(await client.readAccount(), {
    account: null,
    requiresOpenaiAuth: true
  })
  const login = await client.startChatgptLogin()
  assert.equal(login.loginId, 'login_1')
  assert.deepEqual(
    child.messages.find((message) => message.method === 'account/login/start')?.params,
    {
      type: 'chatgpt',
      useHostedLoginSuccessPage: true,
      appBrand: 'chatgpt'
    }
  )
  await client.cancelLogin('login_1')
  assert.deepEqual(
    child.messages.find((message) => message.method === 'account/login/cancel')?.params,
    { loginId: 'login_1' }
  )
  assert.throws(
    () => client.startChatgptLogin({ appBrand: 'untrusted-host' }),
    /appBrand/
  )
  await client.stop()
})

test('App Server client streams notifications and answers only known approvals', async () => {
  let child
  const client = new CodexAppServerClient({
    spawnProcess() {
      child = fakeSidecar((message, process) => {
        if (message.method === 'initialize') process.send({ id: message.id, result: {} })
      })
      return child
    }
  })
  await client.start()

  const notificationPromise = once(client, 'notification')
  child.send({ method: 'turn/started', params: { threadId: 'thr_1', turn: { id: 'turn_1' } } })
  const [notification] = await notificationPromise
  assert.equal(notification.method, 'turn/started')

  const approvalPromise = once(client, 'serverRequest')
  child.send({
    id: 'approval-1',
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thr_1', turnId: 'turn_1', command: 'npm test' }
  })
  const [approval] = await approvalPromise
  assert.equal(approval.requestId, 'approval-1')
  await client.respondToApproval('approval-1', 'accept')
  assert.deepEqual(child.messages.at(-1), {
    id: 'approval-1',
    result: { decision: 'accept' }
  })
  await assert.rejects(
    client.respondToApproval('missing', 'accept'),
    /No pending command or file approval/
  )
  await client.stop()
})

test('App Server client rejects unsupported server requests and clears server-resolved requests', async () => {
  let child
  const client = new CodexAppServerClient({
    spawnProcess() {
      child = fakeSidecar((message, process) => {
        if (message.method === 'initialize') process.send({ id: message.id, result: {} })
      })
      return child
    }
  })
  await client.start()

  const unsupportedPromise = once(client, 'serverRequest')
  child.send({ id: 'unsupported-1', method: 'item/permissions/requestApproval', params: {} })
  await unsupportedPromise
  assert.equal(client.pendingServerRequests.length, 1)
  await client.rejectServerRequest('unsupported-1', {
    code: -32601,
    message: 'Unsupported request.'
  })
  assert.deepEqual(child.messages.at(-1), {
    id: 'unsupported-1',
    error: { code: -32601, message: 'Unsupported request.' }
  })
  assert.equal(client.pendingServerRequests.length, 0)

  const approvalPromise = once(client, 'serverRequest')
  child.send({ id: 'approval-2', method: 'item/fileChange/requestApproval', params: {} })
  await approvalPromise
  assert.equal(client.pendingServerRequests.length, 1)
  const resolvedPromise = once(client, 'notification')
  child.send({
    method: 'serverRequest/resolved',
    params: { threadId: 'thr_1', requestId: 'approval-2' }
  })
  await resolvedPromise
  assert.equal(client.pendingServerRequests.length, 0)
  await client.stop()
})

test('a stale sidecar exit cannot tear down a successfully restarted client', async () => {
  let spawnCount = 0
  let staleChild
  let activeChild
  const client = new CodexAppServerClient({
    spawnProcess() {
      spawnCount += 1
      const child = fakeSidecar((message, process) => {
        if (message.method === 'initialize') {
          if (spawnCount === 1) {
            process.send({ id: message.id, error: { code: -32602, message: 'Bad init.' } })
          } else {
            process.send({ id: message.id, result: {} })
          }
        } else if (message.method === 'thread/start') {
          process.send({ id: message.id, result: { thread: { id: 'thr_restarted' } } })
        }
      })
      child.pid = spawnCount
      if (spawnCount === 1) {
        staleChild = child
        child.kill = () => true
      } else {
        activeChild = child
      }
      return child
    }
  })

  await assert.rejects(client.start(), /Bad init/)
  await client.start()
  staleChild.emit('exit', 1, null)
  await Promise.resolve()

  assert.equal(client.state.status, 'ready')
  assert.equal(client.state.pid, activeChild.pid)
  assert.equal((await client.startThread()).thread.id, 'thr_restarted')
  await client.stop()
})

test('App Server client rejects non-stdio listeners and non-text turn input', () => {
  assert.throws(
    () => new CodexAppServerClient({ args: ['app-server', '--listen', 'ws://127.0.0.1:4500'] }),
    /only supports the local stdio/
  )
  assert.throws(() => normalizeUserInput([{ type: 'localImage', path: '/secret' }]), /text input only/)
  assert.equal(CODEX_APP_SERVER_PROTOCOL.websocket, false)
})
