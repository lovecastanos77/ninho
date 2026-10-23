// Ninho — diario do bebe (sono, mamada, fralda, peso e rotina)
// Funciona em dois modos: nuvem (Supabase, sincroniza o casal) e local (so neste aparelho).
// A configuracao (URL + chave publica) vem de config.js, carregado no index.html.

let createClient = null;
async function importSdk(url, ms) {
  let timer;
  try {
    return await Promise.race([
      import(url),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}
try {
  ({ createClient } = await importSdk('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm', 9000));
} catch {
  try { ({ createClient } = await importSdk('https://unpkg.com/@supabase/supabase-js@2/+esm', 9000)); }
  catch { createClient = null; }
}

const CFG = window.NINHO_CONFIG || {};
const sb = (createClient && CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY)
  ? createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY)
  : null;

const $ = (id) => document.getElementById(id);
const now = () => Date.now();
const iso = (ms) => new Date(ms).toISOString();
const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
const fmtTime = (ms) => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const fmtDur = (ms) => {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------- janelas de vigilia (min) por idade ----------------
// Referencia geral (mesma tabela publica usada por apps de sono): recem-nascido acorda pouco.
function wakeWindow(ageDays) {
  const w = ageDays / 7;
  if (w < 4) return [35, 60];
  if (w < 12) return [60, 90];
  if (w < 17) return [75, 120];
  if (w < 30) return [120, 180];
  if (w < 43) return [150, 210];
  if (w < 60) return [180, 240];
  return [240, 360];
}
function ageDaysOf(birthStr) {
  if (!birthStr) return 0;
  const b = new Date(`${birthStr}T12:00:00`);
  return Math.floor((now() - b.getTime()) / 86400000); // negativo = ainda nao nasceu
}
function ageLabel(birthStr) {
  const d = ageDaysOf(birthStr);
  if (d < -1) return `faltam ${-d} dias para nascer`;
  if (d === -1) return 'nasce amanhã ♡';
  if (d < 1) return 'nasceu hoje ♡';
  if (d < 30) return `${d} ${d === 1 ? 'dia' : 'dias'} de vida`;
  if (d < 60) return `${Math.floor(d / 7)} semanas de vida`;
  const m = Math.floor(d / 30.44);
  return `${m} ${m === 1 ? 'mês' : 'meses'} de vida`;
}

// ---------------- estado ----------------
const LOCAL_KEY = 'ninho-v2';
const state = {
  mode: 'local', // 'cloud' | 'local'
  user: null,
  family: null, // {id, name, invite_code}
  baby: null,   // {id, name, birth_date}
  events: [],   // forma unificada
  realtime: null,
};
const local = loadLocal();
function loadLocal() {
  try {
    const v = JSON.parse(localStorage.getItem(LOCAL_KEY));
    if (v && typeof v === 'object') return { profile: v.profile || { name: '', birth: '' }, events: Array.isArray(v.events) ? v.events : [], contractions: Array.isArray(v.contractions) ? v.contractions : [] };
  } catch { /* ignora */ }
  return { profile: { name: '', birth: '' }, events: [], contractions: [] };
}
function saveLocal() { try { localStorage.setItem(LOCAL_KEY, JSON.stringify(local)); } catch { /* ignora */ } }

// ---------------- camada de dados ----------------
function fromRow(r) {
  return {
    id: r.id, type: r.type,
    startsAt: new Date(r.starts_at).getTime(),
    endsAt: r.ends_at ? new Date(r.ends_at).getTime() : null,
    side: r.side || null, kind: r.kind || null,
    amountMl: r.amount_ml ?? null, weightKg: r.weight_kg ?? null,
    lengthCm: r.length_cm ?? null, headCm: r.head_cm ?? null, tempC: r.temp_c ?? null,
    note: r.note || null,
  };
}
function toRow(e) {
  return {
    baby_id: state.baby.id, type: e.type,
    starts_at: iso(e.startsAt), ends_at: e.endsAt ? iso(e.endsAt) : null,
    side: e.side || null, kind: e.kind || null,
    amount_ml: e.amountMl ?? null, weight_kg: e.weightKg ?? null,
    length_cm: e.lengthCm ?? null, head_cm: e.headCm ?? null, temp_c: e.tempC ?? null,
    note: e.note || null, created_by: state.user?.id || null,
  };
}
async function loadEvents() {
  if (state.mode === 'cloud') {
    const { data, error } = await sb.from('events').select('*').eq('baby_id', state.baby.id).order('starts_at', { ascending: false }).limit(500);
    if (error) { toast('Erro ao carregar registros.'); return; }
    state.events = data.map(fromRow);
  } else {
    state.events = [...local.events].sort((a, b) => b.startsAt - a.startsAt);
  }
  render();
}
async function addEvent(partial) {
  const e = { id: crypto.randomUUID(), startsAt: now(), endsAt: null, ...partial };
  if (state.mode === 'cloud') {
    const { data, error } = await sb.from('events').insert(toRow(e)).select().single();
    if (error) { toast(describeErr(error)); return null; }
    const row = fromRow(data);
    state.events.unshift(row);
    render();
    return row;
  }
  state.events.unshift(e);
  local.events = state.events;
  saveLocal(); render();
  return e;
}
async function updateEvent(id, patch) {
  const e = state.events.find((x) => x.id === id);
  if (!e) return;
  Object.assign(e, patch);
  if (state.mode === 'cloud') {
    const { error } = await sb.from('events').update(toRow(e)).eq('id', id);
    if (error) toast(describeErr(error));
  } else { local.events = state.events; saveLocal(); }
  render();
}
async function deleteEvent(id) {
  state.events = state.events.filter((x) => x.id !== id);
  if (state.mode === 'cloud') {
    const { error } = await sb.from('events').delete().eq('id', id);
    if (error) toast(describeErr(error));
  } else { local.events = state.events; saveLocal(); }
  render();
}
function describeErr(error) {
  const msg = String(error?.message || '');
  if (msg.includes('events_type_check') || msg.includes('check constraint')) {
    return 'Falta rodar o arquivo supabase/schema_v2.sql no Supabase para liberar este tipo de registro.';
  }
  if (msg.includes('length_cm') || msg.includes('temp_c')) return 'Falta rodar o supabase/schema_v2.sql no Supabase (colunas novas).';
  return 'Não foi possível salvar. Verifique a conexão.';
}

// ---------------- tema (modo madrugada) ----------------
function applyTheme() {
  const saved = localStorage.getItem('ninho-theme');
  const h = new Date().getHours();
  const dark = saved ? saved === 'dark' : (h >= 19 || h < 7);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('theme-toggle').textContent = dark ? '☀' : '☾';
}
$('theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('ninho-theme', next);
  applyTheme();
});

// ---------------- navegacao entre telas ----------------
function show(view) {
  for (const v of ['auth-view', 'setup-view', 'app-view']) $(v).hidden = v !== view;
  $('profile-button').style.visibility = view === 'app-view' ? 'visible' : 'hidden';
}
let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
}

// ---------------- autenticacao sem senha (link magico / codigo da familia) ----------------
$('auth-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!sb) { $('auth-error').textContent = 'A nuvem não está configurada neste aparelho.'; return; }
  const email = $('auth-email').value.trim();
  $('auth-error').textContent = ''; $('auth-info').textContent = '';
  $('auth-submit').textContent = 'Enviando…';
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.href.split('#')[0] },
  });
  $('auth-submit').textContent = 'Receber meu link de acesso';
  if (error) { $('auth-error').textContent = 'Não consegui enviar o link. Confira o e-mail e tente de novo.'; return; }
  $('auth-info').textContent = `Link enviado para ${email}! Abra o e-mail e toque no link — você entra direto, sem senha. Pode fechar esta tela.`;
});
async function ensureAnonSession() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) return true;
  const { error } = await sb.auth.signInAnonymously();
  if (error) {
    $('auth-error').textContent = 'A entrada por token ainda não foi ligada no Supabase (acesso anônimo). Use o link por e-mail por enquanto.';
    return false;
  }
  return true;
}
// O token fica salvo em DOIS lugares (localStorage + cookie de 1 ano):
// se o navegador limpar um, o outro devolve a entrada sem digitar de novo.
function saveToken(t) {
  try { localStorage.setItem('ninho-token', t); } catch { /* ignora */ }
  try { document.cookie = `ninho-token=${encodeURIComponent(t)}; max-age=${60 * 60 * 24 * 365}; path=/ninho/; SameSite=Lax`; } catch { /* ignora */ }
}
function readToken() {
  try { const v = localStorage.getItem('ninho-token'); if (v) return v; } catch { /* ignora */ }
  const m = document.cookie.match(/(?:^|; )ninho-token=([^;]*)/);
  return m ? decodeURIComponent(m[1]) : null;
}
function clearToken() {
  try { localStorage.removeItem('ninho-token'); localStorage.removeItem('ninho-pending-token'); } catch { /* ignora */ }
  try { document.cookie = 'ninho-token=; max-age=0; path=/ninho/; SameSite=Lax'; } catch { /* ignora */ }
}
// Entrada com o token da familia. Retorna: 'app' | 'setup' (token livre, 1o uso) | 'erro'
async function enterWithToken(token) {
  if (!sb) { $('auth-error').textContent = 'A nuvem não está configurada neste aparelho.'; return 'erro'; }
  if (!(await ensureAnonSession())) return 'erro';
  const { data: { user } } = await sb.auth.getUser();
  state.user = user; state.mode = 'cloud';
  const { data, error } = await sb.rpc('enter_with_token', { p_token: token });
  if (error) {
    $('auth-error').textContent = String(error.message).includes('enter_with_token')
      ? 'Falta rodar o supabase/schema_v3.sql no Supabase para o token funcionar.'
      : 'Token não encontrado. Confira os caracteres e tente de novo.';
    return 'erro';
  }
  if (!data) {
    // token existe, mas a familia ainda nao foi criada: guarda para vincular no cadastro
    localStorage.setItem('ninho-pending-token', token);
    show('setup-view');
    return 'setup';
  }
  state.family = data;
  saveToken(token);
  localStorage.removeItem('ninho-pending-token');
  const ok = await loadFamilyContext();
  if (ok) { await enterApp(); return 'app'; }
  show('setup-view');
  return 'setup';
}
$('token-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('auth-error').textContent = ''; $('auth-info').textContent = '';
  const token = $('access-token').value.trim();
  if (token) await enterWithToken(token);
});
$('setup-logout').addEventListener('click', logout);
$('btn-logout').addEventListener('click', logout);
async function logout() {
  if (state.realtime) { sb.removeChannel(state.realtime); state.realtime = null; }
  if (state.mode === 'cloud' && sb) await sb.auth.signOut();
  clearToken();
  state.user = null; state.family = null; state.baby = null; state.events = [];
  show('auth-view');
}

async function afterAuth() {
  const { data: { user } } = await sb.auth.getUser();
  state.user = user;
  state.mode = 'cloud';
  const ok = await loadFamilyContext();
  if (ok) { await enterApp(); } else { show('setup-view'); }
}
async function loadFamilyContext() {
  const { data: members, error } = await sb.from('family_members').select('family_id').eq('user_id', state.user.id).limit(1);
  if (error || !members?.length) return false;
  const familyId = members[0].family_id;
  const { data: fam } = await sb.from('families').select('*').eq('id', familyId).single();
  const { data: babies } = await sb.from('babies').select('*').eq('family_id', familyId).order('created_at').limit(1);
  if (!fam || !babies?.length) { state.family = fam || null; return false; }
  state.family = fam;
  state.baby = babies[0];
  return true;
}
$('family-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('setup-error').textContent = '';
  const name = $('setup-baby-name').value.trim();
  const birth = $('setup-baby-birth').value;
  if (!name || !birth) return;
  try {
    let familyId = state.family?.id;
    if (!familyId) {
      const { data: fam, error } = await sb.from('families').insert({ name: `Família ${name}`, created_by: state.user.id }).select().single();
      if (error) throw error;
      familyId = fam.id; state.family = fam;
    }
    const { data: baby, error: e2 } = await sb.from('babies').insert({ family_id: familyId, name, birth_date: birth }).select().single();
    if (e2) throw e2;
    state.baby = baby;
    // primeiro uso com token: vincula o token a esta familia para sempre
    const pending = localStorage.getItem('ninho-pending-token');
    if (pending) {
      const { error: e3 } = await sb.rpc('claim_token_family', { p_token: pending, p_family_id: familyId });
      if (!e3) saveToken(pending);
      localStorage.removeItem('ninho-pending-token');
    }
    await enterApp();
  } catch { $('setup-error').textContent = 'Não consegui salvar. Tente de novo.'; }
});
$('join-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('setup-error').textContent = '';
  const code = $('join-code').value.trim();
  if (!code) return;
  const { data, error } = await sb.rpc('join_family_by_code', { p_code: code });
  if (error) {
    $('setup-error').textContent = String(error.message).includes('join_family_by_code')
      ? 'Falta rodar o supabase/schema_v2.sql no Supabase para o convite funcionar.'
      : 'Código não encontrado. Confira e tente de novo.';
    return;
  }
  state.family = data;
  const ok = await loadFamilyContext();
  if (ok) { await enterApp(); } else { toast('Você entrou na família! Agora cadastre o bebê aqui em cima.'); }
});

function enterLocal() {
  state.mode = 'local';
  state.user = null;
  state.baby = { id: 'local', name: local.profile.name || 'Meu bebê', birth_date: local.profile.birth || '' };
  state.family = null;
  state.events = [...local.events].sort((a, b) => b.startsAt - a.startsAt);
  show('app-view');
  render();
}
async function enterApp() {
  show('app-view');
  await loadEvents();
  subscribeRealtime();
}
function subscribeRealtime() {
  if (state.mode !== 'cloud' || !sb || state.realtime) return;
  state.realtime = sb.channel('ninho-events')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'events', filter: `baby_id=eq.${state.baby.id}` }, () => { loadEvents(); })
    .subscribe();
}
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// ---------------- dica do dia (conteudo original, por fase) ----------------
const TIPS = {
  pre: [
    ['A mala da maternidade', 'Deixe pronta perto da porta: documentos, roupas para você e a primeira roupinha dele. Na hora H, ninguém pensa direito — a mala pensa por vocês.'],
    ['Combinem os turnos antes', 'Conversar agora sobre quem levanta em cada mamada da madrugada evita desgaste quando o sono apertar.'],
    ['O berço seguro', 'Colchão firme e nada dentro do berço: sem travesseiro, cobertas soltas ou bichinhos. Bebê dorme de barriga para cima.'],
    ['Comida fácil congelada', 'Algumas refeições prontas no freezer valem ouro nos primeiros dias em casa.'],
    ['Rede de apoio sem cerimônia', 'Escolham 2 ou 3 pessoas para chamar a qualquer hora nas primeiras semanas — e avisem elas desde já.'],
    ['Conheçam o caminho', 'Testem o trajeto até a maternidade e quanto tempo leva, inclusive pensando no trânsito de madrugada.'],
  ],
  rn: [
    ['Sono seguro, sempre', 'Para dormir: de barriga para cima, em superfície firme (berço ou moisés), sem objetos soltos por perto.'],
    ['Fome aparece antes do choro', 'Mãozinha na boca, cabeça virando à procura e inquietação são sinais precoces. Choro é o sinal tardio.'],
    ['Barriguinha todo dia', 'Um pouquinho de tummy time com ele acordado e você junto fortalece pescoço e costas. Use o botão Barriguinha do app.'],
    ['Cólica tem hora marcada', 'Costuma piorar no fim da tarde. Colo, embalo, som de útero e paciência ajudam — e essa fase passa.'],
    ['14 a 19 horas de sono', 'Recém-nascido dorme muito, mas em pedacinhos curtos. Dormir no colo no começo é normal e esperado.'],
    ['Temperatura: fiquem de olho', 'Nos primeiros 3 meses, temperatura de 37,8 °C ou mais merece uma ligação para o pediatra no mesmo dia.'],
    ['Vitamina D', 'Costuma ser diária no primeiro ano. Confirme dose e horário com o pediatra — e registre no botão Remédio para não esquecer.'],
  ],
  geral: [
    ['Ordem vale mais que horário', 'Uma sequência previsível (banho → mamada → sono) acalma mais do que perseguir o relógio.'],
    ['Luz de dia, escuro de noite', 'Claridade de manhã e casa escurecida à noite ajudam o relógio do corpo dele a se formar.'],
    ['Registrem sem perfeição', 'O diário serve para enxergar padrões e ajudar vocês dois — nunca para cobrar perfeição de pai e mãe de primeira viagem.'],
  ],
};
function renderTip(birth) {
  const age = ageDaysOf(birth);
  const pool = !birth ? TIPS.geral : age < 0 ? TIPS.pre : age <= 90 ? [...TIPS.rn, ...TIPS.geral] : TIPS.geral;
  const idx = Math.floor(Date.now() / 86400000) % pool.length;
  const [title, text] = pool[idx];
  $('tip-title').textContent = title;
  $('tip-text').textContent = text;
}

// ---------------- renderizacao ----------------
const ICONS = { sleep: '☾', feeding: '🍼', diaper: '✦', weight: '⚖', temperature: '🌡', tummy: '🐢', bath: '🛁', medicine: '💊', note: '✎' };
function activeOf(type, kind) {
  return state.events.find((e) => e.type === type && (kind === undefined || e.kind === kind) && !e.endsAt) || null;
}
function isFeed(e) { return e.type === 'feeding' && (e.kind === 'breast' || e.kind === 'bottle'); }
function eventLabel(e) {
  switch (e.type) {
    case 'sleep': return 'Sono';
    case 'feeding':
      if (e.kind === 'breast') return `Peito ${e.side === 'right' ? 'direito' : 'esquerdo'}`;
      if (e.kind === 'pump') return `Ordenha${e.amountMl ? ` · ${e.amountMl} ml` : ''}`;
      return `Mamadeira${e.amountMl ? ` · ${e.amountMl} ml` : ''}`;
    case 'diaper': return `Fralda · ${e.kind === 'wet' ? 'xixi' : e.kind === 'dirty' ? 'cocô' : 'os dois'}`;
    case 'weight': {
      const extras = [e.lengthCm ? `${e.lengthCm} cm` : '', e.headCm ? `PC ${e.headCm} cm` : ''].filter(Boolean).join(' · ');
      return `Peso ${e.weightKg ? `${String(e.weightKg).replace('.', ',')} kg` : ''}${extras ? ` · ${extras}` : ''}`;
    }
    case 'temperature': return `Temperatura ${e.tempC ? `${String(e.tempC).replace('.', ',')} °C` : ''}`;
    case 'tummy': return 'Barriguinha (tummy time)';
    case 'bath': return 'Banho';
    case 'medicine': return `Remédio${e.note ? ` · ${esc(e.note)}` : ''}`;
    default: return e.note || 'Nota';
  }
}
function eventWhen(e) {
  const end = e.endsAt ? ` – ${fmtTime(e.endsAt)}` : ' · em andamento';
  const dur = e.endsAt ? ` · ${fmtDur(e.endsAt - e.startsAt)}` : ` · ${fmtDur(now() - e.startsAt)} até agora`;
  return `${fmtTime(e.startsAt)}${end}${dur}`;
}
function render() {
  if (!state.baby) return;
  const baby = state.baby;
  const birth = baby.birth_date || '';
  const hours = new Date().getHours();
  const greet = hours < 6 ? 'Boa madrugada' : hours < 12 ? 'Bom dia' : hours < 18 ? 'Boa tarde' : 'Boa noite';
  $('greeting-title').innerHTML = `${greet}, <em>família.</em>`;
  $('today-label').textContent = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }).toUpperCase();
  $('baby-age').textContent = birth ? `${baby.name} · ${ageLabel(birth)}` : `${baby.name}`;
  $('profile-label').textContent = baby.name || 'Meu bebê';
  $('sync-note').textContent = state.mode === 'cloud' ? 'Sincronizado ☁ ✦' : 'Neste aparelho ✦';

  const todayK = dayKey(now());
  const todays = state.events.filter((e) => dayKey(e.startsAt) === todayK);
  const sleepMs = todays.filter((e) => e.type === 'sleep').reduce((acc, e) => acc + ((e.endsAt || now()) - e.startsAt), 0);
  $('total-sleep').textContent = fmtDur(sleepMs);
  $('total-feeds').textContent = todays.filter(isFeed).length;
  $('total-diapers').textContent = todays.filter((e) => e.type === 'diaper').length;

  const feeds = state.events.filter(isFeed);
  const lastFeed = feeds[0];
  $('last-feed').textContent = lastFeed ? `Última mamada: ${fmtTime(lastFeed.startsAt)} · ${eventLabel(lastFeed)}` : 'Última mamada: —';
  const lastBreast = state.events.find((e) => e.type === 'feeding' && e.kind === 'breast');
  $('next-breast').textContent = lastBreast ? `Próximo peito sugerido: ${lastBreast.side === 'left' ? 'direito' : 'esquerdo'}` : '';

  // alerta de mamada (recém-nascido: a cada ~3h)
  const alert = $('feed-alert');
  const age = ageDaysOf(birth);
  if (lastFeed && age >= 0 && age < 90 && now() - lastFeed.startsAt > 3 * 3600000 && !activeOf('feeding', 'breast')) {
    alert.hidden = false;
    alert.textContent = `⏰ Já faz ${fmtDur(now() - lastFeed.startsAt)} desde a última mamada. Para recém-nascido, o ritmo costuma ser a cada 2–3h — vale observar os sinais de fome.`;
  } else { alert.hidden = true; }

  renderNextNap(birth);
  renderBars();
  renderTimeline();
  renderButtons();
  renderSettings();
  renderTip(birth);
}
function renderNextNap(birth) {
  const box = $('next-content');
  const agePre = ageDaysOf(birth);
  if (birth && agePre < 0) {
    box.innerHTML = `<p class="next-time">${agePre === -1 ? 'Amanhã ♡' : `Faltam ${-agePre} dias`}</p><p class="muted">para o grande dia · data prevista ${new Date(`${birth}T12:00:00`).toLocaleDateString('pt-BR')}</p>`;
    $('window-progress').style.width = '0%';
    $('window-note').textContent = 'O cronômetro de contrações, aqui embaixo, já está pronto para quando começar.';
    return;
  }
  const sleeping = activeOf('sleep');
  if (sleeping) {
    box.innerHTML = `<p class="next-time">Dormindo ☾</p><p class="muted">há ${fmtDur(now() - sleeping.startsAt)}</p>`;
    $('window-progress').style.width = '100%';
    $('window-note').textContent = 'Toque em “Sono” para encerrar quando acordar.';
    return;
  }
  const age = ageDaysOf(birth);
  const [lo, hi] = wakeWindow(age);
  const lastSleep = state.events.find((e) => e.type === 'sleep' && e.endsAt);
  if (!lastSleep) {
    box.innerHTML = `<p class="next-time">${lo}–${hi} min</p><p class="muted">acordado entre sonecas, para esta idade</p>`;
    $('window-progress').style.width = '0%';
    $('window-note').textContent = 'Registre o primeiro descanso para a estimativa ficar pessoal.';
    return;
  }
  let adjLo = lo; let adjHi = hi;
  const napDur = (lastSleep.endsAt - lastSleep.startsAt) / 60000;
  if (napDur > 0 && napDur < 40) { adjLo = Math.max(20, lo - 15); adjHi = Math.max(adjLo + 10, hi - 15); }
  const awake = now() - lastSleep.endsAt;
  const from = new Date(lastSleep.endsAt + adjLo * 60000);
  const to = new Date(lastSleep.endsAt + adjHi * 60000);
  box.innerHTML = `<p class="next-time">${fmtTime(from.getTime())} – ${fmtTime(to.getTime())}</p><p class="muted">acordado há ${fmtDur(awake)} · janela de ${adjLo}–${adjHi} min${napDur < 40 ? ' (soneca curta: janela encurtada)' : ''}</p>`;
  $('window-progress').style.width = `${Math.min(100, Math.max(0, (awake / (adjHi * 60000)) * 100))}%`;
  $('window-note').textContent = awake > adjHi * 60000 ? 'A janela estimada já passou — observe os sinais de sono.' : 'Uma estimativa gentil para organizar o dia.';
}
function renderBars() {
  const bars = $('mini-bars');
  bars.innerHTML = '';
  const totals = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - i);
    const k = dayKey(d.getTime());
    const ms = state.events.filter((e) => e.type === 'sleep' && dayKey(e.startsAt) === k).reduce((a, e) => a + ((e.endsAt || now()) - e.startsAt), 0);
    totals.push(ms);
  }
  const max = Math.max(...totals, 3600000);
  totals.forEach((ms, i) => {
    const s = document.createElement('span');
    s.style.height = `${Math.max(7, (ms / max) * 100)}%`;
    if (i === 6) s.className = 'today';
    s.title = fmtDur(ms);
    bars.appendChild(s);
  });
}
function renderTimeline() {
  const box = $('timeline');
  const list = state.events.slice(0, 30);
  if (!list.length) {
    box.innerHTML = '<div class="empty-state"><span>✦</span>Nenhum registro ainda. Toque em um botão acima para começar.</div>';
    return;
  }
  box.innerHTML = list.map((e) => `
    <div class="entry">
      <span class="entry-icon">${ICONS[e.type] || '✦'}</span>
      <div class="entry-main"><strong>${eventLabel(e)}</strong><small>${new Date(e.startsAt).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} · ${eventWhen(e)}</small></div>
      <button class="delete-button" data-del="${e.id}" aria-label="Excluir registro">×</button>
    </div>`).join('');
  box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => deleteEvent(b.dataset.del)));
}
function renderSettings() {
  const growth = state.events.find((e) => e.type === 'weight');
  $('growth-info').textContent = growth ? `Última pesagem: ${eventLabel(growth)} · ${new Date(growth.startsAt).toLocaleDateString('pt-BR')}` : '';
  if (state.mode === 'cloud' && state.family) {
    $('family-info').textContent = `${state.family.name}${state.user?.email ? ` · conta ${state.user.email}` : ''}`;
    $('invite-code').textContent = state.family.invite_code || '—';
  } else {
    $('family-info').textContent = 'Modo neste aparelho (sem sincronização).';
    $('invite-code').textContent = '—';
  }
  $('token-info').textContent = readToken()
    ? '🔑 Este aparelho entra automaticamente com o token da família.'
    : '';
}
function markBtn(id, active, label) {
  const b = $(id);
  b.classList.toggle('is-active', !!active);
  if (label) b.dataset.label = label;
}
function renderButtons() {
  const sleep = activeOf('sleep');
  $('btn-sleep').innerHTML = sleep ? `<span>■</span> Sono · ${fmtDur(now() - sleep.startsAt)}` : '<span>☾</span> Sono';
  $('btn-sleep').classList.toggle('is-active', !!sleep);
  for (const [id, side] of [['btn-breast-left', 'left'], ['btn-breast-right', 'right']]) {
    const act = state.events.find((e) => e.type === 'feeding' && e.kind === 'breast' && e.side === side && !e.endsAt);
    $(id).innerHTML = act ? `<span>■</span> ${side === 'left' ? 'Esq.' : 'Dir.'} · ${fmtDur(now() - act.startsAt)}` : `<span>${side === 'left' ? '◐' : '◑'}</span> Peito ${side === 'left' ? 'esquerdo' : 'direito'}`;
    $(id).classList.toggle('is-active', !!act);
  }
  const tummy = activeOf('tummy');
  $('btn-tummy').innerHTML = tummy ? `<span>■</span> Barriguinha · ${fmtDur(now() - tummy.startsAt)}` : '<span>🐢</span> Barriguinha';
  $('btn-tummy').classList.toggle('is-active', !!tummy);
  const actives = state.events.filter((e) => !e.endsAt);
  $('active-timers-label').textContent = actives.length ? `${actives.length} cronômetro(s) rodando` : '';
}

// ---------------- acoes de registro ----------------
async function toggleTimer(type, kind, side) {
  const existing = state.events.find((e) => e.type === type && (kind === undefined || e.kind === kind) && (side === undefined || e.side === side) && !e.endsAt);
  if (existing) { await updateEvent(existing.id, { endsAt: now() }); return; }
  if (type === 'feeding' && kind === 'breast') {
    const other = state.events.find((e) => e.type === 'feeding' && e.kind === 'breast' && !e.endsAt);
    if (other) await updateEvent(other.id, { endsAt: now() });
  }
  if (type === 'sleep') {
    const feed = state.events.find((e) => e.type === 'feeding' && e.kind === 'breast' && !e.endsAt);
    if (feed) await updateEvent(feed.id, { endsAt: now() });
  }
  await addEvent({ type, kind: kind || null, side: side || null, endsAt: null });
}
$('btn-sleep').addEventListener('click', () => toggleTimer('sleep'));
$('btn-breast-left').addEventListener('click', () => toggleTimer('feeding', 'breast', 'left'));
$('btn-breast-right').addEventListener('click', () => toggleTimer('feeding', 'breast', 'right'));
$('btn-tummy').addEventListener('click', () => toggleTimer('tummy'));
for (const [id, kind] of [['btn-diaper-wet', 'wet'], ['btn-diaper-dirty', 'dirty'], ['btn-diaper-both', 'both']]) {
  $(id).addEventListener('click', async () => { await addEvent({ type: 'diaper', kind, endsAt: now() }); toast('Fralda registrada ✓'); });
}
$('btn-bath').addEventListener('click', async () => { await addEvent({ type: 'bath', endsAt: now() }); toast('Banho registrado ✓'); });

// formulario rapido (dialog)
let quickSubmit = null;
function openQuick(title, fieldsHtml, onSubmit) {
  $('quick-title').textContent = title;
  $('quick-fields').innerHTML = fieldsHtml;
  $('quick-error').textContent = '';
  quickSubmit = onSubmit;
  $('quick-dialog').showModal();
}
$('quick-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!quickSubmit) return;
  const values = {};
  $('quick-fields').querySelectorAll('input, select, textarea').forEach((el) => { values[el.name] = el.value; });
  const ok = await quickSubmit(values);
  if (ok !== false) $('quick-dialog').close();
});
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => $(b.dataset.close).close()));
const numField = (name, label, step, ph) => `<label>${label}<input name="${name}" type="number" step="${step}" inputmode="decimal" placeholder="${ph || ''}"></label>`;
$('btn-bottle').addEventListener('click', () => openQuick('Mamadeira', numField('ml', 'Quantidade (ml)', '1', 'Ex.: 60'), async (v) => {
  await addEvent({ type: 'feeding', kind: 'bottle', amountMl: v.ml ? Number(v.ml) : null, endsAt: now() });
  toast('Mamadeira registrada ✓');
}));
$('btn-pump').addEventListener('click', () => openQuick('Ordenha', `${numField('ml', 'Quantidade ordenhada (ml)', '1', 'Ex.: 80')}<label>Lado<select name="side"><option value="">Os dois</option><option value="left">Esquerdo</option><option value="right">Direito</option></select></label>`, async (v) => {
  await addEvent({ type: 'feeding', kind: 'pump', amountMl: v.ml ? Number(v.ml) : null, side: v.side || null, endsAt: now() });
  toast('Ordenha registrada ✓');
}));
$('btn-weight').addEventListener('click', () => openQuick('Peso e medidas', `${numField('kg', 'Peso (kg)', '0.01', 'Ex.: 3,45')}${numField('len', 'Comprimento (cm)', '0.1', 'Ex.: 50,5')}${numField('head', 'Perímetro cefálico (cm)', '0.1', 'Ex.: 35,0')}`, async (v) => {
  if (!v.kg && !v.len && !v.head) { $('quick-error').textContent = 'Preencha pelo menos uma medida.'; return false; }
  await addEvent({ type: 'weight', weightKg: v.kg ? Number(v.kg) : null, lengthCm: v.len ? Number(v.len) : null, headCm: v.head ? Number(v.head) : null, endsAt: now() });
  toast('Medidas registradas ✓');
}));
$('btn-temp').addEventListener('click', () => openQuick('Temperatura', `${numField('temp', 'Temperatura (°C)', '0.1', 'Ex.: 37,2')}<label>Observação (opcional)<input name="note" maxlength="80" placeholder="Ex.: depois do banho"></label>`, async (v) => {
  if (!v.temp) { $('quick-error').textContent = 'Informe a temperatura.'; return false; }
  await addEvent({ type: 'temperature', tempC: Number(v.temp), note: v.note || null, endsAt: now() });
  toast('Temperatura registrada ✓');
}));
$('btn-medicine').addEventListener('click', () => openQuick('Remédio / vitamina', `<label>Nome e dose<input name="note" maxlength="80" required placeholder="Ex.: Vitamina D · 1 gota"></label>`, async (v) => {
  await addEvent({ type: 'medicine', note: v.note || null, endsAt: now() });
  toast('Remédio registrado ✓');
}));
$('btn-manual').addEventListener('click', () => openQuick('Registro manual',
  `<label>Tipo<select name="type"><option value="sleep">Sono</option><option value="feeding">Mamada (mamadeira)</option><option value="diaper">Fralda</option><option value="bath">Banho</option><option value="note">Nota</option></select></label>
   <label>Começou<input name="start" type="datetime-local" required></label>
   <label>Terminou (só para sono/mamada)<input name="end" type="datetime-local"></label>
   <label>Observação<input name="note" maxlength="120"></label>`, async (v) => {
  const start = new Date(v.start).getTime();
  if (!Number.isFinite(start)) { $('quick-error').textContent = 'Informe o horário.'; return false; }
  const end = v.end ? new Date(v.end).getTime() : start;
  const base = { type: v.type, startsAt: start, endsAt: end, note: v.note || null };
  if (v.type === 'feeding') base.kind = 'bottle';
  if (v.type === 'diaper') base.kind = 'wet';
  await addEvent(base);
  toast('Registro salvo ✓');
}));

// ---------------- perfil do bebe ----------------
$('profile-button').addEventListener('click', () => {
  if (!state.baby) return;
  $('baby-name').value = state.baby.name || '';
  $('baby-birth').value = state.baby.birth_date || '';
  $('profile-dialog').showModal();
});
$('profile-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const name = $('baby-name').value.trim();
  const birth = $('baby-birth').value;
  if (!name || !birth) return;
  if (state.mode === 'cloud') {
    const { error } = await sb.from('babies').update({ name, birth_date: birth }).eq('id', state.baby.id);
    if (error) { toast('Não consegui salvar o perfil.'); return; }
  } else {
    local.profile = { name, birth }; saveLocal();
  }
  state.baby.name = name; state.baby.birth_date = birth;
  $('profile-dialog').close();
  render();
});

// ---------------- compartilhar resumo (pediatra) ----------------
$('btn-export').addEventListener('click', async () => {
  if (!state.baby) return;
  const lines = [`Resumo do Ninho — ${state.baby.name} (${ageLabel(state.baby.birth_date)})`, ''];
  for (let i = 0; i < 7; i++) {
    const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - i);
    const k = dayKey(d.getTime());
    const evs = state.events.filter((e) => dayKey(e.startsAt) === k);
    const sleep = evs.filter((e) => e.type === 'sleep').reduce((a, e) => a + ((e.endsAt || now()) - e.startsAt), 0);
    lines.push(`${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}: sono ${fmtDur(sleep)} · ${evs.filter(isFeed).length} mamadas · ${evs.filter((e) => e.type === 'diaper').length} fraldas`);
  }
  const w = state.events.find((e) => e.type === 'weight');
  if (w) lines.push('', `Última pesagem: ${eventLabel(w)} (${new Date(w.startsAt).toLocaleDateString('pt-BR')})`);
  const text = lines.join('\n');
  try {
    if (navigator.share) { await navigator.share({ title: 'Resumo do bebê', text }); }
    else { await navigator.clipboard.writeText(text); toast('Resumo copiado ✓'); }
  } catch { /* usuário cancelou */ }
});

// ---------------- sons para dormir (WebAudio, loop sem emenda) ----------------
let audioCtx = null; let soundSrc = null; let soundGain = null; let soundTimer = null;
let soundOscs = []; let chirpTimer = null; let melodyTimer = null; let soundOn = false;
function makeNoiseBuffer(type) {
  const len = audioCtx.sampleRate * 4;
  const buffer = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0; let b0 = 0; let b1 = 0; let b2 = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    if (type === 'brown') { last = (last + 0.02 * white) / 1.02; data[i] = last * 3.2; }
    else if (type === 'pink') { b0 = 0.997 * b0 + 0.029 * white; b1 = 0.985 * b1 + 0.032 * white; b2 = 0.95 * b2 + 0.048 * white; data[i] = (b0 + b1 + b2 + white * 0.05) * 1.5; }
    else data[i] = white * 0.6;
  }
  // normaliza o pico para o som sair cheio em qualquer alto-falante (o grave some nos fraquinhos)
  let peak = 0;
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(data[i]));
  if (peak > 0) { const scale = 0.95 / peak; for (let i = 0; i < len; i++) data[i] *= scale; }
  // costura do loop: desvanecer as pontas uma na outra para nao clicar
  const fade = Math.floor(audioCtx.sampleRate * 0.08);
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    const tail = data[len - fade + i];
    data[i] = data[i] * t + tail * (1 - t);
  }
  return buffer;
}
function stopSound() {
  soundOn = false;
  if (soundSrc) { try { soundSrc.stop(); } catch { /* ja parado */ } soundSrc = null; }
  for (const o of soundOscs) { try { o.stop(); } catch { /* idem */ } }
  soundOscs = [];
  clearTimeout(soundTimer); clearTimeout(chirpTimer); clearTimeout(melodyTimer);
  $('btn-sound').textContent = '▶ Tocar som';
}
function noiseSource(bufferType) {
  const src = audioCtx.createBufferSource();
  src.buffer = makeNoiseBuffer(bufferType);
  src.loop = true;
  return src;
}
function addLfo(freq, depth, target) {
  const lfo = audioCtx.createOscillator();
  const d = audioCtx.createGain();
  d.gain.value = depth;
  lfo.frequency.value = freq;
  lfo.connect(d).connect(target);
  lfo.start();
  soundOscs.push(lfo);
  return lfo;
}
const NOTES = { G3: 196, C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392, A4: 440, B4: 493.88, C5: 523.25 };
const SONGS = {
  // Tema que Mozart usou nas suas 12 Variacoes (a nossa "Brilha, brilha, estrelinha")
  'music-twinkle': [['C4', 1], ['C4', 1], ['G4', 1], ['G4', 1], ['A4', 1], ['A4', 1], ['G4', 2], ['F4', 1], ['F4', 1], ['E4', 1], ['E4', 1], ['D4', 1], ['D4', 1], ['C4', 2], ['G4', 1], ['G4', 1], ['F4', 1], ['F4', 1], ['E4', 1], ['E4', 1], ['D4', 2], ['G4', 1], ['G4', 1], ['F4', 1], ['F4', 1], ['E4', 1], ['E4', 1], ['D4', 2], ['C4', 1], ['C4', 1], ['G4', 1], ['G4', 1], ['A4', 1], ['A4', 1], ['G4', 2], ['F4', 1], ['F4', 1], ['E4', 1], ['E4', 1], ['D4', 1], ['D4', 1], ['C4', 2]],
  'music-jacques': [['C4', 1], ['D4', 1], ['E4', 1], ['C4', 1], ['C4', 1], ['D4', 1], ['E4', 1], ['C4', 1], ['E4', 1], ['F4', 1], ['G4', 2], ['E4', 1], ['F4', 1], ['G4', 2], ['G4', .5], ['A4', .5], ['G4', .5], ['F4', .5], ['E4', 1], ['C4', 1], ['G4', .5], ['A4', .5], ['G4', .5], ['F4', .5], ['E4', 1], ['C4', 1], ['C4', 1], ['G3', 1], ['C4', 2], ['C4', 1], ['G3', 1], ['C4', 2]],
};
function pling(freq, durSec) {
  const t = audioCtx.currentTime;
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.5, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.7, durSec * 2.1));
  const o1 = audioCtx.createOscillator(); o1.type = 'sine'; o1.frequency.value = freq;
  const o2 = audioCtx.createOscillator(); o2.type = 'sine'; o2.frequency.value = freq * 4;
  const g2 = audioCtx.createGain(); g2.gain.value = 0.16;
  o1.connect(g); o2.connect(g2).connect(g); g.connect(soundGain);
  o1.start(t); o2.start(t);
  const stopAt = t + Math.max(0.8, durSec * 2.2);
  o1.stop(stopAt); o2.stop(stopAt);
}
function startSound() {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended' || audioCtx.state === 'interrupted') audioCtx.resume();
  const type = $('sound-type').value;
  const vol = Number($('sound-volume').value) / 100;
  soundGain = audioCtx.createGain();
  soundGain.gain.value = vol;
  soundGain.connect(audioCtx.destination);
  soundOn = true;
  if (type === 'brown' || type === 'pink' || type === 'white') {
    soundSrc = noiseSource(type);
    if (type === 'brown') {
      const filter = audioCtx.createBiquadFilter();
      filter.type = 'lowpass'; filter.frequency.value = 480;
      soundSrc.connect(filter).connect(soundGain);
      addLfo(0.13, vol * 0.22, soundGain.gain);
    } else {
      soundSrc.connect(soundGain);
    }
    soundSrc.start();
  } else if (type === 'sea') {
    // mar: chiado suave com filtro e volume balancando devagar, como ondas
    soundSrc = noiseSource('pink');
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass'; filter.frequency.value = 620;
    const waves = audioCtx.createGain(); waves.gain.value = 0.72;
    soundSrc.connect(filter).connect(waves).connect(soundGain);
    addLfo(0.075, 330, filter.frequency);
    addLfo(0.075, 0.26, waves.gain);
    soundSrc.start();
  } else if (type === 'forest') {
    // mata: brisa bem baixinha + passarinhos sintetizados de vez em quando
    soundSrc = noiseSource('pink');
    const breeze = audioCtx.createGain(); breeze.gain.value = 0.32;
    soundSrc.connect(breeze).connect(soundGain);
    soundSrc.start();
    const chirp = () => {
      if (!soundOn) return;
      const t = audioCtx.currentTime;
      const o = audioCtx.createOscillator(); o.type = 'sine';
      const g = audioCtx.createGain();
      const f0 = 2100 + Math.random() * 900;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f0 * 1.35, t + 0.07);
      o.frequency.exponentialRampToValueAtTime(f0 * 0.92, t + 0.16);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.09, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      o.connect(g).connect(soundGain);
      o.start(t); o.stop(t + 0.25);
      chirpTimer = setTimeout(chirp, 1100 + Math.random() * 2800);
    };
    chirpTimer = setTimeout(chirp, 700);
  } else if (SONGS[type]) {
    const song = SONGS[type];
    let stepIdx = 0;
    const step = () => {
      if (!soundOn) return;
      const [note, beats] = song[stepIdx];
      pling(NOTES[note], beats * 0.46);
      const last = stepIdx === song.length - 1;
      stepIdx = (stepIdx + 1) % song.length;
      melodyTimer = setTimeout(step, beats * 460 + (last ? 1400 : 0));
    };
    step();
  }
  $('btn-sound').textContent = '■ Parar som';
  const mins = Number($('sound-timer').value);
  if (mins > 0) soundTimer = setTimeout(stopSound, mins * 60000);
}
$('btn-sound').addEventListener('click', () => {
  try {
    if (soundOn) { stopSound(); return; }
    startSound();
  } catch { toast('Não consegui tocar o som neste navegador. Tente de novo ou use outro navegador.'); }
});
$('sound-type').addEventListener('change', () => { if (soundOn) { stopSound(); try { startSound(); } catch { toast('Não consegui trocar o som.'); } } });
$('sound-volume').addEventListener('input', () => { if (soundGain) soundGain.gain.value = Number($('sound-volume').value) / 100; });

// ---------------- contracoes (neste aparelho) ----------------
let contractionActive = null;
function renderContractions() {
  const list = local.contractions;
  const btn = $('btn-contraction');
  if (contractionActive) {
    btn.textContent = `■ Encerrar contração · ${fmtDur(now() - contractionActive.start)}`;
    btn.classList.add('is-active');
  } else { btn.textContent = '▶ Começou uma contração'; btn.classList.remove('is-active'); }
  if (!list.length && !contractionActive) { $('contraction-summary').textContent = 'Nenhuma contração registrada neste aparelho.'; $('contraction-list').innerHTML = ''; return; }
  const oneHour = list.filter((c) => now() - c.start < 3600000);
  $('contraction-summary').textContent = `${list.length} no total · ${oneHour.length} na última hora. Regra de bolso: contrações a cada ~5 min, durando ~1 min, por 1 hora = hora de ir para a maternidade (confirme com seu médico).`;
  $('contraction-list').innerHTML = list.slice(-8).reverse().map((c, idx, arr) => {
    const prev = list[list.length - 1 - idx - 1];
    const interval = prev ? fmtDur(c.start - prev.start) : '—';
    return `<div class="contraction-row"><span>${fmtTime(c.start)}</span><span>duração ${fmtDur(c.end - c.start)}</span><span>intervalo ${interval}</span></div>`;
  }).join('');
}
$('btn-contraction').addEventListener('click', () => {
  if (!contractionActive) { contractionActive = { start: now() }; }
  else {
    local.contractions.push({ start: contractionActive.start, end: now() });
    if (local.contractions.length > 200) local.contractions = local.contractions.slice(-200);
    saveLocal(); contractionActive = null;
  }
  renderContractions();
});
$('btn-contraction-clear').addEventListener('click', () => { local.contractions = []; contractionActive = null; saveLocal(); renderContractions(); });

// ---------------- botao instalar no celular ----------------
let deferredInstall = null;
function showInstallButtons() {
  document.querySelectorAll('.btn-install').forEach((b) => { b.hidden = false; });
}
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; showInstallButtons(); });
window.addEventListener('appinstalled', () => {
  deferredInstall = null;
  document.querySelectorAll('.btn-install').forEach((b) => { b.hidden = true; });
  toast('Ninho instalado ✓ Procure o ícone na tela inicial.');
});
if (/iphone|ipad/i.test(navigator.userAgent) && !window.navigator.standalone) showInstallButtons();
document.querySelectorAll('.btn-install').forEach((b) => b.addEventListener('click', async () => {
  if (deferredInstall) {
    deferredInstall.prompt();
    await deferredInstall.userChoice;
    deferredInstall = null;
  } else {
    document.querySelectorAll('.install-help').forEach((p) => { p.hidden = false; });
  }
}));

// ---------------- relogio e inicio ----------------
setInterval(() => {
  if (!$('app-view').hidden && state.baby) render();
  if (!$('app-view').hidden) renderContractions();
}, 30000);
applyTheme();
renderContractions();
(async function boot() {
  // Mostra a tela de entrada NA HORA: a rede (sessao/token) decide depois se troca de tela.
  show('auth-view');
  window.__ninhoBooted = true;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('local') === '1') { enterLocal(); return; } // atalho interno de testes
    if (sb) {
      const { data: { session } } = await sb.auth.getSession();
      if (session) { await afterAuth(); return; }
      const urlToken = params.get('token');
      const savedToken = urlToken || readToken();
      if (savedToken) {
        const r = await enterWithToken(savedToken);
        if (r !== 'erro') return;
      }
    } else {
      $('auth-error').textContent = 'A conexão com a nuvem demorou para carregar. Recarregue a página.';
    }
  } catch {
    show('auth-view');
  }
})();
