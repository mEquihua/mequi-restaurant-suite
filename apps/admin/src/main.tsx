import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import './styles.css';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js'));
}

createRoot(document.getElementById('root')!).render(<App />);
