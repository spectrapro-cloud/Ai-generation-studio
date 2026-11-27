create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  role text not null default 'customer' check (role in ('customer', 'admin')),
  credits integer not null default 0 check (credits >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.generations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('image', 'video')),
  prompt text not null check (char_length(prompt) between 3 and 3000),
  aspect_ratio text not null,
  status text not null default 'queued' check (status in ('queued', 'processing', 'succeeded', 'failed', 'storage_failed')),
  provider text not null default 'replicate',
  provider_prediction_id text unique,
  provider_status text,
  provider_output jsonb,
  asset_path text,
  asset_mime_type text,
  asset_bytes bigint,
  credits_reserved integer not null default 0 check (credits_reserved >= 0),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists generations_user_created_idx on public.generations(user_id, created_at desc);
create index if not exists generations_status_idx on public.generations(status) where status in ('queued', 'processing', 'storage_failed');

create table if not exists public.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  generation_id uuid references public.generations(id) on delete set null,
  entry_type text not null check (entry_type in ('purchase', 'reservation', 'refund', 'admin_adjustment')),
  amount integer not null check (amount <> 0),
  reason text,
  idempotency_key text unique,
  created_at timestamptz not null default now()
);

create index if not exists credit_ledger_user_created_idx on public.credit_ledger(user_id, created_at desc);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_lumi on auth.users;
create trigger on_auth_user_created_lumi
after insert on auth.users
for each row execute procedure public.handle_new_user();

create or replace function public.reserve_generation_credits(p_generation_id uuid, p_amount integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null or p_amount < 1 then raise exception 'INVALID_RESERVATION'; end if;
  if not exists (select 1 from public.generations where id = p_generation_id and user_id = v_user_id) then
    raise exception 'GENERATION_NOT_OWNED';
  end if;
  if exists (select 1 from public.credit_ledger where generation_id = p_generation_id and entry_type = 'reservation') then
    return;
  end if;

  update public.profiles
    set credits = credits - p_amount, updated_at = now()
    where id = v_user_id and credits >= p_amount;
  if not found then raise exception 'INSUFFICIENT_CREDITS'; end if;

  insert into public.credit_ledger(user_id, generation_id, entry_type, amount, reason, idempotency_key)
  values (v_user_id, p_generation_id, 'reservation', -p_amount, 'generation_reserved', 'reserve:' || p_generation_id::text);
  update public.generations set credits_reserved = p_amount where id = p_generation_id and user_id = v_user_id;
end;
$$;

create or replace function public.refund_generation_credits(p_generation_id uuid, p_amount integer, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null or p_amount < 1 then raise exception 'INVALID_REFUND'; end if;
  if not exists (select 1 from public.generations where id = p_generation_id and user_id = v_user_id) then
    raise exception 'GENERATION_NOT_OWNED';
  end if;
  if exists (select 1 from public.credit_ledger where generation_id = p_generation_id and entry_type = 'refund') then
    return;
  end if;
  if not exists (select 1 from public.credit_ledger where generation_id = p_generation_id and entry_type = 'reservation') then
    raise exception 'NO_RESERVATION_TO_REFUND';
  end if;

  insert into public.credit_ledger(user_id, generation_id, entry_type, amount, reason, idempotency_key)
  values (v_user_id, p_generation_id, 'refund', p_amount, coalesce(p_reason, 'generation_refund'), 'refund:' || p_generation_id::text);
  update public.profiles set credits = credits + p_amount, updated_at = now() where id = v_user_id;
end;
$$;

alter table public.profiles enable row level security;
alter table public.generations enable row level security;
alter table public.credit_ledger enable row level security;

drop policy if exists "profile owner reads profile" on public.profiles;
create policy "profile owner reads profile" on public.profiles for select using (auth.uid() = id);

drop policy if exists "customers read own generations" on public.generations;
create policy "customers read own generations" on public.generations for select using (auth.uid() = user_id);
drop policy if exists "customers create own generations" on public.generations;
create policy "customers create own generations" on public.generations for insert with check (auth.uid() = user_id);
drop policy if exists "customers update own generations" on public.generations;
create policy "customers update own generations" on public.generations for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "customers delete own generations" on public.generations;
create policy "customers delete own generations" on public.generations for delete using (auth.uid() = user_id);

drop policy if exists "customers read own credit ledger" on public.credit_ledger;
create policy "customers read own credit ledger" on public.credit_ledger for select using (auth.uid() = user_id);

revoke all on function public.reserve_generation_credits(uuid, integer) from public;
revoke all on function public.refund_generation_credits(uuid, integer, text) from public;
grant execute on function public.reserve_generation_credits(uuid, integer) to authenticated;
grant execute on function public.refund_generation_credits(uuid, integer, text) to authenticated;

-- No client-side INSERT/UPDATE/DELETE policy is granted for profiles or credit_ledger.
-- Credit balances are changed only by transactional RPCs and trusted server-side billing/admin workflows.
