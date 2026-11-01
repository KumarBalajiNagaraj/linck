import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import './index.css';
import { LIVE } from './auth/api.js';
import { startSession, watchSession } from './auth/auth.js';
import { LiveApp } from './auth/LiveApp.js';
import { router } from './router.js';

const el = document.getElementById('root');
if (!el) throw new Error('Root element missing');

// Live (VITE_API_URL set): ask who is signed in before anything mounts, once,
// outside React so StrictMode's double effects cannot ask twice. The demo
// mounts the router straight away, exactly as it always has.
if (LIVE) {
  void startSession();
  watchSession();
}

createRoot(el).render(<StrictMode>{LIVE ? <LiveApp /> : <RouterProvider router={router} />}</StrictMode>);
