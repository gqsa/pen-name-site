import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// B2.2 — the admin shell entry point. Everything below the shell (the tracker
// in B2.3, the editors in B2.5–B2.7, the announcements panel in B2.9) mounts
// inside App.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
