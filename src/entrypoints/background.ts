/* Service worker entrypoint.
 *
 * Deliberately thin: this file wires browser events to the apply loop and
 * nothing else. The decisions -- which rules to emit, whether a credential may
 * be released -- live in src/core, which is pure and unit-tested without a
 * browser. See CLAUDE.md.
 *
 * Filled in by slice 3. */

export default defineBackground(() => {
  // Placeholder: rule compilation and application land in src/background.
});
