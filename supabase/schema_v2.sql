-- Ninho — migracao v2 (rode UMA vez no SQL Editor, DEPOIS do schema.sql)
-- Adiciona: tipos novos de evento (temperatura, barriguinha, banho), medidas extras
-- (comprimento e perimetro cefalico) e a funcao para entrar numa familia pelo codigo de convite.

-- ============ novos tipos e colunas ============
alter table public.events drop constraint if exists events_type_check;
alter table public.events add constraint events_type_check
  check (type in ('sleep', 'feeding', 'diaper', 'weight', 'medicine', 'temperature', 'tummy', 'bath', 'note'));

alter table public.events add column if not exists temp_c numeric;
alter table public.events add column if not exists length_cm numeric;
alter table public.events add column if not exists head_cm numeric;

-- ============ entrar na familia pelo codigo de convite ============
-- Necessario porque, por seguranca (RLS), quem nao e membro nao enxerga a familia
-- para procurar pelo codigo. Esta funcao faz a busca e ja inclui a pessoa como membro.
create or replace function public.join_family_by_code(p_code text)
returns public.families
language plpgsql
security definer
set search_path = public
as $$
declare
  v_family public.families;
begin
  if auth.uid() is null then
    raise exception 'Voce precisa estar logado.';
  end if;

  select * into v_family
  from public.families
  where invite_code = upper(trim(p_code));

  if v_family.id is null then
    raise exception 'Codigo de convite nao encontrado.';
  end if;

  insert into public.family_members (family_id, user_id, role)
  values (v_family.id, auth.uid(), 'member')
  on conflict do nothing;

  return v_family;
end;
$$;

revoke all on function public.join_family_by_code(text) from public;
grant execute on function public.join_family_by_code(text) to authenticated;
