import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../ui/styles/base.css';

/* One bundle serves both the action popup and the options page; the app
   switches layout on which surface it is rendered in. Filled in by slice 5. */

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <main className="hs-shell">
        <h1>Headsmith</h1>
        <p>Rule editor lands in slice 5.</p>
      </main>
    </StrictMode>,
  );
}
