import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { installTrustedClipboardPermissionPolicy } from '../desktop/clipboard-permission.mjs'

const APP_URL = 'file:///C:/Program%20Files/Yogurt%20AI/resources/app.asar/dist/index.html'

function createSessionHarness() {
  let checkHandler = null
  let requestHandler = null
  const calls = []
  const electronSession = {
    setPermissionCheckHandler(handler) {
      calls.push(['check', handler])
      checkHandler = handler
    },
    setPermissionRequestHandler(handler) {
      calls.push(['request', handler])
      requestHandler = handler
    }
  }

  return {
    calls,
    electronSession,
    get checkHandler() { return checkHandler },
    get requestHandler() { return requestHandler }
  }
}

function requestPermission(handler, webContents, permission, details) {
  return new Promise((resolve, reject) => {
    let callbackCount = 0
    handler(webContents, permission, (allowed) => {
      callbackCount += 1
      if (callbackCount > 1) {
        reject(new Error('Electron permission callback was invoked more than once.'))
        return
      }
      resolve(allowed)
    }, details)
  })
}

function permissionDetails(overrides = {}) {
  return {
    isMainFrame: true,
    requestingUrl: APP_URL,
    ...overrides
  }
}

test('desktop permits sanitized clipboard writes only for its trusted top-level document', async () => {
  const harness = createSessionHarness()
  const trusted = { id: 1, getURL: () => APP_URL }
  installTrustedClipboardPermissionPolicy({
    electronSession: harness.electronSession,
    getTrustedWebContents: () => trusted
  })

  assert.equal(typeof harness.checkHandler, 'function')
  assert.equal(typeof harness.requestHandler, 'function')
  assert.equal(
    harness.checkHandler(
      trusted,
      'clipboard-sanitized-write',
      new URL(APP_URL).origin,
      permissionDetails()
    ),
    true
  )
  assert.equal(
    await requestPermission(
      harness.requestHandler,
      trusted,
      'clipboard-sanitized-write',
      permissionDetails()
    ),
    true
  )
})

test('desktop clipboard permission policy rejects reads, foreign renderers, child frames, and URL mismatches', async () => {
  const harness = createSessionHarness()
  const trusted = { id: 1, getURL: () => APP_URL }
  const foreign = { id: 2, getURL: () => APP_URL }
  const foreignWithSpoofedId = { id: 1, getURL: () => APP_URL }
  installTrustedClipboardPermissionPolicy({
    electronSession: harness.electronSession,
    getTrustedWebContents: () => trusted
  })

  const rejected = [
    {
      name: 'clipboard read',
      webContents: trusted,
      permission: 'clipboard-read',
      details: permissionDetails()
    },
    {
      name: 'foreign renderer',
      webContents: foreign,
      permission: 'clipboard-sanitized-write',
      details: permissionDetails()
    },
    {
      name: 'different renderer object reusing the trusted id',
      webContents: foreignWithSpoofedId,
      permission: 'clipboard-sanitized-write',
      details: permissionDetails()
    },
    {
      name: 'child frame',
      webContents: trusted,
      permission: 'clipboard-sanitized-write',
      details: permissionDetails({ isMainFrame: false })
    },
    {
      name: 'different path on the same origin',
      webContents: trusted,
      permission: 'clipboard-sanitized-write',
      details: permissionDetails({ requestingUrl: 'file:///C:/tmp/attacker.html' })
    },
    {
      name: 'missing request details',
      webContents: trusted,
      permission: 'clipboard-sanitized-write',
      details: undefined
    }
  ]

  for (const fixture of rejected) {
    assert.equal(
      harness.checkHandler(
        fixture.webContents,
        fixture.permission,
        fixture.details?.requestingUrl || '',
        fixture.details
      ),
      false,
      `${fixture.name} must fail the synchronous permission check`
    )
    assert.equal(
      await requestPermission(
        harness.requestHandler,
        fixture.webContents,
        fixture.permission,
        fixture.details
      ),
      false,
      `${fixture.name} must fail the permission request`
    )
  }
})

test('desktop main installs both Electron permission gates instead of a blanket callback', async () => {
  const source = await readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8')

  assert.match(source, /installTrustedClipboardPermissionPolicy\(\{[\s\S]*electronSession:\s*session\.defaultSession/)
  assert.match(source, /getTrustedWebContents:\s*trustedWebContents/)
  assert.doesNotMatch(
    source,
    /setPermissionRequestHandler\([^\n]*callback\(false\)/,
    'main must not replace the scoped check/request policy with a blanket denial'
  )
  assert.doesNotMatch(
    source,
    /disposePermissionPolicy/,
    'main must retain the restrictive permission policy until the Electron process exits'
  )
})
