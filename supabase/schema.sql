-- Ninho — schema inicial (Supabase / Postgres)
-- Rode este arquivo UMA vez no SQL Editor do projeto novo do Supabase.
-- Modelo: uma conta (auth) -> familia(s) -> bebe(s) -> eventos (sono, mamada, fralda, peso...)
-- Seguranca: RLS ligado em tudo; cada usuario so ve dados das familias das quais e membro.

create extension if not exists pgcrypto;

-- ============ familias e membros ============
create table if not exists public.families (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Nossa família',
  invite_code text unique not null default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  created_by uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.family_members (
  family_id uuid not null references public.families(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (family_id, user_id)
);

-- ============ bebes ============
create table if not exists public.babies (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  name text not null,
  birth_date date,
  created_at timestamptz not null default now()
);

-- ============ eventos do tracker ============
-- Um registro por acontecimento. Sono usa starts_at/ends_at (ends_at nulo = em andamento).
-- Mamada: side = 'left' | 'right' (peito) ou kind = 'bottle' + amount_ml (mamadeira).
-- Fralda: kind = 'wet' | 'dirty' | 'both'. Peso: weight_kg. Outros: note livre.
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  baby_id uuid not null references public.babies(id) on delete cascade,
  type text not null check (type in ('sleep', 'feeding', 'diaper', 'weight', 'medicine', 'note')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  side text check (side in ('left', 'right')),
  kind text,
  amount_ml numeric,
  weight_kg numeric,
  note text,
  created_by uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or ends_at >= starts_at)
);

create index if not exists events_baby_starts_idx on public.events (baby_id, starts_at desc);
create index if not exists babies_family_idx on public.babies (family_id);
create index if not exists family_members_user_idx on public.family_members (user_id);

-- ============ helper de membro ============
create or replace function public.is_family_member(p_family_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.family_members
    where family_id = p_family_id and user_id = auth.uid()
  );
$$;

-- familia do bebe (para as policies de events)
create or replace function public.baby_family(p_baby_id uuid)
returns uuid
language sql
security definer
set search_path = public
stable
as $$
  select family_id from public.babies where id = p_baby_id;
$$;

-- ao criar uma familia, o criador vira owner automaticamente
create or replace function public.add_creator_as_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.family_members (family_id, user_id, role)
  values (new.id, new.created_by, 'owner')
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists trg_family_owner on public.families;
create trigger trg_family_owner
  after insert on public.families
  for each row execute function public.add_creator_as_owner();

-- ============ RLS ============
alter table public.families enable row level security;
alter table public.family_members enable row level security;
alter table public.babies enable row level security;
alter table public.events enable row level security;

drop policy if exists families_member_read on public.families;
create policy families_member_read on public.families
  for select using (public.is_family_member(id) or created_by = auth.uid());

drop policy if exists families_create on public.families;
create policy families_create on public.families
  for insert with check (created_by = auth.uid());

drop policy if exists families_owner_update on public.families;
create policy families_owner_update on public.families
  for update using (public.is_family_member(id));

drop policy if exists members_read on public.family_members;
create policy members_read on public.family_members
  for select using (public.is_family_member(family_id) or user_id = auth.uid());

drop policy if exists members_join on public.family_members;
create policy members_join on public.family_members
  for insert with check (user_id = auth.uid());

drop policy if exists members_leave on public.family_members;
create policy members_leave on public.family_members
  for delete using (user_id = auth.uid() or public.is_family_member(family_id));

drop policy if exists babies_rw on public.babies;
create policy babies_rw on public.babies
  for all using (public.is_family_member(family_id))
  with check (public.is_family_member(family_id));

drop policy if exists events_rw on public.events;
create policy events_rw on public.events
  for all using (public.is_family_member(public.baby_family(baby_id)))
  with check (public.is_family_member(public.baby_family(baby_id)));

-- ============ realtime (casal ve o registro um do outro na hora) ============
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'events') then
    alter publication supabase_realtime add table public.events;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'babies') then
    alter publication supabase_realtime add table public.babies;
  end if;
end $$;
