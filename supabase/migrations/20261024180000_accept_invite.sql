-- Joining a server by invite code. A database function rather than an Edge
-- Function: it runs in one transaction, so two friends using the last slot of
-- a code at the same moment cannot both get in.

create table public.invite_attempts (
  user_id uuid not null references auth.users (id) on delete cascade,
  at timestamptz not null default now()
);
create index invite_attempts_user_idx on public.invite_attempts (user_id, at);
-- Only the function below touches it.
alter table public.invite_attempts enable row level security;

-- Returns the server id, or null for a wrong, expired or used-up code. A wrong
-- code returns instead of raising, because an error would roll back the
-- recorded attempt and the limit on guesses would never kick in.
create function public.accept_invite(invite_code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  inv public.invites%rowtype;
begin
  if uid is null then
    raise exception 'not_signed_in' using errcode = 'P0001';
  end if;

  -- At most 10 tries an hour, so codes cannot be guessed.
  if (select count(*) from public.invite_attempts where user_id = uid and at > now() - interval '1 hour') >= 10 then
    raise exception 'too_many_attempts' using errcode = 'P0001';
  end if;
  insert into public.invite_attempts (user_id) values (uid);
  delete from public.invite_attempts where at < now() - interval '1 day';

  select * into inv from public.invites
  where code = upper(regexp_replace(invite_code, '\s', '', 'g'))
  for update;

  if not found then
    return null;
  end if;

  -- Already in: nothing to do, and the code is not used up again.
  if exists (select 1 from public.members where server_id = inv.server_id and user_id = uid) then
    return inv.server_id;
  end if;

  if inv.revoked or inv.expires_at < now() or inv.uses >= inv.max_uses then
    return null;
  end if;

  insert into public.members (server_id, user_id) values (inv.server_id, uid);  -- raises server_full at 50
  update public.invites set uses = uses + 1 where code = inv.code;
  return inv.server_id;
end;
$$;
revoke execute on function public.accept_invite(text) from public, anon;
grant execute on function public.accept_invite(text) to authenticated;
