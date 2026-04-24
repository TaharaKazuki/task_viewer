import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './index.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root element not found in index.html');

createRoot(rootEl, {
  onUncaughtError: (err) => console.error('[task-viewer/web] uncaught:', err),
  onCaughtError: (err) => console.error('[task-viewer/web] caught:', err),
}).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
