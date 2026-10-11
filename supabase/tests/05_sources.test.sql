-- sources, source_files and source_chunks: files and chunks take owner_id/group_id from their
-- source (whatever the client sends) and follow the source when it changes group or the group is
-- deleted; source_chunks are read-only to clients and readable only by the owner and group members.
begin;
create extension if not exists pgtap with schema extensions;
select plan(32);

-- Runs one write and returns how many rows it changed. RLS hides other people's rows from UPDATE
-- and DELETE (0 rows, no error), so that is how "cannot modify" is asserted.
create function pg_temp.affected(statement text) returns bigint
language plpgsql as $$
declare
  n bigint;
begin
  execute statement;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Olive owns groups G (with Mia) and G2 (alone); Xena is an outsider.
insert into auth.users (id, email) values
  ('10000000-0000-4000-8000-000000000001', 'olive@example.com'),
  ('10000000-0000-4000-8000-000000000002', 'mia@example.com'),
  ('10000000-0000-4000-8000-000000000003', 'xena@example.com');
insert into public.groups (id, owner_id, name) values
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'G'),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'G2');
insert into public.group_members (group_id, user_id, role)
values ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'member');

-- Olive's private source and a file ---------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000001", "role": "authenticated"}';

select lives_ok(
  $$insert into public.sources (id, owner_id, kind, title)
    values ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'notes', 'Lecture 1')
    on conflict (id) do update set id = excluded.id, owner_id = excluded.owner_id, kind = excluded.kind,
      title = excluded.title$$,
  'PUT: the owner creates a source'
);
select lives_ok(
  $$insert into public.source_files (id, source_id, owner_id, group_id, storage_path, page)
    values ('41000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001',
            '10000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000001',
            '10000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000001/p1.jpg', 1)
    on conflict (id) do update set id = excluded.id, source_id = excluded.source_id, owner_id = excluded.owner_id,
      group_id = excluded.group_id, storage_path = excluded.storage_path, page = excluded.page$$,
  'PUT: the source owner adds a file (sending a forged owner_id and group_id)'
);
select results_eq(
  $$select owner_id::text, group_id from public.source_files where id = '41000000-0000-4000-8000-000000000001'$$,
  $$values ('10000000-0000-4000-8000-000000000001', null::uuid)$$,
  'the file''s owner_id and group_id are copied from the source, not taken from the client'
);
select is(
  pg_temp.affected($$update public.source_files set transcript = 'Mitochondria...', confirmed = true
    where id = '41000000-0000-4000-8000-000000000001'$$),
  1::bigint,
  'PATCH: the source owner updates a file'
);

update public.source_files set owner_id = '10000000-0000-4000-8000-000000000003'
where id = '41000000-0000-4000-8000-000000000001';
select is(
  (select owner_id from public.source_files where id = '41000000-0000-4000-8000-000000000001'),
  '10000000-0000-4000-8000-000000000001'::uuid,
  'a PATCH of the file''s owner_id is overridden by the source'
);

-- An Edge Function (service role) embeds a chunk without naming owner or group.
reset role;
insert into public.source_chunks (id, source_id, page, content, embed_model)
values ('42000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 1,
        'Mitochondria make ATP.', 'gemini-embedding-2@1536');
select results_eq(
  $$select owner_id::text, group_id from public.source_chunks where id = '42000000-0000-4000-8000-000000000001'$$,
  $$values ('10000000-0000-4000-8000-000000000001', null::uuid)$$,
  'a chunk copies owner_id and group_id from its source'
);

-- Sharing the source with G -----------------------------------------------------------------------
set local role authenticated;
select is(
  pg_temp.affected($$update public.sources set group_id = '30000000-0000-4000-8000-000000000001'
    where id = '40000000-0000-4000-8000-000000000001'$$),
  1::bigint,
  'the owner shares the source with a group'
);
select results_eq(
  $$select (select group_id::text from public.source_files where id = '41000000-0000-4000-8000-000000000001'),
           (select group_id::text from public.source_chunks where id = '42000000-0000-4000-8000-000000000001')$$,
  $$values ('30000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001')$$,
  'sharing a source carries its files and chunks into the group'
);

-- Mia (member of G) ---------------------------------------------------------------------------------
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000002", "role": "authenticated"}';

select is((select count(*) from public.source_files where id = '41000000-0000-4000-8000-000000000001'),
  1::bigint, 'a member reads files of a group source');
select is((select count(*) from public.source_chunks where id = '42000000-0000-4000-8000-000000000001'),
  1::bigint, 'a member reads chunks of a group source');
select is(
  pg_temp.affected($$update public.source_files set transcript = 'edited' where id = '41000000-0000-4000-8000-000000000001'$$),
  0::bigint, 'a member cannot update files of someone else''s source'
);
select is(
  pg_temp.affected($$delete from public.source_files where id = '41000000-0000-4000-8000-000000000001'$$),
  0::bigint, 'a member cannot delete files of someone else''s source'
);
select throws_ok(
  $$insert into public.source_files (id, source_id, owner_id, storage_path)
    values ('41000000-0000-4000-8000-000000000009', '40000000-0000-4000-8000-000000000001',
            '10000000-0000-4000-8000-000000000002',
            '10000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000001/p2.jpg')
    on conflict (id) do update set id = excluded.id, source_id = excluded.source_id,
      owner_id = excluded.owner_id, storage_path = excluded.storage_path$$,
  '42501', null,
  'a member cannot add files to someone else''s source'
);
select lives_ok(
  $$insert into public.sources (id, owner_id, group_id, kind, url)
    values ('40000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002',
            '30000000-0000-4000-8000-000000000001', 'link', 'https://example.com/atp')
    on conflict (id) do update set id = excluded.id, owner_id = excluded.owner_id, group_id = excluded.group_id,
      kind = excluded.kind, url = excluded.url$$,
  'a member can share their own source with the group'
);

-- Xena (outsider) -----------------------------------------------------------------------------------
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000003", "role": "authenticated"}';

select results_eq(
  $$select (select count(*) from public.sources where id = '40000000-0000-4000-8000-000000000001'),
           (select count(*) from public.source_files where id = '41000000-0000-4000-8000-000000000001'),
           (select count(*) from public.source_chunks where id = '42000000-0000-4000-8000-000000000001')$$,
  $$values (0::bigint, 0::bigint, 0::bigint)$$,
  'a non-member sees none of the group source, its files or its chunks'
);
select lives_ok(
  $$insert into public.sources (id, owner_id, group_id, kind)
    values ('40000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003',
            '30000000-0000-4000-8000-000000000001', 'notes')
    on conflict (id) do update set id = excluded.id, owner_id = excluded.owner_id, group_id = excluded.group_id,
      kind = excluded.kind$$,
  'a non-member''s source naming the group is accepted ...'
);
select results_eq(
  $$select owner_id::text, group_id from public.sources where id = '40000000-0000-4000-8000-000000000003'$$,
  $$values ('10000000-0000-4000-8000-000000000003', null::uuid)$$,
  '... but stored unshared (a non-member cannot share a source with the group)'
);
select is(
  pg_temp.affected($$update public.sources set title = 'mine' where id = '40000000-0000-4000-8000-000000000001'$$),
  0::bigint, 'a non-member cannot update the source'
);

-- source_chunks are read-only to clients ----------------------------------------------------------
set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000001", "role": "authenticated"}';

select is((select count(*) from public.sources where id = '40000000-0000-4000-8000-000000000002'),
  1::bigint, 'the group owner sees sources members shared');
select is((select count(*) from public.source_chunks where id = '42000000-0000-4000-8000-000000000001'),
  1::bigint, 'the owner reads the chunks of their source');
select throws_ok(
  $$insert into public.source_chunks (id, source_id, owner_id, content)
    values ('42000000-0000-4000-8000-000000000009', '40000000-0000-4000-8000-000000000001',
            '10000000-0000-4000-8000-000000000001', 'forged')$$,
  '42501', null,
  'clients cannot insert source chunks'
);
select throws_ok(
  $$update public.source_chunks set content = 'edited' where id = '42000000-0000-4000-8000-000000000001'$$,
  '42501', null,
  'clients cannot update source chunks'
);
select throws_ok(
  $$delete from public.source_chunks where id = '42000000-0000-4000-8000-000000000001'$$,
  '42501', null,
  'clients cannot delete source chunks'
);

-- Moving between groups -----------------------------------------------------------------------------
update public.sources set group_id = '30000000-0000-4000-8000-000000000002'
where id = '40000000-0000-4000-8000-000000000001';
select results_eq(
  $$select (select group_id::text from public.source_files where id = '41000000-0000-4000-8000-000000000001'),
           (select group_id::text from public.source_chunks where id = '42000000-0000-4000-8000-000000000001')$$,
  $$values ('30000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002')$$,
  'moving a source to another group moves its files and chunks'
);

set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select results_eq(
  $$select (select count(*) from public.source_files where id = '41000000-0000-4000-8000-000000000001'),
           (select count(*) from public.source_chunks where id = '42000000-0000-4000-8000-000000000001')$$,
  $$values (0::bigint, 0::bigint)$$,
  'members of the old group lose access to the files and chunks'
);

set local request.jwt.claims to '{"sub": "10000000-0000-4000-8000-000000000001", "role": "authenticated"}';
update public.sources set group_id = null where id = '40000000-0000-4000-8000-000000000001';
select results_eq(
  $$select (select group_id from public.source_files where id = '41000000-0000-4000-8000-000000000001'),
           (select group_id from public.source_chunks where id = '42000000-0000-4000-8000-000000000001')$$,
  $$values (null::uuid, null::uuid)$$,
  'unsharing a source unshares its files and chunks'
);

-- Deleting a group unshares everything in it (whatever order the ON DELETE SET NULL actions run in).
update public.sources set group_id = '30000000-0000-4000-8000-000000000002'
where id = '40000000-0000-4000-8000-000000000001';
select is(
  pg_temp.affected($$delete from public.groups where id = '30000000-0000-4000-8000-000000000002'$$),
  1::bigint,
  'the owner deletes a group that holds a source with files and chunks'
);
reset role;
select results_eq(
  $$select (select group_id from public.sources where id = '40000000-0000-4000-8000-000000000001'),
           (select group_id from public.source_files where id = '41000000-0000-4000-8000-000000000001'),
           (select group_id from public.source_chunks where id = '42000000-0000-4000-8000-000000000001')$$,
  $$values (null::uuid, null::uuid, null::uuid)$$,
  'deleting the group unshares the source, its files and its chunks'
);

-- Same again with the FK actions in the other order: re-creating the sources FK makes its
-- ON DELETE SET NULL run after the source_files/source_chunks ones (actions fire in trigger-name
-- order, i.e. creation order), so the copy trigger sees a parent still pointing at the dying group.
alter table public.sources drop constraint sources_group_id_fkey;
alter table public.sources add constraint sources_group_id_fkey
  foreign key (group_id) references public.groups (id) on delete set null;
insert into public.groups (id, owner_id, name)
values ('30000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'G3');
insert into public.sources (id, owner_id, group_id, kind)
values ('40000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000003', 'notes');
insert into public.source_files (id, source_id, owner_id, storage_path)
values ('41000000-0000-4000-8000-000000000004', '40000000-0000-4000-8000-000000000004',
        '10000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000004/notes.jpg');
insert into public.source_chunks (id, source_id, content)
values ('42000000-0000-4000-8000-000000000004', '40000000-0000-4000-8000-000000000004', 'Notes.');
delete from public.groups where id = '30000000-0000-4000-8000-000000000003';
select results_eq(
  $$select (select group_id from public.sources where id = '40000000-0000-4000-8000-000000000004'),
           (select group_id from public.source_files where id = '41000000-0000-4000-8000-000000000004'),
           (select group_id from public.source_chunks where id = '42000000-0000-4000-8000-000000000004')$$,
  $$values (null::uuid, null::uuid, null::uuid)$$,
  'deleting a group works whatever order its ON DELETE SET NULL actions run in'
);

-- Deletes -----------------------------------------------------------------------------------------
set local role authenticated;
select is(pg_temp.affected($$delete from public.source_files where id = '41000000-0000-4000-8000-000000000001'$$),
  1::bigint, 'DELETE: the source owner deletes a file');
select is(pg_temp.affected($$delete from public.sources where id = '40000000-0000-4000-8000-000000000001'$$),
  1::bigint, 'DELETE: the owner deletes the source');
reset role;
select is((select count(*) from public.source_chunks where source_id = '40000000-0000-4000-8000-000000000001'),
  0::bigint, 'deleting a source deletes its chunks');

select * from finish();
rollback;
