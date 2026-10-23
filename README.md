# Ninho

Diário do bebê em português, original e feito para a nossa família: sono, mamadas, fraldas e rotina, com sincronização entre os pais. Nasceu do estudo de como os grandes apps de sono funcionam (conceitos gerais), sem usar código, marca, sons ou conteúdo de nenhum deles.

## O que tem nesta versão

- **Entrada sem senha e sincronização (Supabase):** link mágico (token) por e-mail via `signInWithOtp`, ou entrada por código da família com sessão anônima do aparelho (`signInAnonymously` + RPC `join_family_by_code`) — para essa segunda porta, ligue **Authentication → Providers → Anonymous** no painel. Eventos em tempo real entre os celulares do casal. Sem conta, funciona em **modo local** (só naquele aparelho).
- **Registros de 1 toque ou com cronômetro:** sono, peito esquerdo/direito (com sugestão do próximo peito), mamadeira (ml), ordenha (ml), fralda (xixi/cocô/os dois), barriguinha (tummy time), banho, peso + comprimento + perímetro cefálico, temperatura, remédio/vitamina e registro manual.
- **Próxima soneca:** janela de vigília por idade (tabela de referência: 0–4 sem 35–60 min; 4–12 sem 60–90; 3–4 m 75–120; 5–7 m 2–3h; 7–10 m 2,5–3,5h; 11–14 m 3–4h; 14–24 m 4–6h), com encurtamento automático após soneca curta (<40 min).
- **Alerta de mamada:** para recém-nascido, avisa quando passam ~3h da última mamada.
- **Sons para dormir:** ruído marrom (“útero”), rosa (“chuva”) e branco gerados no aparelho (WebAudio), em loop sem emenda, com timer para desligar sozinho.
- **Modo madrugada:** tema escuro automático entre 19h e 7h (ou no botão ☾), pensado para registrar sem acordar ninguém.
- **Cronômetro de contrações** (neste aparelho), para o grande dia: duração, intervalo e contagem da última hora.
- **Resumo do dia e dos últimos 7 dias**, linha do tempo e **resumo compartilhável para o pediatra**.
- **PWA de verdade:** `sw.js` guarda o app no aparelho e abre offline.

## Banco de dados (Supabase)

1. Rode `supabase/schema.sql` (tabelas, RLS e realtime).
2. Rode `supabase/schema_v2.sql` (tipos novos, medidas extras e a função de convite).
3. URL do projeto + chave pública (`anon`) ficam em `config.js` — é a chave feita para viver no app; quem protege os dados é o RLS. A chave `service_role` nunca entra no código.

## Como rodar

Sirva a pasta por HTTP (ex.: `python3 -m http.server 8000`) ou publique em qualquer hospedagem estática (GitHub Pages, Netlify, Vercel, Cloudflare Pages) e abra no celular: menu do navegador → “Adicionar à tela inicial”.

As janelas de sono são referências gerais para organizar a rotina, não orientação médica. Na dúvida, fale com o pediatra.
