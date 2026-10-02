import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles/globals.css'
import './overlay.css'
import { TooltipProvider } from '../components/ui'
import { initSettingsSync } from '../stores/settings'
import { App } from './App'

void initSettingsSync().finally(() => {
  createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </StrictMode>,
  )
})
