import { cleanName } from './net/protocol';

/**
 * Pilot account rules, shared by the start menu (instant feedback) and the
 * server (which enforces them). A pilot name is unique: "Kerys" and "kerys"
 * are the same account.
 */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

/** Names that would pass for the game itself or its non-player ships. */
const RESERVED = ['pilote', 'système', 'systeme', 'serveur', 'admin', 'administrateur', 'moderateur', 'modérateur', 'nebula', 'nebula frontier', 'vous'];
const RESERVED_PREFIX = /^(garde|raider|marauder)[\s-]/;
/** Latin letters (accents included), digits, spaces and . _ ' - only: no look-alike letters from other alphabets, no symbols. */
const ALLOWED = /^[\p{Script=Latin}0-9][\p{Script=Latin}0-9 ._'-]*$/u;

export type NameCheck = { ok: true; name: string; key: string } | { ok: false; text: string };

/** The lookup key of a name: case and width folded, single spaces. */
export function nameKey(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** The account key of a name typed at login: cleaned exactly like at sign-up, so both find the same account. */
export function loginKey(raw: unknown): string {
  return nameKey(cleanName(raw));
}

export function checkAccountName(raw: unknown): NameCheck {
  // Never cut a long name: the pilot would sign up as a name they do not know.
  const name = cleanName(raw);
  if (name.length < 3 || name.length > 16) return { ok: false, text: 'Le pseudo doit faire de 3 à 16 caractères.' };
  if (!ALLOWED.test(name)) return { ok: false, text: 'Pseudo : lettres, chiffres, espaces et . _ \' - seulement.' };
  const key = nameKey(name);
  if (RESERVED.includes(key) || RESERVED_PREFIX.test(key)) return { ok: false, text: 'Ce pseudo est réservé : choisissez-en un autre.' };
  return { ok: true, name, key };
}

/** Null when the password is acceptable, else why not. */
export function checkPassword(password: unknown, name = ''): string | null {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) return `Le mot de passe doit faire au moins ${PASSWORD_MIN} caractères.`;
  if (password.length > PASSWORD_MAX) return `Le mot de passe doit faire au plus ${PASSWORD_MAX} caractères.`;
  if (name && nameKey(password) === nameKey(name)) return 'Le mot de passe ne doit pas être votre pseudo.';
  return null;
}
