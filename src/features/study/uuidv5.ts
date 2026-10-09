/**
 * UUID version 5 on the phone, without a dependency: the id of a card_states row.
 *
 * A card_states id is not random. It is derived from the user and the card (DECISIONS.md D17):
 *
 *   id = UUIDv5(CARD_STATE_ID_NAMESPACE, `${user_id}:${card_id}`)
 *
 * so two offline phones of the same user pick the same id for a card and converge on one row, and the
 * server refuses any other id (CHECK card_states_id_derived, 23514). UUIDv5 is RFC 9562 section 5.5:
 * SHA-1 over the 16 namespace bytes followed by the UTF-8 bytes of the name, keep the first 16 bytes,
 * then set the version (5) and variant bits.
 *
 * Why our own SHA-1: it must be synchronous (the id is needed inside the answer's write transaction),
 * run on Hermes without Node's crypto, and be testable in Jest. expo-crypto's digest is native and
 * async, and the `uuid` package is ESM-only with a browser build that relies on `unescape()`. 80 lines
 * of plain integer arithmetic avoid all of that; the tests check it against node:crypto on thousands
 * of random names and against the worked example Postgres' uuid_generate_v5 produces.
 */
import { CARD_STATE_ID_NAMESPACE } from '@/db/constants';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a UUID in the canonical hyphenated form (any version, either case). */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** The UTF-8 bytes of a string (lone surrogates become U+FFFD, as TextEncoder does). */
export function utf8Bytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      } else {
        code = 0xfffd;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return Uint8Array.from(out);
}

/** SHA-1 (FIPS 180-4) of `bytes`: 20 bytes. Only for UUIDv5 here, never for security. */
export function sha1(bytes: Uint8Array): Uint8Array {
  const length = bytes.length;
  // Message + 0x80 + zero padding + 64-bit big-endian bit length, rounded up to 64-byte blocks.
  const padded = ((length + 9 + 63) >> 6) << 6;
  const message = new Uint8Array(padded);
  message.set(bytes);
  message[length] = 0x80;
  // The bit length as 64 bits: the high word only matters above 512 MiB, which never happens here,
  // but it is written correctly anyway.
  const bitsHigh = Math.floor(length / 0x20000000);
  const bitsLow = (length * 8) >>> 0;
  message[padded - 8] = (bitsHigh >>> 24) & 0xff;
  message[padded - 7] = (bitsHigh >>> 16) & 0xff;
  message[padded - 6] = (bitsHigh >>> 8) & 0xff;
  message[padded - 5] = bitsHigh & 0xff;
  message[padded - 4] = (bitsLow >>> 24) & 0xff;
  message[padded - 3] = (bitsLow >>> 16) & 0xff;
  message[padded - 2] = (bitsLow >>> 8) & 0xff;
  message[padded - 1] = bitsLow & 0xff;

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let offset = 0; offset < padded; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      const at = offset + i * 4;
      w[i] = (message[at] << 24) | (message[at + 1] << 16) | (message[at + 2] << 8) | message[at + 3];
    }
    for (let t = 16; t < 80; t += 1) {
      const x = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16];
      w[t] = (x << 1) | (x >>> 31);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let t = 0; t < 80; t += 1) {
      let f: number;
      let k: number;
      if (t < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (t < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (t < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[t]) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = temp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  const digest = new Uint8Array(20);
  [h0, h1, h2, h3, h4].forEach((h, index) => {
    digest[index * 4] = h >>> 24;
    digest[index * 4 + 1] = (h >>> 16) & 0xff;
    digest[index * 4 + 2] = (h >>> 8) & 0xff;
    digest[index * 4 + 3] = h & 0xff;
  });
  return digest;
}

/** RFC 9562 UUID version 5 of `name` (UTF-8) in `namespace`, lowercase and hyphenated. */
export function uuidV5(name: string, namespace: string): string {
  if (!isUuid(namespace)) throw new RangeError(`Not a UUID namespace: ${namespace}`);
  const hex = namespace.replace(/-/g, '');
  const nameBytes = utf8Bytes(name);
  const input = new Uint8Array(16 + nameBytes.length);
  for (let i = 0; i < 16; i += 1) input[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  input.set(nameBytes, 16);
  const bytes = sha1(input).subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 9562 variant
  let out = '';
  for (let i = 0; i < 16; i += 1) out += (bytes[i] + 0x100).toString(16).slice(1);
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}-${out.slice(20)}`;
}

/**
 * The card_states id of `userId`'s state for `cardId`. Both ids are written in lowercase, the form
 * Postgres' uuid::text produces (the server's CHECK hashes that text). Throws a RangeError for
 * something that is not a UUID, so a bad id never reaches the upload queue.
 */
export function cardStateId(userId: string, cardId: string): string {
  if (!isUuid(userId)) throw new RangeError(`Not a user id: ${String(userId)}`);
  if (!isUuid(cardId)) throw new RangeError(`Not a card id: ${String(cardId)}`);
  return uuidV5(`${userId.toLowerCase()}:${cardId.toLowerCase()}`, CARD_STATE_ID_NAMESPACE);
}
