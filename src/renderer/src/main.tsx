import { createRoot } from 'react-dom/client'
import './styles/app.css'
import './styles/views.css'
import { App } from './App'

const container = document.getElementById('root')
if (!container) throw new Error('Root element missing')

createRoot(container).render(<App />)
