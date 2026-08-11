import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../ui/App';
import '../../ui/styles/base.css';
import '../../ui/styles/app.css';

/* One bundle serves both the action popup and the options page; App decides
   its layout from the viewport, since Chrome does not tell a page which of the
   two it is. */

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
