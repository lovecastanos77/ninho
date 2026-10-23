-- Ninho — migracao v3 (rode UMA vez no SQL Editor, DEPOIS do schema.sql e do schema_v2.sql)
-- Acesso por TOKEN: um codigo longo e secreto (a "chave da casa") que entra direto,
-- sem e-mail e sem senha. No banco fica so o HASH do token (nem quem ve o banco le o token).
-- Este arquivo ja inclui o token gerado para o Marcos (vinculado a familia no primeiro uso).

create extension if not exists pgcrypto;

-- ============ tabela de tokens (trancada: nenhuma leitura/escrita direta pela API) ============
create table if not exists public.access_tokens (
  token_hash text primary key,
  family_id uuid references public.families(id) on delete cascade,
  label text,
  created_at timestamptz not null default now()
);
alter table public.access_tokens enable row level security;
-- (sem policies de proposito: so as funcoes abaixo, security definer, tocam nesta tabela)

-- token do Marcos (hash sha256 do token normalizado: maiusculas, sem tracos)
insert into public.access_tokens (token_hash, label)
values ('a36e37887f10f3111cf1fb8d183268c405581278fcf5f303aa9079bd5f9fbfd5', 'Token do Marcos')
on conflict (token_hash) do nothing;

-- ============ entrar com o token ============
-- Retorna a familia quando o token ja esta vinculado (e ja inclui a pessoa como membro).
-- Retorna NULL quando o token existe mas ainda nao foi vinculado (primeiro uso do dono:
-- o app manda criar a familia e depois chama claim_token_family).
-- Erro quando o token nao existe.
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
  v_family public.families;
begin
  if auth.uid() is null then
    raise exception 'Voce precisa estar logado.';
  end if;

  select family_id into v_family_id from public.access_tokens where token_hash = v_hash;
  if not found then
    raise exception 'Token nao encontrado.';
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

-- ============ vincular o token a familia recém-criada (so no primeiro uso) ============
create or replace function public.claim_token_family(p_token text, p_family_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_norm text := upper(regexp_replace(coalesce(p_token, ''), '[^A-Za-z0-9]', '', 'g'));
  v_hash text := encode(digest(v_norm, 'sha256'), 'hex');
begin
  if not public.is_family_member(p_family_id) then
    raise exception 'Voce nao e membro desta familia.';
  end if;
  update public.access_tokens
     set family_id = p_family_id
   where token_hash = v_hash and family_id is null;
  if not found then
    raise exception 'Token nao encontrado ou ja vinculado.';
  end if;
end;
$$;

revoke all on function public.enter_with_token(text) from public;
grant execute on function public.enter_with_token(text) to authenticated;
revoke all on function public.claim_token_family(text, uuid) from public;
grant execute on function public.claim_token_family(text, uuid) to authenticated;
