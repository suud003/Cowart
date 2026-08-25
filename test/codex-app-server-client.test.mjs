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
    spawnProcess(command, args, options) {
      assert.equal(command, 'codex')
      assert.deepEqual(args, ['app-server', '--listen', 'stdio://'])
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

test('App Server client rejects non-stdio listeners and non-text turn input', () => {
  assert.throws(
    () => new CodexAppServerClient({ args: ['app-server', '--listen', 'ws://127.0.0.1:4500'] }),
    /only supports the local stdio/
  )
  assert.throws(() => normalizeUserInput([{ type: 'localImage', path: '/secret' }]), /text input only/)
  assert.equal(CODEX_APP_SERVER_PROTOCOL.websocket, false)
})
