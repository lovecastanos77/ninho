-- Ninho · schema v4 — dados do nascimento no perfil do bebe
-- Rode no SQL Editor do Supabase (projeto do Ninho). Seguro repetir.
alter table public.babies add column if not exists birth_time time;
alter table public.babies add column if not exists birth_weight_kg numeric(5,3);
alter table public.babies add column if not exists birth_length_cm numeric(5,2);
alter table public.babies add column if not exists birth_head_cm numeric(5,2);
alter table public.babies add column if not exists birth_notes text;
