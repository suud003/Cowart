'use strict'

const { app } = require('electron')

void import('./probe-electron-clipboard.mjs').catch((error) => {
  console.error(error?.stack || error?.message || error)
  app.exit(1)
})
