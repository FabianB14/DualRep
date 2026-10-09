/**
 * @jest-environment node
 *
 * The on-device UUIDv5 against an independent reference (node:crypto's SHA-1) and against the worked
 * example the server's CHECK (Postgres uuid_generate_v5) is tested with in supabase/tests.
 */
/// <reference types="node" />
import { describe, expect, it } from '@jest/globals';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { CARD_STATE_ID_NAMESPACE } from '@/db/constants';

import { cardStateId, isUuid, sha1, utf8Bytes, uuidV5 } from '../uuidv5';

/** RFC 9562 UUIDv5 with node:crypto (the reference). */
function referenceV5(name: string, namespace: string): string {
  const bytes = createHash('sha1')
    .update(Buffer.from(namespace.replace(/-/g, ''), 'hex'))
    .update(name, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe('sha1', () => {
  it('matches the FIPS 180 test vectors', () => {
    expect(hex(sha1(utf8Bytes('')))).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(hex(sha1(utf8Bytes('abc')))).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(hex(sha1(utf8Bytes('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe(
      '84983e441c3bd26ebaae4aa1f95129e5e54670f1',
    );
  });

  it('matches node:crypto for every length around the 64-byte block edges, and random input', () => {
    for (let length = 0; length <= 200; length += 1) {
      const bytes = new Uint8Array(randomBytes(length));
      expect(hex(sha1(bytes))).toBe(createHash('sha1').update(bytes).digest('hex'));
    }
    const big = new Uint8Array(randomBytes(100_000));
    expect(hex(sha1(big))).toBe(createHash('sha1').update(big).digest('hex'));
  });
});

describe('utf8Bytes', () => {
  it('encodes like Node (ASCII, 2-, 3- and 4-byte characters, lone surrogates)', () => {
    for (const text of ['', 'abc:123', 'é', 'Café', '€', '日本語', '😀 ok', 'a\ud800b', '\udc00']) {
      expect(hex(utf8Bytes(text))).toBe(Buffer.from(text, 'utf8').toString('hex'));
    }
  });
});

describe('uuidV5', () => {
  it('reproduces the documented card_states worked example', () => {
    expect(
      uuidV5('11111111-1111-4111-8111-111111111111:70000000-0000-4000-8000-000000000001', CARD_STATE_ID_NAMESPACE),
    ).toBe('57743c5a-f966-538b-bccb-0919027b21c9');
  });

  it('matches the RFC 9562 example (DNS namespace, www.example.com)', () => {
    expect(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    );
  });

  it('agrees with node:crypto on 2000 random user:card names and on non-ASCII names', () => {
    for (let i = 0; i < 2000; i += 1) {
      const name = `${randomUUID()}:${randomUUID()}`;
      expect(uuidV5(name, CARD_STATE_ID_NAMESPACE)).toBe(referenceV5(name, CARD_STATE_ID_NAMESPACE));
    }
    for (const name of ['Café', '日本語:😀', '', 'x'.repeat(300)]) {
      expect(uuidV5(name, CARD_STATE_ID_NAMESPACE)).toBe(referenceV5(name, CARD_STATE_ID_NAMESPACE));
    }
  });

  it('accepts an upper-case namespace and refuses a malformed one', () => {
    expect(uuidV5('a', CARD_STATE_ID_NAMESPACE.toUpperCase())).toBe(uuidV5('a', CARD_STATE_ID_NAMESPACE));
    expect(() => uuidV5('a', 'not-a-uuid')).toThrow(RangeError);
    expect(() => uuidV5('a', 'c4cae30d96684354adc32ee1071432e7')).toThrow(RangeError);
  });

  it('always yields a version 5, RFC-variant UUID', () => {
    const id = uuidV5('anything', CARD_STATE_ID_NAMESPACE);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('cardStateId', () => {
  const USER = '11111111-1111-4111-8111-111111111111';
  const CARD = '70000000-0000-4000-8000-000000000001';

  it('is the derived id the server checks, whatever the case of the inputs', () => {
    expect(cardStateId(USER, CARD)).toBe('57743c5a-f966-538b-bccb-0919027b21c9');
    expect(cardStateId(USER.toUpperCase(), CARD.toUpperCase())).toBe('57743c5a-f966-538b-bccb-0919027b21c9');
  });

  it('differs per user and per card', () => {
    const other = '22222222-2222-4222-8222-222222222222';
    expect(cardStateId(other, CARD)).not.toBe(cardStateId(USER, CARD));
    expect(cardStateId(USER, other)).not.toBe(cardStateId(USER, CARD));
  });

  it('refuses anything that is not a UUID', () => {
    expect(() => cardStateId('', CARD)).toThrow(RangeError);
    expect(() => cardStateId(USER, 'card-1')).toThrow(RangeError);
    expect(() => cardStateId(`${USER} `, CARD)).toThrow(RangeError);
  });

  it('isUuid recognises the canonical form only', () => {
    expect(isUuid(USER)).toBe(true);
    expect(isUuid(USER.toUpperCase())).toBe(true);
    expect(isUuid(USER.replace(/-/g, ''))).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid(42)).toBe(false);
  });
});
