-- Ninho — CORRECAO do v3 (rode UMA vez no SQL Editor)
-- O erro "function digest does not exist" acontecia porque, no Supabase, a extensao
-- pgcrypto mora no schema "extensions" e as funcoes procuravam so no "public".
-- Aqui as duas funcoes sao recriadas enxergando os dois schemas. O token NAO muda.

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
