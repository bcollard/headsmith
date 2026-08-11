/* Service worker entrypoint: browser events in, applyRules out.
 *
 * Deliberately thin. Every decision -- which rules to emit, whether a
 * credential may be released, when to lock -- lives in src/core or
 * src/background, both of which are unit-tested without a browser. What is
 * left here is wiring, and wiring is what an e2e test is for.
 */

import { applyRules, clearSessionRules, referencedSecretIds, resetApplyState } from '../background/apply';
import {
  handleLockAlarm,
  isUnlocked,
  lock,
  LOCK_ALARM,
  noteActivity,
  pruneOrphans,
  unlock,
  vaultExists,
} from '../background/secrets';
import { CONFIG_KEY, loadAndMigrate, loadConfig, saveConfig } from '../background/store';
import { alarms, commands, onStorageChanged, runtime, session } from '../platform/chrome';

type Message =
  | { type: 'apply' }
  | { type: 'lock' }
  | { type: 'unlock'; passphrase: string }
  | { type: 'status' }
  | { type: 'prune' };

export default defineBackground(() => {
  /* Only the config key triggers a rebuild. The worker writes its own status
     into storage.local on every apply, so reacting to any change would loop:
     apply writes status, status change triggers apply. */
  onStorageChanged((changes, area) => {
    if (area === 'local' && CONFIG_KEY in changes) void applyRules();
  });

  alarms.onAlarm(async (alarm) => {
    if (alarm.name !== LOCK_ALARM) return;
    const config = await loadConfig();
    const result = await handleLockAlarm(config.settings);
    if (result.locked) {
      /* Locking has to remove the rules as well as the key. The credential was
         handed to the browser when the rule was created; forgetting how to
         decrypt it does not stop the browser from continuing to send it. */
      await clearSessionRules();
      await applyRules();
    }
  });

  commands.onCommand(async (command) => {
    if (command !== 'toggle-pause') return;
    const config = await loadConfig();
    // The storage listener above picks this up and rebuilds.
    await saveConfig({ ...config, paused: !config.paused });
  });

  runtime.onMessage((message, _sender, respond) => {
    void (async () => {
      const msg = message as Message;
      switch (msg?.type) {
        case 'apply':
          await applyRules();
          return respond({ ok: true });

        case 'lock':
          await lock();
          await clearSessionRules();
          await applyRules();
          return respond({ ok: true });

        case 'unlock': {
          const config = await loadConfig();
          const result = await unlock(msg.passphrase, config.settings);
          if (result.ok) await applyRules();
          return respond(result);
        }

        case 'status':
          return respond({
            ok: true,
            unlocked: await isUnlocked(),
            vaultExists: await vaultExists(),
            sessionStorage: session.available(),
          });

        case 'prune': {
          const removed = await pruneOrphans(await referencedSecretIds());
          return respond({ ok: true, removed });
        }

        default:
          return respond({ ok: false, error: 'unknown-message' });
      }
    })();
    return true; // response is asynchronous
  });

  async function boot(): Promise<void> {
    resetApplyState();
    const { config } = await loadAndMigrate();
    await noteActivity(config.settings);
    await applyRules();
  }

  runtime.onInstalled(() => void boot());

  /* A browser restart clears storage.session, so the vault is locked and the
     session rule set is empty by construction. Clearing it explicitly guards
     against a stale credential-bearing rule surviving an extension reload,
     which is not the same event. */
  runtime.onStartup(() => {
    void (async () => {
      await clearSessionRules();
      await boot();
    })();
  });

  void boot();
});
