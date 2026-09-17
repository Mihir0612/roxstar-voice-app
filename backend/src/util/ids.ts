import { randomInt, randomUUID } from 'node:crypto';

export const newId = (): string => randomUUID();

// Crockford-style alphabet: no I, L, O, U -- a room code gets read aloud and
// typed on a phone, so visually ambiguous characters are removed.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Short, human-typable room join code. */
export function newRoomCode(length = 6): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Uniform random pick (D16).
 *
 * crypto.randomInt, not Math.random: the elimination draw decides the winner,
 * and a predictable PRNG would make the outcome guessable by any client that
 * observed a few spins.
 */
export function pickRandom<T>(items: readonly T[]): T {
  if (items.length === 0) throw new Error('pickRandom called with an empty list');
  return items[randomInt(0, items.length)] as T;
}
