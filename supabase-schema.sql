-- Persistent storage for the forum bot.
-- Run this once in Supabase Dashboard -> SQL Editor -> New query.
create table if not exists public.forum_bot_state (
  id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.forum_bot_state enable row level security;
revoke all on table public.forum_bot_state from anon, authenticated;
grant all on table public.forum_bot_state to service_role;
