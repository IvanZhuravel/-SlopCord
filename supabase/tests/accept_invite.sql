-- Run after the stub and all migrations: psql -v ON_ERROR_STOP=1 -f supabase/tests/accept_invite.sql
-- Fails (raises) if any expectation is wrong.
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@test', '{"display_name":"Owner"}'),
  ('00000000-0000-0000-0000-0000000000b1', 'friend@test', '{"display_name":"Friend"}'),
  ('00000000-0000-0000-0000-0000000000c1', 'late@test', '{"display_name":"Late"}');

set role authenticated;
do $$
declare
  sid uuid;
  code text;
  got uuid;
  seen int;
begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  sid := public.create_server('Friends');
  insert into public.invites (server_id, created_by, max_uses) values (sid, auth.uid(), 1) returning invites.code into code;

  -- A stranger sees nothing before joining.
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
  select count(*) into seen from public.servers;
  assert seen = 0, 'stranger should not see the server';

  -- Lower case and spaces are fine.
  got := public.accept_invite(' ' || lower(code) || ' ');
  assert got = sid, 'friend should join the server';
  select count(*) into seen from public.servers;
  assert seen = 1, 'member should see the server';
  -- Joining twice is harmless and does not use the code again.
  got := public.accept_invite(code);
  assert got = sid;

  -- The single use is spent.
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
  assert public.accept_invite(code) is null, 'used-up code must not let you in';

  -- Ten wrong guesses an hour, then a lockout.
  for i in 1..9 loop
    assert public.accept_invite('WRONG' || i) is null;
  end loop;
  begin
    perform public.accept_invite(code);
    assert false, 'eleventh try must be refused';
  exception when sqlstate 'P0001' then
    assert sqlerrm = 'too_many_attempts', sqlerrm;
  end;
end;
$$;
reset role;
select 'accept_invite tests passed';
