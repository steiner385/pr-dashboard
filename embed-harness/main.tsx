import React from 'react';
import { createRoot } from 'react-dom/client';
// The REAL shipped artifacts — the built bundle + its .prdash-root-scoped CSS.
import { PrDashboard } from '../dist/embed/index.js';
import '../dist/embed/style.css';

createRoot(document.getElementById('embed-mount')!).render(
  <React.StrictMode>
    {/* hash router so we don't need a host-side path router; apiBase is same-origin
        (/api) and proxied to the running daemon by vite.config. */}
    <PrDashboard apiBase="/api" routerMode="hash" />
  </React.StrictMode>,
);
