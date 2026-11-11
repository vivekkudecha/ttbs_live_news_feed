import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { applyUiScale, savedUiScale } from './lib/ui-scale'

applyUiScale(savedUiScale()) // before the first paint, so the page doesn't resize after load

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
