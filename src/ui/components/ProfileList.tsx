/* The profile sidebar.
 *
 * A profile's enabled checkbox and the global pause are different things and
 * are kept visually distinct: pausing stops everything without touching what
 * is configured, which is what you want when a site breaks and you need to
 * know whether Headsmith is the cause.
 */

import { blankProfile, PROFILE_COLORS, type Config, type Profile } from '../../core/schema';
import { hasSensitiveContent } from '../../core/sensitivity';
import { Button } from './primitives';

export function ProfileList({
  config,
  blockedIds,
  onSelect,
  onChange,
}: {
  config: Config;
  blockedIds: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onChange: (fn: (config: Config) => Config) => void;
}) {
  const setProfile = (id: string, patch: Partial<Profile>) =>
    onChange((c) => ({
      ...c,
      profiles: c.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }));

  const add = () =>
    onChange((c) => {
      const profile = blankProfile(c.profiles.length + 1);
      return { ...c, profiles: [...c.profiles, profile], activeProfileId: profile.id };
    });

  const remove = (id: string) =>
    onChange((c) => {
      const profiles = c.profiles.filter((p) => p.id !== id);
      if (profiles.length === 0) {
        const fresh = blankProfile(1);
        return { ...c, profiles: [fresh], activeProfileId: fresh.id };
      }
      return {
        ...c,
        profiles,
        activeProfileId: c.activeProfileId === id ? profiles[0]!.id : c.activeProfileId,
      };
    });

  const duplicate = (id: string) =>
    onChange((c) => {
      const source = c.profiles.find((p) => p.id === id);
      if (!source) return c;
      const copy = {
        ...blankProfile(c.profiles.length + 1),
        ...structuredClone(source),
        id: blankProfile(1).id,
        name: `${source.name} copy`,
      };
      /* Credential references are deliberately dropped rather than shared. A
         copied profile pointing at the same secret means deleting one profile
         can silently disarm the other, and the surprise lands on whichever
         one you were not looking at. */
      copy.requestHeaders = copy.requestHeaders.map((h) =>
        h.secretId ? { ...h, secretId: null, value: '' } : h,
      );
      copy.responseHeaders = copy.responseHeaders.map((h) =>
        h.secretId ? { ...h, secretId: null, value: '' } : h,
      );
      return { ...c, profiles: [...c.profiles, copy], activeProfileId: copy.id };
    });

  return (
    <nav className="hs-profiles" aria-label="Profiles">
      <ul>
        {config.profiles.map((profile) => {
          const active = profile.id === config.activeProfileId;
          const blocked = blockedIds.has(profile.id);
          const credential = hasSensitiveContent(profile);

          return (
            <li key={profile.id} className={active ? 'hs-profile hs-active' : 'hs-profile'}>
              <button
                type="button"
                className="hs-profile-open"
                onClick={() => onSelect(profile.id)}
                aria-current={active}
              >
                <span className="hs-swatch" style={{ background: profile.color }} aria-hidden="true" />
                <span className="hs-profile-name">{profile.name}</span>
                {credential ? (
                  <span className="hs-badge" title="Sends a credential">
                    🔒
                  </span>
                ) : null}
                {blocked ? (
                  <span className="hs-badge hs-badge-warn" title="Needs attention">
                    !
                  </span>
                ) : null}
              </button>
              <input
                type="checkbox"
                checked={profile.enabled}
                onChange={(e) => setProfile(profile.id, { enabled: e.target.checked })}
                title={profile.enabled ? 'Enabled' : 'Disabled'}
                aria-label={`Enable ${profile.name}`}
              />
            </li>
          );
        })}
      </ul>

      <div className="hs-profile-actions">
        <Button onClick={add}>New profile</Button>
        <Button variant="ghost" onClick={() => duplicate(config.activeProfileId)}>
          Duplicate
        </Button>
        <Button variant="ghost" onClick={() => remove(config.activeProfileId)}>
          Delete
        </Button>
      </div>
    </nav>
  );
}

export function ProfileHeader({
  profile,
  onChange,
  showColours = true,
}: {
  profile: Profile;
  onChange: (patch: Partial<Profile>) => void;
  showColours?: boolean;
}) {
  return (
    <div className="hs-profile-header">
      <input
        className="hs-input hs-title-input"
        value={profile.name}
        aria-label="Profile name"
        onChange={(e) => onChange({ name: e.target.value })}
      />
      {showColours ? (
        <div className="hs-colors" role="group" aria-label="Profile colour">
          {PROFILE_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={`hs-color${profile.color === color ? ' hs-color-on' : ''}`}
              style={{ background: color }}
              title={color}
              aria-label={color}
              onClick={() => onChange({ color })}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* The popup's whole profile control: rename in place, and switch if there is
 * more than one.
 *
 * Everything structural -- creating, duplicating, deleting, recolouring --
 * lives in the full editor. In a 420px popup those are five more controls
 * competing with the two things anyone opened it for, and each is a decision
 * you make once and then live with, not something you reach for mid-debug.
 * A single default profile you can rename is the whole model until you need
 * more. */
export function ProfileBar({
  config,
  onSelect,
  onRename,
}: {
  config: Config;
  onSelect: (id: string) => void;
  onRename: (name: string) => void;
}) {
  const active = config.profiles.find((p) => p.id === config.activeProfileId) ?? config.profiles[0]!;

  return (
    <div className="hs-profile-bar">
      <span className="hs-swatch" style={{ background: active.color }} aria-hidden="true" />
      <input
        className="hs-input hs-title-input"
        value={active.name}
        aria-label="Profile name"
        onChange={(e) => onRename(e.target.value)}
      />
      {config.profiles.length > 1 ? (
        <select
          className="hs-input hs-select"
          value={active.id}
          aria-label="Switch profile"
          onChange={(e) => onSelect(e.target.value)}
        >
          {config.profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}
