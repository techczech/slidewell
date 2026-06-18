import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import { installMock } from './sw-mock'

// In Electron, window.sw is injected synchronously by the preload script.
// In a plain browser (dev preview / Vite HMR), install the mock before React mounts.
if (typeof (window as unknown as { sw?: unknown }).sw === 'undefined') {
  installMock()
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
