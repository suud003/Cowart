import React from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/barlow-condensed/latin-700.css'
import '@fontsource/barlow-condensed/latin-800.css'
import '@fontsource/ibm-plex-mono/latin-400.css'
import '@fontsource/ibm-plex-mono/latin-500.css'
import '@excalidraw/excalidraw/index.css'
import './nativeExcalidraw.css'

window.EXCALIDRAW_ASSET_PATH = new URL('./excalidraw-assets/', document.baseURI).href

const { default: App } = await import('./NativeExcalidrawApp.jsx')

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
