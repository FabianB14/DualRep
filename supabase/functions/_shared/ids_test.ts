import { assert, assertEquals, assertNotEquals, assertRejects } from 'jsr:@std/assert@1.0.13';
import {
  cardId,
  cardsJobId,
  chunkId,
  draftTopicId,
  embedJobId,
  isUuid,
  outlineJobId,
  SERVER_ID_NAMESPACE,
  sourceFileId,
  uuidv5,
} from './ids.ts';

const SOURCE = '70000000-0000-4000-8000-000000000001';

Deno.test('uuidv5 reproduces the documented card_states example (RFC 9562 v5)', async () => {
  // docs/DATA_MODEL.md / the initial migration: uuid_generate_v5(namespace, '<user>:<card>').
  const got = await uuidv5(
    '11111111-1111-4111-8111-111111111111:70000000-0000-4000-8000-000000000001',
    'c4cae30d-9668-4354-adc3-2ee1071432e7',
  );
  assertEquals(got, '57743c5a-f966-538b-bccb-0919027b21c9');
});

Deno.test('uuidv5 sets the version and variant bits and refuses a malformed namespace', async () => {
  const id = await uuidv5('anything', SERVER_ID_NAMESPACE);
  assert(isUuid(id));
  assertEquals(id[14], '5');
  assert('89ab'.includes(id[19]));
  await assertRejects(() => uuidv5('x', 'not-a-uuid'), RangeError);
});

Deno.test('derived ids are stable and distinct per thing they name', async () => {
  assertEquals(await chunkId(SOURCE, 3, 0), await chunkId(SOURCE, 3, 0));
  const ids = [
    await chunkId(SOURCE, 3, 0),
    await chunkId(SOURCE, 3, 1),
    await chunkId(SOURCE, 4, 0),
    await chunkId(SOURCE, null, 0),
    await sourceFileId(SOURCE, 1),
    await outlineJobId(SOURCE),
    await embedJobId(SOURCE),
    await cardsJobId(SOURCE, SOURCE, 0),
    await cardsJobId(SOURCE, SOURCE, 1),
    await draftTopicId(SOURCE, 't1'),
    await cardId(SOURCE, 'c1'),
  ];
  assertEquals(new Set(ids).size, ids.length);
  assertNotEquals(await outlineJobId(SOURCE), await outlineJobId('70000000-0000-4000-8000-000000000002'));
});

Deno.test('isUuid accepts the lowercase canonical form only', () => {
  assert(isUuid(SOURCE));
  assert(isUuid(SERVER_ID_NAMESPACE));
  assert(!isUuid(SERVER_ID_NAMESPACE.toUpperCase()));
  assert(!isUuid('70000000000040008000000000000001'));
  assert(!isUuid(42));
});
