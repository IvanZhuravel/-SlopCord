-- SlopCord stage 1 schema: profiles, servers, members, invites, rooms, messages, attachments.
-- Every table is protected by Row Level Security: you only see servers you are a member of.
-- Who is in which voice room is not stored here; it comes from Supabase Realtime Presence.

-- ---------------------------------------------------------------- tables

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 32),
  avatar_path text,
  locale text not null default 'uk' check (locale in ('uk', 'en')),
  created_at timestamptz not null default now()
);

create table public.servers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 50),
  owner_id uuid not null references public.profiles (id),
  created_at timestamptz not null default now()
);

create table public.members (
  server_id uuid not null references public.servers (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (server_id, user_id)
);
create index members_user_idx on public.members (user_id);

create table public.invites (
  code text primary key,
  server_id uuid not null references public.servers (id) on delete cascade,
  created_by uuid not null references public.profiles (id),
  expires_at timestamptz not null default now() + interval '7 days',
  max_uses int not null default 10 check (max_uses between 1 and 50),
  uses int not null default 0,
  revoked boolean not null default false,
  created_at timestamptz not null default now()
);
create index invites_server_idx on public.invites (server_id);

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 40),
  position int not null default 0,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index rooms_server_idx on public.rooms (server_id, position);

create table public.messages (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.rooms (id) on delete cascade,
  author_id uuid references public.profiles (id) on delete set null,
  body text not null default '' check (char_length(body) <= 2000),
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz
);
-- History is read newest first, 50 at a time.
create index messages_room_idx on public.messages (room_id, id desc);

create table public.attachments (
  id uuid primary key default gen_random_uuid(),
  message_id bigint not null references public.messages (id) on delete cascade,
  path text not null,
  thumb_path text,
  mime text not null check (mime in ('image/webp', 'image/gif', 'image/png', 'image/jpeg')),
  size_bytes int not null check (size_bytes between 1 and 10485760),
  width int not null check (width > 0),
  height int not null check (height > 0)
);
create index attachments_message_idx on public.attachments (message_id);

-- ---------------------------------------------------------------- helpers

-- security definer so policies can ask "am I a member?" without recursing into members' own policy.
create function public.is_member(sid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.members where server_id = sid and user_id = auth.uid());
$$;

create function public.is_owner(sid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.servers where id = sid and owner_id = auth.uid());
$$;

create function public.room_server(rid uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select server_id from public.rooms where id = rid;
$$;

create function public.message_server(mid bigint) returns uuid
language sql stable security definer set search_path = '' as $$
  select r.server_id from public.messages m join public.rooms r on r.id = m.room_id where m.id = mid;
$$;

create function public.shares_server(other uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.members a join public.members b on a.server_id = b.server_id
    where a.user_id = auth.uid() and b.user_id = other
  );
$$;

-- 8 characters without look-alikes (no 0/O, 1/I/L).
create function public.new_invite_code() returns text
language sql volatile set search_path = '' as $$
  select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + floor(random() * 31)::int, 1), '')
  from generate_series(1, 8);
$$;
alter table public.invites alter column code set default public.new_invite_code();

-- Creating a server goes through this function so the owner membership and the
-- first room are created in the same step.
create function public.create_server(server_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  sid uuid;
begin
  if auth.uid() is null then
    raise exception 'not_signed_in' using errcode = 'P0001';
  end if;
  insert into public.servers (name, owner_id) values (btrim(server_name), auth.uid()) returning id into sid;
  return sid;
end;
$$;
revoke execute on function public.create_server(text) from public, anon;
grant execute on function public.create_server(text) to authenticated;

-- ---------------------------------------------------------------- triggers

-- A profile appears as soon as someone signs up; the name comes from sign-up metadata.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  name text := left(btrim(coalesce(nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
                                   split_part(new.email, '@', 1))), 32);
begin
  insert into public.profiles (id, display_name, locale)
  values (new.id, case when char_length(name) < 2 then rpad(name, 2, '_') else name end,
          case when new.raw_user_meta_data ->> 'locale' = 'en' then 'en' else 'uk' end);
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- The creator becomes the owner member, and the server starts with one room.
create function public.handle_new_server() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.members (server_id, user_id, role) values (new.id, new.owner_id, 'owner');
  insert into public.rooms (server_id, name, position, created_by) values (new.id, 'Загальна', 0, new.owner_id);
  return new;
end;
$$;
create trigger on_server_created after insert on public.servers
  for each row execute function public.handle_new_server();

create function public.enforce_limits() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'members'
     and (select count(*) from public.members where server_id = new.server_id) >= 50 then
    raise exception 'server_full' using errcode = 'P0001';
  end if;
  if tg_table_name = 'rooms'
     and (select count(*) from public.rooms where server_id = new.server_id) >= 20 then
    raise exception 'too_many_rooms' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger members_limit before insert on public.members
  for each row execute function public.enforce_limits();
create trigger rooms_limit before insert on public.rooms
  for each row execute function public.enforce_limits();

-- Authors edit and delete their messages; the server owner may only delete them.
create function public.guard_message_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.room_id <> old.room_id or new.author_id is distinct from old.author_id
     or new.created_at <> old.created_at then
    raise exception 'immutable_columns' using errcode = 'P0001';
  end if;
  if old.author_id is distinct from auth.uid() and new.body <> old.body then
    raise exception 'not_author' using errcode = 'P0001';
  end if;
  if old.deleted_at is not null then
    raise exception 'message_deleted' using errcode = 'P0001';
  end if;
  if new.body <> old.body then new.edited_at := now(); end if;
  if new.deleted_at is not null and old.deleted_at is null then
    new.deleted_at := now();
    new.body := '';
  end if;
  return new;
end;
$$;
create trigger messages_guard before update on public.messages
  for each row execute function public.guard_message_update();

-- ---------------------------------------------------------------- row level security

alter table public.profiles enable row level security;
alter table public.servers enable row level security;
alter table public.members enable row level security;
alter table public.invites enable row level security;
alter table public.rooms enable row level security;
alter table public.messages enable row level security;
alter table public.attachments enable row level security;

create policy "see self and server mates" on public.profiles for select to authenticated
  using (id = auth.uid() or public.shares_server(id));
create policy "edit own profile" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy "members see server" on public.servers for select to authenticated
  using (public.is_member(id));
create policy "owner renames server" on public.servers for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "owner deletes server" on public.servers for delete to authenticated
  using (owner_id = auth.uid());

-- Joining goes through the accept-invite function (service role), so there is no insert policy.
create policy "members see members" on public.members for select to authenticated
  using (public.is_member(server_id));
create policy "leave, or owner removes" on public.members for delete to authenticated
  using (role <> 'owner' and (user_id = auth.uid() or public.is_owner(server_id)));

create policy "owner sees invites" on public.invites for select to authenticated
  using (public.is_owner(server_id));
create policy "owner creates invites" on public.invites for insert to authenticated
  with check (public.is_owner(server_id) and created_by = auth.uid() and uses = 0 and not revoked);
create policy "owner revokes invites" on public.invites for update to authenticated
  using (public.is_owner(server_id)) with check (public.is_owner(server_id));

create policy "members see rooms" on public.rooms for select to authenticated
  using (public.is_member(server_id));
create policy "members create rooms" on public.rooms for insert to authenticated
  with check (public.is_member(server_id) and created_by = auth.uid());
create policy "members rename rooms" on public.rooms for update to authenticated
  using (public.is_member(server_id)) with check (public.is_member(server_id));
create policy "owner deletes rooms" on public.rooms for delete to authenticated
  using (public.is_owner(server_id));

create policy "members read messages" on public.messages for select to authenticated
  using (public.is_member(public.room_server(room_id)));
create policy "members write messages" on public.messages for insert to authenticated
  with check (author_id = auth.uid() and public.is_member(public.room_server(room_id)));
create policy "author or owner updates" on public.messages for update to authenticated
  using (author_id = auth.uid() or public.is_owner(public.room_server(room_id)));

create policy "members see attachments" on public.attachments for select to authenticated
  using (public.is_member(public.message_server(message_id)));
create policy "author adds attachments" on public.attachments for insert to authenticated
  with check (exists (select 1 from public.messages m
                      where m.id = message_id and m.author_id = auth.uid()));

-- Column-level limits on top of the policies.
revoke update on public.profiles, public.servers, public.invites, public.rooms, public.messages from authenticated, anon;
grant update (display_name, avatar_path, locale) on public.profiles to authenticated;
grant update (name) on public.servers to authenticated;
grant update (revoked) on public.invites to authenticated;
grant update (name) on public.rooms to authenticated;
grant update (body, deleted_at) on public.messages to authenticated;
revoke insert on public.messages from authenticated, anon;
grant insert (room_id, author_id, body) on public.messages to authenticated;

-- ---------------------------------------------------------------- realtime

alter publication supabase_realtime add table public.messages, public.rooms, public.attachments;

-- ---------------------------------------------------------------- storage

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('avatars', 'avatars', true, 524288, array['image/webp', 'image/png', 'image/jpeg']),
  ('attachments', 'attachments', false, 10485760, array['image/webp', 'image/gif', 'image/png', 'image/jpeg']);

-- avatars/<user id>/<file>: you write only your own folder; anyone can read (public bucket).
create policy "own avatar write" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own avatar update" on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own avatar delete" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- attachments/<server id>/<room id>/<file>: members read and upload.
create policy "members read attachments" on storage.objects for select to authenticated
  using (bucket_id = 'attachments' and public.is_member(((storage.foldername(name))[1])::uuid));
create policy "members upload attachments" on storage.objects for insert to authenticated
  with check (bucket_id = 'attachments' and public.is_member(((storage.foldername(name))[1])::uuid));
