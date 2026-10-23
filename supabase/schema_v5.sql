-- Ninho — schema v5: seguranca + tipos novos de registro (rode UMA vez no SQL Editor)
-- Revisao de seguranca de 23/10/2026. Pode rodar sem medo: nao apaga dados nem muda o token.

begin;

-- ============ 1) Liberar os tipos novos de registro ============
-- A Caderneta (vacina, vitamina, pergunta) e a foto usam tipos que a trava
-- antiga da tabela nao conhecia — sem isto, eles falham ao salvar na nuvem.
alter table public.events drop constraint if exists events_type_check;
alter table public.events add constraint events_type_check
  check (type in ('sleep', 'feeding', 'diaper', 'weight', 'medicine', 'temperature',
                  'tummy', 'bath', 'note', 'vaccine', 'vitamin', 'question', 'photo'));

-- ============ 2) Ninguem entra numa familia "pela porta dos fundos" ============
-- Antes: qualquer usuario logado (ate anonimo) podia se inserir em qualquer
-- familia se soubesse o UUID dela. Agora membro so entra por: criar a familia
-- (gatilho do dono), codigo de convite ou token — todos por funcoes controladas.
drop policy if exists members_join on public.family_members;

-- ============ 3) Dono de verdade ============
create or replace function public.is_family_owner(p_family_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.family_members
    where family_id = p_family_id and user_id = auth.uid() and role = 'owner'
  );
$$;

create or replace function public.family_owner_count(p_family_id uuid)
returns int
language sql
security definer
set search_path = public
stable
as $$
  select count(*)::int from public.family_members
  where family_id = p_family_id and role = 'owner';
$$;

-- So o dono altera os dados da familia (nome, codigo de convite etc.).
drop policy if exists families_owner_update on public.families;
create policy families_owner_update on public.families
  for update
  using (public.is_family_owner(id))
  with check (public.is_family_owner(id));

-- Sair da familia: cada um so remove a propria associacao, e o ultimo dono
-- nao pode sair (a familia ficaria orfa). O dono pode remover membros comuns.
drop policy if exists members_leave on public.family_members;
create policy members_leave on public.family_members
  for delete
  using (
    (user_id = auth.uid() and (role <> 'owner' or public.family_owner_count(family_id) > 1))
    or (public.is_family_owner(family_id) and role <> 'owner')
  );
-- Observacao: nao existe politica de UPDATE em family_members — ninguem muda
-- o papel (owner/member) de ninguem pela API. E assim que tem que ser.

-- ============ 4) Token revogavel e com validade ============
alter table public.access_tokens add column if not exists revoked boolean not null default false;
alter table public.access_tokens add column if not exists expires_at timestamptz;

create or replace function public.enter_with_token(p_token text)
returns public.families
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_norm text := upper(regexp_replace(coalesce(p_token, ''), '[^A-Za-z0-9]', '', 'g'));
  v_hash text := encode(digest(v_norm, 'sha256'), 'hex');
  v_family_id uuid;
  v_revoked boolean;
  v_expires timestamptz;
  v_family public.families;
begin
  if auth.uid() is null then
    raise exception 'Voce precisa estar logado.';
  end if;

  select family_id, revoked, expires_at
    into v_family_id, v_revoked, v_expires
    from public.access_tokens where token_hash = v_hash;
  if not found then
    raise exception 'Token nao encontrado.';
  end if;
  if v_revoked then
    raise exception 'Token revogado.';
  end if;
  if v_expires is not null and v_expires < now() then
    raise exception 'Token vencido.';
  end if;
  if v_family_id is null then
    return null;
  end if;

  insert into public.family_members (family_id, user_id, role)
  values (v_family_id, auth.uid(), 'member')
  on conflict do nothing;

  select * into v_family from public.families where id = v_family_id;
  return v_family;
end;
$$;

commit;

-- ============ Como revogar o token (quando quiser) ============
-- update public.access_tokens set revoked = true;          -- revoga todos
-- update public.access_tokens set revoked = false;         -- desfaz
-- update public.access_tokens set expires_at = now() + interval '90 days';
-- ATENCAO: revogar o token impede entradas NOVAS, mas quem ja entrou continua
-- membro. Para tirar alguem que ja entrou, apague a linha da pessoa em
-- family_members (Table Editor) — ou peca para a Mica te guiar.
