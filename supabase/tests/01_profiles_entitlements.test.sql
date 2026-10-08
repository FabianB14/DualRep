-- profiles and entitlements: created by handle_new_user(); a profile is its owner's to edit; an
-- entitlement is read-only to its owner and invisible to everyone else; has_paid_access().
begin;
create extension if not exists pgtap with schema extensions;
select plan(31);

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

-- Users: Ada (display name in metadata), Bob (email only), Cy (no email, e.g. phone sign-up),
-- Dee (an over-long display name).
insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-4111-8111-111111111111', 'ada@example.com', '{"display_name": "Ada"}'),
  ('22222222-2222-4222-8222-222222222222', 'bob.builder@example.com', '{}'),
  ('33333333-3333-4333-8333-333333333333', null, null),
  ('44444444-4444-4444-8444-444444444444', 'dee@example.com',
   jsonb_build_object('display_name', '  ' || repeat('d', 100)));

-- handle_new_user ---------------------------------------------------------------------------------
select results_eq(
  $$select id::text, display_name from public.profiles
    where id in ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
                 '33333333-3333-4333-8333-333333333333')
    order by id$$,
  $$values ('11111111-1111-4111-8111-111111111111', 'Ada'),
           ('22222222-2222-4222-8222-222222222222', 'bob.builder'),
           ('33333333-3333-4333-8333-333333333333', '')$$,
  'a new user gets a profile named from metadata, else the email local part, else empty'
);

select is(
  (select display_name from public.profiles where id = '44444444-4444-4444-8444-444444444444'),
  repeat('d', 80),
  'an over-long display name is trimmed and cut to 80 characters instead of failing the sign-up'
);

select results_eq(
  $$select unit_pref, default_block_minutes, default_preset_id is null, fsrs_params is null
    from public.profiles where id = '11111111-1111-4111-8111-111111111111'$$,
  $$values ('lb', 25, true, true)$$,
  'a new profile has the default settings'
);

select results_eq(
  $$select user_id::text, tier, source, expires_at is null from public.entitlements
    order by user_id$$,
  $$values ('11111111-1111-4111-8111-111111111111', 'free', 'none', true),
           ('22222222-2222-4222-8222-222222222222', 'free', 'none', true),
           ('33333333-3333-4333-8333-333333333333', 'free', 'none', true),
           ('44444444-4444-4444-8444-444444444444', 'free', 'none', true)$$,
  'every new user gets a free entitlement'
);

-- profiles as Ada ---------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-4111-8111-111111111111", "role": "authenticated"}';

select is(
  (select count(*) from public.profiles where id = '11111111-1111-4111-8111-111111111111'),
  1::bigint,
  'a user sees their own profile'
);

select is(
  (select count(*) from public.profiles where id = '22222222-2222-4222-8222-222222222222'),
  0::bigint,
  'a user cannot see the profile of someone they share no group with'
);

select lives_ok(
  $$insert into public.profiles (id, display_name, unit_pref, default_block_minutes)
    values ('11111111-1111-4111-8111-111111111111', 'Ada L.', 'kg', 30)
    on conflict (id) do update set
      id = excluded.id, display_name = excluded.display_name,
      unit_pref = excluded.unit_pref, default_block_minutes = excluded.default_block_minutes$$,
  'PUT: a user can upsert their own profile'
);

select results_eq(
  $$select display_name, unit_pref, default_block_minutes from public.profiles
    where id = '11111111-1111-4111-8111-111111111111'$$,
  $$values ('Ada L.', 'kg', 30)$$,
  'the upsert updated the existing profile'
);

select is(
  pg_temp.affected($$update public.profiles
    set fsrs_params = '{"request_retention": 0.9}', default_preset_id = '00000000-0000-4000-8000-0000000000a3'
    where id = '11111111-1111-4111-8111-111111111111'$$),
  1::bigint,
  'PATCH: a user can update their own profile, including pointing at a system preset'
);

select is(
  pg_temp.affected($$update public.profiles set display_name = 'hacked'
    where id = '22222222-2222-4222-8222-222222222222'$$),
  0::bigint,
  'a user cannot update someone else''s profile'
);

select throws_ok(
  $$delete from public.profiles where id = '11111111-1111-4111-8111-111111111111'$$,
  '42501', null,
  'DELETE: profiles cannot be deleted by the client (account deletion cascades instead)'
);

select throws_ok(
  $$insert into public.profiles (id, display_name)
    values ('22222222-2222-4222-8222-222222222222', 'hacked')
    on conflict (id) do update set id = excluded.id, display_name = excluded.display_name$$,
  '42501', null,
  'a user cannot upsert someone else''s profile'
);

select throws_ok(
  $$update public.profiles set unit_pref = 'stone' where id = '11111111-1111-4111-8111-111111111111'$$,
  '23514', null,
  'unit_pref must be lb or kg'
);

select throws_ok(
  $$update public.profiles set default_block_minutes = 5 where id = '11111111-1111-4111-8111-111111111111'$$,
  '23514', null,
  'default_block_minutes must be between 10 and 50'
);

select throws_ok(
  $$update public.profiles set display_name = repeat('x', 81) where id = '11111111-1111-4111-8111-111111111111'$$,
  '23514', null,
  'display_name is at most 80 characters'
);

-- entitlements as Ada -----------------------------------------------------------------------------
select results_eq(
  $$select tier, source from public.entitlements$$,
  $$values ('free', 'none')$$,
  'a user sees only their own entitlement'
);

select throws_ok(
  $$insert into public.entitlements (id, user_id, tier, source)
    values ('e0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'subscription', 'store')
    on conflict (id) do nothing$$,
  '42501', null,
  'a user cannot grant themselves an entitlement'
);

select throws_ok(
  $$insert into public.entitlements (id, user_id, tier, source)
    values ('e0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'subscription', 'store')
    on conflict (id) do update set id = excluded.id, user_id = excluded.user_id,
      tier = excluded.tier, source = excluded.source$$,
  '42501', null,
  'a user cannot upsert an entitlement'
);

select throws_ok(
  $$update public.entitlements set tier = 'subscription', source = 'store'
    where user_id = '11111111-1111-4111-8111-111111111111'$$,
  '42501', null,
  'a user cannot upgrade their own entitlement'
);

select throws_ok(
  $$delete from public.entitlements where user_id = '11111111-1111-4111-8111-111111111111'$$,
  '42501', null,
  'a user cannot delete their entitlement'
);

select ok(not public.has_paid_access(), 'the free tier has no paid access');

reset role;

-- The store webhook (service role) upgrades Ada and Bob.
update public.entitlements set tier = 'subscription', source = 'store', expires_at = now() + interval '30 days'
where user_id = '11111111-1111-4111-8111-111111111111';
update public.entitlements set tier = 'subscription', source = 'beta', expires_at = null
where user_id = '22222222-2222-4222-8222-222222222222';

set local role authenticated;

select ok(public.has_paid_access(), 'an active subscription has paid access');
select ok(
  public.has_paid_access('11111111-1111-4111-8111-111111111111'),
  'has_paid_access(own id) is the same as has_paid_access()'
);
select ok(
  not public.has_paid_access('22222222-2222-4222-8222-222222222222'),
  'a signed-in user cannot probe someone else''s subscription'
);

select throws_ok(
  $$update public.entitlements set expires_at = null where user_id = '11111111-1111-4111-8111-111111111111'$$,
  '42501', null,
  'a subscriber cannot extend their own entitlement'
);

-- Bob cannot see Ada's entitlement.
set local request.jwt.claims to '{"sub": "22222222-2222-4222-8222-222222222222", "role": "authenticated"}';
select is(
  (select count(*) from public.entitlements where user_id = '11111111-1111-4111-8111-111111111111'),
  0::bigint,
  'a user cannot see someone else''s entitlement'
);
select ok(public.has_paid_access(), 'a beta subscription without an expiry has paid access');

reset role;
-- Server-side callers (no user in the JWT) may check anyone.
set local request.jwt.claims to '';
select ok(
  public.has_paid_access('22222222-2222-4222-8222-222222222222'),
  'server-side callers can check any user''s access'
);

update public.entitlements set expires_at = now() - interval '1 day'
where user_id = '11111111-1111-4111-8111-111111111111';
select ok(
  not public.has_paid_access('11111111-1111-4111-8111-111111111111'),
  'an expired subscription has no paid access'
);

select results_eq(
  $$select display_name from public.profiles where id = '22222222-2222-4222-8222-222222222222'$$,
  $$values ('bob.builder')$$,
  'Bob''s profile is unchanged by Ada''s attempts'
);

select results_eq(
  $$select tier from public.entitlements where user_id = '33333333-3333-4333-8333-333333333333'$$,
  $$values ('free')$$,
  'nobody else''s entitlement changed'
);

select * from finish();
rollback;
