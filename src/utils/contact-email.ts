/**
 * Contact addresses and the "no email yet" placeholder.
 *
 * Revercue stores a contact email per user, but AuthAction does not always
 * release one, and `users.email` is `UNIQUE NOT NULL`. A user without an email
 * is therefore stored with a reserved, non-deliverable address derived from
 * their own user id:
 *
 *   usr_<hash>@no-email.revercue.invalid
 *
 * `revercue.invalid` can never be delivered to (RFC 2606 reserves `.invalid`),
 * so a placeholder must never be shown to the user, sent to, or treated as a
 * real address. `contactEmail()` returns '' for it so onboarding still asks for
 * an email and `/api/auth/me` still reports `email_missing: true`.
 */

export const PLACEHOLDER_EMAIL_DOMAIN = 'no-email.revercue.invalid';
export const PLACEHOLDER_EMAIL_SUFFIX = `@${PLACEHOLDER_EMAIL_DOMAIN}`;

/** SQL LIKE pattern matching every placeholder address. */
export const PLACEHOLDER_EMAIL_LIKE = `%${PLACEHOLDER_EMAIL_SUFFIX}`;

/** Unique per user id, because `users.email` is unique. */
export function placeholderEmailFor(userId: string): string {
  return `${userId}${PLACEHOLDER_EMAIL_SUFFIX}`;
}

export function isPlaceholderEmail(email: unknown): boolean {
  return String(email ?? '')
    .trim()
    .toLowerCase()
    .endsWith(PLACEHOLDER_EMAIL_SUFFIX);
}

/** The address the user actually supplied, or '' when none is stored yet. */
export function contactEmail(email: unknown): string {
  if (isPlaceholderEmail(email)) return '';
  return String(email ?? '').trim();
}
