/**
 * @jest-environment node
 *
 * The card_states id derivation documented next to CARD_STATE_ID_NAMESPACE, checked against an
 * independent UUIDv5 implementation (node:crypto). The same worked example is asserted against
 * Postgres' uuid_generate_v5 — the function the server's CHECK uses — in
 * supabase/tests/06_study_engine.test.sql, so the client and the server agree on the rule.
 */
/// <reference types="node" />
import { describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';

import { CARD_STATE_ID_NAMESPACE } from '../constants';

/** RFC 9562 UUID version 5 (SHA-1 of namespace bytes + UTF-8 name). */
function uuidV5(name: string, namespace: string): string {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const bytes = createHash('sha1').update(namespaceBytes).update(name, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC variant
  const hex = bytes.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

describe('CARD_STATE_ID_NAMESPACE', () => {
  it('is the namespace the migration enforces', () => {
    expect(CARD_STATE_ID_NAMESPACE).toBe('c4cae30d-9668-4354-adc3-2ee1071432e7');
  });

  it('derives the documented worked example', () => {
    expect(
      uuidV5('11111111-1111-4111-8111-111111111111:70000000-0000-4000-8000-000000000001', CARD_STATE_ID_NAMESPACE),
    ).toBe('57743c5a-f966-538b-bccb-0919027b21c9');
  });
});
