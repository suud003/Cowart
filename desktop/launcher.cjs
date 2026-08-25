'use strict'

const { app, dialog } = require('electron')

void import('./main.mjs').catch((error) => {
  const message = String(error?.stack || error?.message || error)
  console.error('Yogurt AI Desktop failed to start:', message)
  try {
    dialog.showErrorBox('Yogurt AI Desktop failed to start', message)
  } finally {
    app.exit(1)
  }
})
