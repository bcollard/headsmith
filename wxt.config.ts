import { defineConfig } from 'wxt';
import react from '@vitejs/plugin-react';

/* Chrome only. There is deliberately no `-b firefox` target: the Firefox
   build of an extension like this needs blocking `webRequest`, which can
   observe every header on every request. A declarativeNetRequest-only
   extension hands rules to the browser and never sees a request at all,
   and that property is the product. See SECURITY.md. */
export default defineConfig({
  srcDir: 'src',
  outDir: 'dist',
  outDirTemplate: '{{browser}}',
  // Icons are generated into src/public by scripts/generate-icons.mjs rather
  // than committed as hand-made binaries, so the shipped artifact stays
  // entirely source-derived and the reproducible-build claim holds down to the
  // toolbar icon. Stated explicitly because the default is root-relative.
  publicDir: 'src/public',
  vite: () => ({
    plugins: [react()],
    build: {
      // Readable output is a security feature here: the whole point of
      // publishing with provenance is that a reviewer can diff the artifact
      // against the source. A 400KB minified chunk defeats that.
      minify: false,
      sourcemap: false,
      // Vite ships a modulepreload polyfill that calls fetch() on chunk URLs.
      // It is same-origin and harmless, but it is also the only fetch() in the
      // bundle, and an allowlist entry excusing it would be a permanent hole
      // in the "no network primitives, none, anywhere" check. Chrome has
      // supported modulepreload since 66 and the manifest requires 110, so the
      // polyfill is dead weight. Dropping it lets the egress guard assert zero
      // rather than zero-plus-an-exception.
      modulePreload: { polyfill: false },
    },
  }),
  manifest: {
    /* Name and description come from _locales so the Web Store listing title
       and summary are translatable without a code change.
     *
     * The name is the strongest keyword signal the store has, and "Headsmith"
     * alone is a word nobody searches for. It now carries what the extension
     * *is* as well as what it is called -- once, without repeating the terms
     * in the summary, since a term repeated across name, summary and
     * description is keyword spam and grounds for suspension rather than
     * merely rejection. */
    name: '__MSG_extName__',
    /* Plain, deliberately. short_name is a fallback identity rather than
       listing copy and gains nothing from translation. */
    short_name: 'Headsmith',
    description: '__MSG_extDescription__',
    default_locale: 'en',
    // declarativeNetRequest with modifyHeaders landed well before this, but
    // storage.session (which is where the vault key lives, and the reason
    // credentials never touch disk) requires 102, and setBadgeTextColor 110.
    minimum_chrome_version: '110',
    permissions: [
      // Rules are handed to the browser declaratively; the extension never
      // observes a request. This is the only header-modification permission
      // requested, and there is deliberately no `webRequest`.
      'declarativeNetRequest',
      // Profiles, settings and vault ciphertext in storage.local; the derived
      // vault key in storage.session, which is cleared when the browser exits.
      'storage',
      // Drives vault auto-lock. Without it the vault still locks on restart,
      // but not after an idle timeout.
      'alarms',
    ],
    /* No host access at install.
     *
     * Header rules only apply to hosts the user names, and they name them at
     * runtime -- so the hosts are requested at runtime too, when a profile
     * first names one. The install prompt is then silent about hosts instead
     * of claiming the extension will "read and change all your data on all
     * websites", which was both alarming and untrue: declarativeNetRequest
     * cannot read anything.
     *
     * Broad access remains available and is requested explicitly for profiles
     * scoped only by URL substring or regex, which really can match any host.
     * That is the honest boundary; see src/core/origins.ts. */
    host_permissions: [],
    optional_host_permissions: ['*://*/*'],
    action: {
      default_title: 'Headsmith',
      default_popup: '/app.html',
      default_icon: {
        16: '/icons/icon16.png',
        32: '/icons/icon32.png',
        48: '/icons/icon48.png',
        128: '/icons/icon128.png',
      },
    },
    options_page: '/app.html',
    icons: {
      16: '/icons/icon16.png',
      32: '/icons/icon32.png',
      48: '/icons/icon48.png',
      128: '/icons/icon128.png',
    },
    commands: {
      'toggle-pause': {
        suggested_key: { default: 'Alt+Shift+H' },
        description: '__MSG_cmdTogglePause__',
      },
    },
  },
});
