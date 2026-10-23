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
  ({ createClient } = await importSdk('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.1/+esm', 9000));
} catch {
  try { ({ createClient } = await importSdk('https://esm.run/@supabase/supabase-js@2.49.1', 9000)); }
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
  $('bottom-nav').hidden = view !== 'app-view';
  document.body.classList.toggle('has-bnav', view === 'app-view');
}

// ---------------- abas (menu inferior) ----------------
const appPanels = {};
let appTab = 'hoje';
(function buildPanels() {
  const main = $('app-view');
  const mk = (id, hidden) => { const d = document.createElement('div'); d.id = id; d.className = 'tab-panel'; d.hidden = hidden; return d; };
  appPanels.hoje = mk('panel-hoje', false);
  appPanels.crescimento = mk('panel-crescimento', true);
  appPanels.caderneta = mk('panel-caderneta', true);
  const kids = [...main.children];
  const first = kids.find((el) => !el.classList.contains('greeting'));
  for (const p of [appPanels.hoje, appPanels.crescimento, appPanels.caderneta]) main.insertBefore(p, first || null);
  for (const el of kids) {
    if (el.classList.contains('greeting')) continue;
    if (el.classList.contains('growth-card') || el.classList.contains('measure-card')) appPanels.crescimento.appendChild(el);
    else if (el.classList.contains('health-card')) appPanels.caderneta.appendChild(el);
    else appPanels.hoje.appendChild(el);
  }
})();
function setTab(name) {
  appTab = name;
  for (const [k, p] of Object.entries(appPanels)) p.hidden = k !== name;
  document.querySelectorAll('[data-apptab]').forEach((b) => b.classList.toggle('is-active', b.dataset.apptab === name));
}
$('bottom-nav').addEventListener('click', (e) => {
  const b = e.target.closest('[data-apptab]');
  if (b) { setTab(b.dataset.apptab); window.scrollTo({ top: 0, behavior: 'smooth' }); }
});

// Cartoes minimizaveis: tocar no topo do cartao recolhe/expande (lembra a escolha).
const COLLAPSE_KEY = 'ninho-collapsed-v1';
let collapsedSet = new Set();
try { collapsedSet = new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]')); } catch { /* ignora */ }
document.querySelectorAll('[data-collapse]').forEach((card) => {
  const key = card.dataset.collapse;
  if (collapsedSet.has(key)) card.classList.add('is-collapsed');
  const head = card.querySelector('.card-heading');
  if (!head) return;
  head.classList.add('collapsible');
  head.title = 'Tocar para minimizar ou expandir';
  head.addEventListener('click', () => {
    card.classList.toggle('is-collapsed');
    if (card.classList.contains('is-collapsed')) collapsedSet.add(key); else collapsedSet.delete(key);
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsedSet])); } catch { /* ignora */ }
  });
});
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
}
function readToken() {
  try { const v = localStorage.getItem('ninho-token'); if (v) return v; } catch { /* ignora */ }
  return null;
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
  state.baby = {
    id: 'local', name: local.profile.name || 'Meu bebê', birth_date: local.profile.birth || '',
    birth_time: local.profile.birthTime || '', birth_weight_kg: local.profile.birthWeight ?? null,
    birth_length_cm: local.profile.birthLength ?? null, birth_head_cm: local.profile.birthHead ?? null,
    birth_notes: local.profile.birthNotes || '',
  };
  state.family = null;
  state.events = [...local.events].sort((a, b) => b.startsAt - a.startsAt);
  show('app-view');
  render();
  runQuickAction();
}
async function enterApp() {
  show('app-view');
  await loadEvents();
  subscribeRealtime();
  runQuickAction();
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
const ICONS = { sleep: '☾', feeding: '🍼', diaper: '✦', weight: '⚖', temperature: '🌡', tummy: '🐢', bath: '🛁', medicine: '💊', note: '✎', vaccine: '💉', vitamin: '☀' };
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
    case 'vaccine': return `Vacina · ${esc(vaccineName(e.note))}`;
    case 'vitamin': return 'Vitamina D';
    default: return esc(e.note || 'Nota');
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
  renderGrowth();
  renderBirth();
  renderHealth();
  renderPhoto();
  renderMeasures();
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
  const list = state.events.filter((e) => e.type !== 'vitamin' && e.type !== 'question' && e.type !== 'photo').slice(0, 30);
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
  $('baby-birth-time').value = (state.baby.birth_time || '').slice(0, 5);
  $('baby-birth-weight').value = state.baby.birth_weight_kg ?? '';
  $('baby-birth-length').value = state.baby.birth_length_cm ?? '';
  $('baby-birth-head').value = state.baby.birth_head_cm ?? '';
  $('baby-birth-notes').value = state.baby.birth_notes || '';
  $('profile-dialog').showModal();
});
$('profile-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const name = $('baby-name').value.trim();
  const birth = $('baby-birth').value;
  if (!name || !birth) return;
  const numOrNull = (v) => { const n = Number(String(v).replace(',', '.')); return v !== '' && Number.isFinite(n) && n > 0 ? n : null; };
  const birthFields = {
    birth_time: $('baby-birth-time').value || null,
    birth_weight_kg: numOrNull($('baby-birth-weight').value),
    birth_length_cm: numOrNull($('baby-birth-length').value),
    birth_head_cm: numOrNull($('baby-birth-head').value),
    birth_notes: $('baby-birth-notes').value.trim() || null,
  };
  if (state.mode === 'cloud') {
    const full = await sb.from('babies').update({ name, birth_date: birth, ...birthFields }).eq('id', state.baby.id);
    if (full.error) {
      // banco ainda sem as colunas do nascimento (schema v4): salva o basico e avisa
      const basic = await sb.from('babies').update({ name, birth_date: birth }).eq('id', state.baby.id);
      if (basic.error) { toast('Não consegui salvar o perfil.'); return; }
      toast('Nome e data salvos. Os dados do nascimento pedem um passo a mais — fala com a Mica.');
    }
  } else {
    local.profile = {
      name, birth,
      birthTime: birthFields.birth_time || '',
      birthWeight: birthFields.birth_weight_kg,
      birthLength: birthFields.birth_length_cm,
      birthHead: birthFields.birth_head_cm,
      birthNotes: birthFields.birth_notes || '',
    };
    saveLocal();
  }
  Object.assign(state.baby, { name, birth_date: birth, ...birthFields });
  $('profile-dialog').close();
  render();
  toast('Perfil salvo 💛');
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

// Curvas OMS (meninos) — parametros LMS mensais 0-24 meses, extraidos das tabelas
// expandidas oficiais da OMS (arquivos guardados em ~/workspace/bebe-app/dados-oms).
const WHO_BOYS = {
  weight: [[0.3487,3.3464,0.146],[0.2303,4.4525,0.1341],[0.1969,5.5714,0.1238],[0.174,6.369,0.1173],[0.1551,7.0069,0.1131],[0.1396,7.5077,0.1108],[0.1256,7.9389,0.1096],[0.1134,8.2963,0.109],[0.1019,8.62,0.1088],[0.0917,8.9019,0.1088],[0.0821,9.1618,0.1089],[0.0729,9.4136,0.1091],[0.0645,9.646,0.1092],[0.0563,9.8772,0.1095],[0.0487,10.0944,0.1098],[0.0412,10.3139,0.1101],[0.0343,10.5228,0.1104],[0.0276,10.7289,0.1108],[0.021,10.9393,0.1112],[0.0149,11.1409,0.1116],[0.0087,11.3478,0.1121],[0.0029,11.5474,0.1126],[-0.0029,11.7528,0.1132],[-0.0083,11.951,0.1137],[-0.0136,12.1482,0.1143]],
  length: [[1,49.8842,0.0379],[1,54.6645,0.0356],[1,58.4384,0.0342],[1,61.4013,0.0333],[1,63.9041,0.0326],[1,65.8912,0.032],[1,67.6435,0.0316],[1,69.1615,0.0314],[1,70.6224,0.0312],[1,71.9714,0.0312],[1,73.2653,0.0312],[1,74.5464,0.0312],[1,75.7391,0.0314],[1,76.9304,0.0315],[1,78.0451,0.0317],[1,79.1613,0.032],[1,80.2113,0.0322],[1,81.234,0.0325],[1,82.2628,0.0328],[1,83.2318,0.0331],[1,84.2074,0.0334],[1,85.1291,0.0338],[1,86.0589,0.0341],[1,86.9392,0.0345],[1,87.8018,0.0348]],
  head: [[1,34.4618,0.0369],[1,37.2435,0.0314],[1,39.1349,0.03],[1,40.5008,0.0292],[1,41.6401,0.0287],[1,42.5524,0.0284],[1,43.3393,0.0282],[1,43.9791,0.028],[1,44.5384,0.028],[1,45.0007,0.0279],[1,45.4004,0.0279],[1,45.7593,0.0279],[1,46.0637,0.0279],[1,46.3421,0.0279],[1,46.5834,0.0279],[1,46.809,0.0279],[1,47.0088,0.0279],[1,47.1936,0.028],[1,47.3718,0.028],[1,47.5341,0.028],[1,47.6931,0.0281],[1,47.8399,0.0281],[1,47.985,0.0281],[1,48.1198,0.0282],[1,48.2494,0.0282]],
};
const GROWTH_META = {
  weight: { label: 'Peso', field: 'weightKg', fmt: (v) => `${String(v).replace('.', ',')} kg`, dec: 1 },
  length: { label: 'Comprimento', field: 'lengthCm', fmt: (v) => `${Math.round(v)} cm`, dec: 0 },
  head: { label: 'Cabecinha', field: 'headCm', fmt: (v) => `${String(v).replace('.', ',')} cm`, dec: 1 },
};
let growthMetric = 'weight';
function lmsAt(metric, ageDays) {
  const t = Math.min(24, Math.max(0, ageDays / 30.4375));
  const i = Math.min(23, Math.floor(t)); const f = t - i;
  const A = WHO_BOYS[metric][i]; const B = WHO_BOYS[metric][i + 1];
  return [0, 1, 2].map((k) => A[k] + (B[k] - A[k]) * f);
}
function zOf(metric, value, ageDays) {
  const [L, M, S] = lmsAt(metric, ageDays);
  return Math.abs(L) < 1e-6 ? Math.log(value / M) / S : ((value / M) ** L - 1) / (L * S);
}
function pctOf(z) {
  const s = z < 0 ? -1 : 1; const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 50 * (1 + s * y);
}
function valueAtZ(metric, z, ageDays) {
  const [L, M, S] = lmsAt(metric, ageDays);
  return Math.abs(L) < 1e-6 ? M * Math.exp(S * z) : M * (1 + L * S * z) ** (1 / L);
}
function growthPoints(metric) {
  const birth = state.baby?.birth_date;
  if (!birth) return [];
  const b0 = new Date(`${birth}T12:00:00`).getTime();
  const field = GROWTH_META[metric].field;
  const pts = state.events
    .filter((e) => e.type === 'weight' && e[field])
    .map((e) => ({ ageDays: Math.max(0, (e.startsAt - b0) / 86400000), value: e[field] }))
    .filter((p) => p.ageDays <= 731)
    .sort((a, b) => a.ageDays - b.ageDays);
  const birthVal = metric === 'weight' ? state.baby?.birth_weight_kg : metric === 'length' ? state.baby?.birth_length_cm : state.baby?.birth_head_cm;
  if (birthVal && !pts.some((p) => p.ageDays <= 1)) pts.unshift({ ageDays: 0, value: Number(birthVal) });
  return pts;
}

function renderBirth() {
  const card = $('birth-card');
  if (!card || !state.baby) return;
  const b = state.baby;
  const birth = b.birth_date || '';
  const age = birth ? ageDaysOf(birth) : null;
  const hasData = b.birth_time || b.birth_weight_kg || b.birth_length_cm || b.birth_head_cm || b.birth_notes;
  if (!birth || age === null || age < 0 || !hasData) { card.hidden = true; return; }
  const dateStr = new Date(`${birth}T12:00:00`).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });
  const parts = [`${b.name} nasceu em ${dateStr}`];
  if (b.birth_time) parts[0] += `, às ${String(b.birth_time).slice(0, 5)}`;
  const medidas = [];
  if (b.birth_weight_kg) medidas.push(`${String(b.birth_weight_kg).replace('.', ',')} kg`);
  if (b.birth_length_cm) medidas.push(`${String(b.birth_length_cm).replace('.', ',')} cm`);
  if (b.birth_head_cm) medidas.push(`cabecinha de ${String(b.birth_head_cm).replace('.', ',')} cm`);
  $('birth-line').textContent = parts[0] + (medidas.length ? ` — com ${medidas.join(' · ')}.` : '.');
  $('birth-notes').textContent = b.birth_notes || '';
  $('birth-notes').style.display = b.birth_notes ? '' : 'none';
  card.hidden = false;
}

function renderGrowth() {
  const box = $('growth-summary'); const svg = $('growth-chart');
  if (!box || !svg) return;
  const birth = state.baby?.birth_date;
  const age = birth ? ageDaysOf(birth) : null;
  $('growth-age').textContent = age !== null && age >= 0 ? `${age} dias de vida` : '';
  if (!birth || age === null || age < 0) {
    box.innerHTML = '<p class="muted">As curvas ganham vida quando o Henrique nascer: a primeira pesagem na maternidade já vira o primeiro ponto aqui. 💛</p>';
    svg.innerHTML = '';
    return;
  }
  const lasts = ['weight', 'length', 'head']
    .map((m) => ({ m, pts: growthPoints(m) }))
    .filter((x) => x.pts.length);
  if (!lasts.length) {
    box.innerHTML = '<p class="muted">Nenhuma medida ainda. Registre em <strong>Medidas</strong> (peso, comprimento e cabecinha) e o percentil de cada uma aparece aqui.</p>';
    svg.innerHTML = '';
    return;
  }
  box.innerHTML = lasts.map(({ m, pts }) => {
    const last = pts[pts.length - 1];
    const p = pctOf(zOf(m, last.value, last.ageDays));
    const pTxt = p < 1 ? '<1' : p > 99 ? '>99' : String(Math.round(p));
    return `<p class="growth-line"><strong>${GROWTH_META[m].label}:</strong> ${GROWTH_META[m].fmt(last.value)} <span class="pct-chip">percentil ${pTxt}</span> <span class="muted">aos ${Math.round(last.ageDays)} dias</span></p>`;
  }).join('');
  drawGrowthChart(growthMetric);
}
function drawGrowthChart(metric) {
  const svg = $('growth-chart');
  const meta = GROWTH_META[metric];
  const pts = growthPoints(metric);
  const W = 340; const H = 190; const L = 36; const R = 8; const T = 8; const B = 22;
  const maxAgeM = Math.min(24, Math.max(6, Math.ceil((pts.length ? pts[pts.length - 1].ageDays : 0) / 30.4375) + 1));
  const ages = []; for (let a = 0; a <= maxAgeM * 30.4375; a += 7.6) ages.push(a);
  const curve = (z) => ages.map((d) => valueAtZ(metric, z, d));
  const p3 = curve(-1.8808); const p50 = curve(0); const p97 = curve(1.8808);
  let yMin = Math.min(...p3, ...pts.map((p) => p.value));
  let yMax = Math.max(...p97, ...pts.map((p) => p.value));
  const pad = (yMax - yMin) * 0.08 || 1; yMin -= pad; yMax += pad;
  const X = (d) => L + (d / (maxAgeM * 30.4375)) * (W - L - R);
  const Y = (v) => T + (1 - (v - yMin) / (yMax - yMin)) * (H - T - B);
  const line = (vals) => vals.map((v, i) => `${i ? 'L' : 'M'}${X(ages[i]).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  const band = `${line(p97)} ${[...p3].reverse().map((v, i) => `L${X(ages[ages.length - 1 - i]).toFixed(1)},${Y(v).toFixed(1)}`).join(' ')} Z`;
  const fmtY = (v) => v.toFixed(meta.dec).replace('.', ',');
  let h = '';
  h += `<path d="${band}" fill="#d49174" opacity="0.13"/>`;
  h += `<path d="${line(p3)}" fill="none" stroke="#b9c8bb" stroke-width="1"/>`;
  h += `<path d="${line(p97)}" fill="none" stroke="#b9c8bb" stroke-width="1"/>`;
  h += `<path d="${line(p50)}" fill="none" stroke="#6e9e7d" stroke-width="1.6" stroke-dasharray="5 4"/>`;
  h += `<text x="${L - 4}" y="${Y(yMax) + 3}" text-anchor="end" class="g-axis">${fmtY(yMax)}</text>`;
  h += `<text x="${L - 4}" y="${Y(yMin) + 3}" text-anchor="end" class="g-axis">${fmtY(yMin)}</text>`;
  h += `<text x="${L}" y="${H - 6}" class="g-axis">nasc.</text>`;
  h += `<text x="${X(maxAgeM * 30.4375 / 2)}" y="${H - 6}" text-anchor="middle" class="g-axis">${Math.round(maxAgeM / 2)}m</text>`;
  h += `<text x="${X(maxAgeM * 30.4375)}" y="${H - 6}" text-anchor="end" class="g-axis">${maxAgeM} meses</text>`;
  h += `<text x="${W - R}" y="${T + 8}" text-anchor="end" class="g-axis">faixa: percentis 3–97 · linha do meio: 50</text>`;
  if (pts.length) {
    h += `<path d="${pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.ageDays).toFixed(1)},${Y(p.value).toFixed(1)}`).join(' ')}" fill="none" stroke="#d49174" stroke-width="2"/>`;
    h += pts.map((p) => `<circle cx="${X(p.ageDays).toFixed(1)}" cy="${Y(p.value).toFixed(1)}" r="3.4" fill="#d49174" stroke="#fff" stroke-width="1.4"/>`).join('');
  } else {
    h += `<text x="${(L + W - R) / 2}" y="${H / 2}" text-anchor="middle" class="g-axis">sem medidas de ${meta.label.toLowerCase()} ainda</text>`;
  }
  svg.innerHTML = h;
}
document.querySelectorAll('.growth-tab').forEach((b) => b.addEventListener('click', () => {
  growthMetric = b.dataset.metric;
  document.querySelectorAll('.growth-tab').forEach((x) => x.classList.toggle('is-active', x === b));
  drawGrowthChart(growthMetric);
}));


// ---------------- caderneta de saude ----------------
// Calendario Nacional de Vacinacao (PNI/MS), conferido em out/2026.
// Vacina aplicada, vitamina do dia e perguntas vivem como eventos — sincronizam
// entre os pais sem precisar de tabela nova.
const VACCINES = [
  { id: 'bcg', m: 0, name: 'BCG', dose: 'dose única' },
  { id: 'hepb1', m: 0, name: 'Hepatite B', dose: '1ª dose' },
  { id: 'penta1', m: 2, name: 'Pentavalente (DTP + Hib + Hep B)', dose: '1ª dose' },
  { id: 'vip1', m: 2, name: 'Poliomielite (VIP)', dose: '1ª dose' },
  { id: 'pneu1', m: 2, name: 'Pneumocócica', dose: '1ª dose' },
  { id: 'rota1', m: 2, name: 'Rotavírus', dose: '1ª dose' },
  { id: 'menc1', m: 3, name: 'Meningocócica C', dose: '1ª dose' },
  { id: 'penta2', m: 4, name: 'Pentavalente (DTP + Hib + Hep B)', dose: '2ª dose' },
  { id: 'vip2', m: 4, name: 'Poliomielite (VIP)', dose: '2ª dose' },
  { id: 'pneu2', m: 4, name: 'Pneumocócica', dose: '2ª dose' },
  { id: 'rota2', m: 4, name: 'Rotavírus', dose: '2ª dose' },
  { id: 'menc2', m: 5, name: 'Meningocócica C', dose: '2ª dose' },
  { id: 'penta3', m: 6, name: 'Pentavalente (DTP + Hib + Hep B)', dose: '3ª dose' },
  { id: 'vip3', m: 6, name: 'Poliomielite (VIP)', dose: '3ª dose' },
  { id: 'flu1', m: 6, name: 'Influenza', dose: '1ª dose (campanha)' },
  { id: 'covid1', m: 6, name: 'Covid-19', dose: '1ª dose' },
  { id: 'vsr1', m: 6, name: 'Bronquiolite (VSR) · Nirsevimabe', dose: 'dose única (anticorpo)' },
  { id: 'covid2', m: 7, name: 'Covid-19', dose: '2ª dose' },
  { id: 'flu2', m: 7, name: 'Influenza', dose: '2ª dose (só na primeira vez)' },
  { id: 'fa1', m: 9, name: 'Febre Amarela', dose: 'dose única' },
  { id: 'covid3', m: 9, name: 'Covid-19', dose: '3ª dose' },
  { id: 'pneuR', m: 12, name: 'Pneumocócica', dose: 'reforço' },
  { id: 'acwy', m: 12, name: 'Meningocócica ACWY', dose: 'reforço' },
  { id: 'tv1', m: 12, name: 'Tríplice Viral', dose: '1ª dose' },
  { id: 'dtp1', m: 15, name: 'DTP (tríplice bacteriana)', dose: '1º reforço' },
  { id: 'vipR', m: 15, name: 'Poliomielite (VIP)', dose: 'reforço' },
  { id: 'hepa', m: 15, name: 'Hepatite A', dose: 'dose única' },
  { id: 'tetra', m: 15, name: 'Tetra Viral', dose: 'dose única' },
  { id: 'dtp2', m: 48, name: 'DTP', dose: '2º reforço' },
  { id: 'vipR2', m: 48, name: 'Poliomielite (VIP)', dose: '2º reforço' },
  { id: 'var2', m: 48, name: 'Varicela', dose: '2ª dose' },
  { id: 'faR', m: 48, name: 'Febre Amarela', dose: 'reforço' },
];
function vaccineName(id) { return VACCINES.find((v) => v.id === id)?.name || id || ''; }
function dueTs(birthStr, months) { const d = new Date(`${birthStr}T12:00:00`); d.setMonth(d.getMonth() + months); return d.getTime(); }
function ageGroupLabel(m) { return m === 0 ? 'Ao nascer' : m < 24 ? `${m} meses` : `${m / 12} anos`; }
let vaxAgeTab = null;
function renderHealth() {
  const listBox = $('vaccine-list'); const nextBox = $('next-vaccine');
  if (!listBox || !nextBox || !state.baby) return;
  const birth = state.baby.birth_date || '';
  const born = birth && ageDaysOf(birth) >= 0;
  const applied = new Map();
  for (const e of state.events) if (e.type === 'vaccine' && e.note) applied.set(e.note, e);
  // vitamina do dia + ultimos 7 dias
  const vitToday = state.events.find((e) => e.type === 'vitamin' && dayKey(e.startsAt) === dayKey(now()));
  const btn = $('btn-vitamin');
  if (btn) {
    btn.textContent = vitToday ? '✓ Vitamina dada hoje' : 'Dar a vitamina';
    btn.classList.toggle('is-done', !!vitToday);
    btn.disabled = !born;
  }
  const dots = $('vitamin-dots');
  if (dots) {
    let dh = '';
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - i);
      const has = state.events.some((e) => e.type === 'vitamin' && dayKey(e.startsAt) === dayKey(d.getTime()));
      dh += `<span class="vdot${has ? ' on' : ''}" title="${d.toLocaleDateString('pt-BR')}"></span>`;
    }
    dots.innerHTML = dh;
  }
  // proxima vacina
  if (!birth) nextBox.textContent = 'As vacinas aparecem aqui quando o nascimento estiver no perfil.';
  else if (!born) nextBox.textContent = 'Primeiras vacinas: BCG e Hepatite B, ainda na maternidade. 💛';
  else {
    const pending = VACCINES.filter((v) => !applied.has(v.id))
      .map((v) => ({ v, due: dueTs(birth, v.m) }))
      .sort((a, b) => a.due - b.due);
    if (!pending.length) nextBox.textContent = 'Vacinas em dia por aqui ✓ (calendário até os 4 anos)';
    else {
      const { v, due } = pending[0];
      const dias = Math.ceil((due - now()) / 86400000);
      const data = new Date(due).toLocaleDateString('pt-BR');
      nextBox.textContent = dias < 0
        ? `⚠ Vacina atrasada: ${v.name} (${v.dose}) — era para ${data}. Vale passar na UBS.`
        : dias === 0
          ? `💉 Hoje é dia de vacina: ${v.name} (${v.dose}).`
          : `💉 Próxima vacina: ${v.name} (${v.dose}) — em ${dias} ${dias === 1 ? 'dia' : 'dias'} (${data}).`;
    }
  }
  // abas por idade: mostra so o grupo escolhido (padrao = proxima idade devida)
  const groups = [...new Set(VACCINES.map((v) => v.m))];
  if (vaxAgeTab === null || !groups.includes(vaxAgeTab)) {
    if (!born) vaxAgeTab = 0;
    else {
      const pend = VACCINES.filter((v) => !applied.has(v.id)).map((v) => v.m);
      vaxAgeTab = pend.length ? pend[0] : groups[groups.length - 1];
    }
  }
  const tabsBox = $('vax-tabs');
  if (tabsBox) {
    tabsBox.innerHTML = groups.map((m) => {
      const tot = VACCINES.filter((v) => v.m === m).length;
      const dn = VACCINES.filter((v) => v.m === m && applied.has(v.id)).length;
      return `<button type="button" class="vax-pill${m === vaxAgeTab ? ' is-active' : ''}" data-vaxage="${m}">${ageGroupLabel(m)} <small>${dn}/${tot}</small></button>`;
    }).join('');
  }
  listBox.innerHTML = VACCINES.filter((v) => v.m === vaxAgeTab).map((v) => {
    const ev = applied.get(v.id);
    if (ev) {
      return `<div class="vax-row done"><span class="vax-check">✓</span><div class="vax-main"><strong>${v.name}</strong> · ${v.dose}<small>aplicada em ${new Date(ev.startsAt).toLocaleDateString('pt-BR')}</small></div><button class="text-button" type="button" data-unvax="${ev.id}">desfazer</button></div>`;
    }
    const due = birth ? new Date(dueTs(birth, v.m)).toLocaleDateString('pt-BR') : '';
    const atrasada = born && dueTs(birth, v.m) < now();
    return `<div class="vax-row"><span class="vax-check pending">○</span><div class="vax-main"><strong>${v.name}</strong> · ${v.dose}<small>${birth ? `prevista para ${due}` : ''}${atrasada ? ' · <b class="vax-late">atrasada</b>' : ''}</small></div><button class="text-button" type="button" data-vax="${v.id}">marcar aplicada</button></div>`;
  }).join('');
  // perguntas
  const qs = state.events.filter((e) => e.type === 'question');
  $('question-list').innerHTML = qs.length ? qs.map((q) => `
    <div class="question-row${q.endsAt ? ' asked' : ''}">
      <button class="q-toggle" type="button" data-qtoggle="${q.id}" aria-label="Marcar como perguntada">${q.endsAt ? '✓' : '○'}</button>
      <span class="q-text">${esc(q.note || '')}</span>
      <button class="delete-button" type="button" data-qdel="${q.id}" aria-label="Excluir pergunta">×</button>
    </div>`).join('') : '<p class="muted tiny">Nenhuma pergunta anotada. A primeira consulta costuma ser nos primeiros 7–10 dias de vida.</p>';
}
$('btn-vitamin').addEventListener('click', async () => {
  const today = state.events.find((e) => e.type === 'vitamin' && dayKey(e.startsAt) === dayKey(now()));
  if (today) { await deleteEvent(today.id); }
  else { await addEvent({ type: 'vitamin', endsAt: now() }); toast('Vitamina D registrada ☀'); }
  renderHealth();
});
$('question-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const text = $('question-input').value.trim();
  if (!text) return;
  $('question-input').value = '';
  await addEvent({ type: 'question', note: text, endsAt: null });
  renderHealth();
});
document.addEventListener('click', async (ev) => {
  const pill = ev.target.closest?.('[data-vaxage]');
  if (pill) { vaxAgeTab = Number(pill.dataset.vaxage); renderHealth(); return; }
  const mdel = ev.target.closest?.('[data-mdel]');
  if (mdel) { await deleteEvent(mdel.dataset.mdel); renderMeasures(); renderGrowth(); return; }
  const apply = ev.target.closest?.('[data-vax]');
  if (apply) { await addEvent({ type: 'vaccine', note: apply.dataset.vax, endsAt: now() }); toast('Vacina marcada como aplicada 💉'); renderHealth(); return; }
  const undo = ev.target.closest?.('[data-unvax]');
  if (undo) { await deleteEvent(undo.dataset.unvax); renderHealth(); return; }
  const qt = ev.target.closest?.('[data-qtoggle]');
  if (qt) {
    const q = state.events.find((e) => e.id === qt.dataset.qtoggle);
    if (q) { await updateEvent(q.id, { endsAt: q.endsAt ? null : now() }); renderHealth(); }
    return;
  }
  const qd = ev.target.closest?.('[data-qdel]');
  if (qd) { await deleteEvent(qd.dataset.qdel); renderHealth(); }
});


// ---------------- foto do bebe ----------------
// A foto vive como um registro sincronizado (imagem comprimida no aparelho):
// aparece nos dois celulares sem precisar de servico de arquivos.
function babyPhotoUrl() { const e = state.events.find((x) => x.type === 'photo' && x.note); return e ? e.note : null; }
function renderPhoto() {
  const img = $('avatar-img'); const fb = $('avatar-fallback');
  if (!img || !fb) return;
  const url = babyPhotoUrl();
  if (url) { img.src = url; img.hidden = false; fb.hidden = true; }
  else { img.hidden = true; img.removeAttribute('src'); fb.hidden = false; fb.textContent = (state.baby?.name || '').trim().charAt(0).toUpperCase() || '👶'; }
}
function fileToPhoto(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const max = 512;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      let out = c.toDataURL('image/jpeg', 0.82);
      if (out.length > 380000) out = c.toDataURL('image/jpeg', 0.65);
      resolve(out);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('img')); };
    img.src = url;
  });
}
$('avatar-btn').addEventListener('click', () => $('photo-input').click());
$('photo-input').addEventListener('change', async (ev) => {
  const f = ev.target.files?.[0];
  ev.target.value = '';
  if (!f) return;
  try {
    const dataUrl = await fileToPhoto(f);
    for (const o of state.events.filter((x) => x.type === 'photo')) await deleteEvent(o.id);
    await addEvent({ type: 'photo', note: dataUrl, endsAt: now() });
    toast('Foto salva 📷');
  } catch { toast('Não consegui ler essa foto — tenta outra.'); }
  renderPhoto();
});


// ---------------- medidas (aba Crescimento) ----------------
function fmtN(n) { return Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 2 }); }
function renderMeasures() {
  const box = $('measure-history');
  if (!box) return;
  const dEl = $('m-date');
  if (dEl && !dEl.value) dEl.value = new Date().toLocaleDateString('sv-SE');
  const ms = state.events.filter((e) => e.type === 'weight');
  if (!ms.length) {
    box.innerHTML = '<p class="muted tiny">Nenhuma medida registrada ainda — a primeira costuma ser a do nascimento, na maternidade.</p>';
    return;
  }
  const birthTs = state.baby?.birth_date ? new Date(`${state.baby.birth_date}T12:00:00`).getTime() : null;
  box.innerHTML = ms.map((e) => {
    const parts = [];
    if (e.weightKg) parts.push(`${fmtN(e.weightKg)} kg`);
    if (e.lengthCm) parts.push(`${fmtN(e.lengthCm)} cm`);
    if (e.headCm) parts.push(`cabecinha ${fmtN(e.headCm)} cm`);
    let idade = '';
    let dias = null;
    if (birthTs) {
      dias = Math.round((e.startsAt - birthTs) / 86400000);
      idade = dias < 0 ? 'antes de nascer' : dias === 0 ? 'ao nascer' : dias < 60 ? `aos ${dias} dias` : `aos ${(dias / 30.4375).toFixed(1).replace('.', ',')} meses`;
    }
    const chips = [];
    if (dias !== null && dias >= 0) {
      if (e.weightKg) chips.push(`peso P${Math.round(pctOf(zOf('weight', e.weightKg, dias)))}`);
      if (e.lengthCm) chips.push(`compr. P${Math.round(pctOf(zOf('length', e.lengthCm, dias)))}`);
      if (e.headCm) chips.push(`cab. P${Math.round(pctOf(zOf('head', e.headCm, dias)))}`);
    }
    return `<div class="measure-row"><div class="vax-main"><strong>${new Date(e.startsAt).toLocaleDateString('pt-BR')}</strong>${idade ? ` · ${idade}` : ''}<small>${parts.join(' · ')}${chips.length ? ` — ${chips.join(' · ')}` : ''}</small></div><button class="delete-button" type="button" data-mdel="${e.id}" aria-label="Excluir medida">×</button></div>`;
  }).join('');
}
const numOrNull = (v) => { const n = Number(String(v || '').trim().replace(',', '.')); return Number.isFinite(n) && n > 0 ? n : null; };
$('measure-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('m-error');
  err.textContent = '';
  const d = $('m-date').value;
  const w = numOrNull($('m-weight').value);
  const l = numOrNull($('m-length').value);
  const hd = numOrNull($('m-head').value);
  if (!d) { err.textContent = 'Escolhe a data da medida.'; return; }
  if (!w && !l && !hd) { err.textContent = 'Preenche pelo menos uma medida: peso, comprimento ou cabecinha.'; return; }
  const ts = new Date(`${d}T12:00:00`).getTime();
  if (ts > now() + 86400000) { err.textContent = 'Essa data ainda não chegou — confere a data.'; return; }
  await addEvent({ type: 'weight', startsAt: ts, endsAt: ts, weightKg: w, lengthCm: l, headCm: hd });
  $('m-weight').value = ''; $('m-length').value = ''; $('m-head').value = '';
  $('m-date').value = new Date().toLocaleDateString('sv-SE');
  toast('Medida salva 📏');
  renderMeasures(); renderGrowth();
});

// ---------------- sons para dormir ----------------
// Estrategia robusta: o som e GERADO como arquivo (WAV) dentro do aparelho e tocado
// pelo player de audio comum da pagina. Funciona em qualquer navegador que toque midia.
const blobCache = {};
let soundEl = null; let soundUrl = null; let soundTimer = null; let soundOn = false;
function setSoundStatus(msg) { $('sound-status').textContent = msg; }
function makeNoiseData(ctx, type) {
  const len = Math.floor(ctx.sampleRate * 4);
  const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0; let b0 = 0; let b1 = 0; let b2 = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    if (type === 'brown') { last = (last + 0.02 * white) / 1.02; data[i] = last * 3.2; }
    else if (type === 'pink') { b0 = 0.997 * b0 + 0.029 * white; b1 = 0.985 * b1 + 0.032 * white; b2 = 0.95 * b2 + 0.048 * white; data[i] = (b0 + b1 + b2 + white * 0.05) * 1.5; }
    else data[i] = white * 0.6;
  }
  let peak = 0;
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(data[i]));
  if (peak > 0) { const scale = 0.95 / peak; for (let i = 0; i < len; i++) data[i] *= scale; }
  const fade = Math.floor(ctx.sampleRate * 0.08);
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    const tail = data[len - fade + i];
    data[i] = data[i] * t + tail * (1 - t);
  }
  return buffer;
}
const NOTES = { G3: 196, C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392, A4: 440, B4: 493.88, C5: 523.25 };
const SONGS = {
  'music-twinkle': [['C4', 1], ['C4', 1], ['G4', 1], ['G4', 1], ['A4', 1], ['A4', 1], ['G4', 2], ['F4', 1], ['F4', 1], ['E4', 1], ['E4', 1], ['D4', 1], ['D4', 1], ['C4', 2], ['G4', 1], ['G4', 1], ['F4', 1], ['F4', 1], ['E4', 1], ['E4', 1], ['D4', 2], ['G4', 1], ['G4', 1], ['F4', 1], ['F4', 1], ['E4', 1], ['E4', 1], ['D4', 2], ['C4', 1], ['C4', 1], ['G4', 1], ['G4', 1], ['A4', 1], ['A4', 1], ['G4', 2], ['F4', 1], ['F4', 1], ['E4', 1], ['E4', 1], ['D4', 1], ['D4', 1], ['C4', 2]],
  'music-jacques': [['C4', 1], ['D4', 1], ['E4', 1], ['C4', 1], ['C4', 1], ['D4', 1], ['E4', 1], ['C4', 1], ['E4', 1], ['F4', 1], ['G4', 2], ['E4', 1], ['F4', 1], ['G4', 2], ['G4', .5], ['A4', .5], ['G4', .5], ['F4', .5], ['E4', 1], ['C4', 1], ['G4', .5], ['A4', .5], ['G4', .5], ['F4', .5], ['E4', 1], ['C4', 1], ['C4', 1], ['G3', 1], ['C4', 2], ['C4', 1], ['G3', 1], ['C4', 2]],
};
function bufferToWavBlob(buffer) {
  const data = buffer.getChannelData(0);
  const len = data.length;
  const out = new DataView(new ArrayBuffer(44 + len * 2));
  const wstr = (off, str) => { for (let i = 0; i < str.length; i++) out.setUint8(off + i, str.charCodeAt(i)); };
  wstr(0, 'RIFF'); out.setUint32(4, 36 + len * 2, true); wstr(8, 'WAVEfmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, buffer.sampleRate, true); out.setUint32(28, buffer.sampleRate * 2, true);
  out.setUint16(32, 2, true); out.setUint16(34, 16, true); wstr(36, 'data'); out.setUint32(40, len * 2, true);
  for (let i = 0; i < len; i++) {
    const v = Math.max(-1, Math.min(1, data[i]));
    out.setInt16(44 + i * 2, v * 0x7fff, true);
  }
  return new Blob([out.buffer], { type: 'audio/wav' });
}
function offlineLfo(off, freq, depth, target) {
  const lfo = off.createOscillator();
  const d = off.createGain();
  d.gain.value = depth;
  lfo.frequency.value = freq;
  lfo.connect(d).connect(target);
  lfo.start(0);
}
function offlinePling(off, dest, freq, t, durSec) {
  const g = off.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.5, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.7, durSec * 2.1));
  const o1 = off.createOscillator(); o1.type = 'sine'; o1.frequency.value = freq;
  const o2 = off.createOscillator(); o2.type = 'sine'; o2.frequency.value = freq * 4;
  const g2 = off.createGain(); g2.gain.value = 0.16;
  o1.connect(g); o2.connect(g2).connect(g); g.connect(dest);
  const stopAt = t + Math.max(0.8, durSec * 2.2);
  o1.start(t); o2.start(t); o1.stop(stopAt); o2.stop(stopAt);
}
async function renderSoundBlob(type) {
  if (blobCache[type]) return blobCache[type];
  const sr = 44100;
  const isMusic = !!SONGS[type];
  const dur = isMusic ? SONGS[type].reduce((a, [, b]) => a + b * 0.46, 0) + 1.6 : 12;
  const off = new OfflineAudioContext(1, Math.ceil(sr * dur), sr);
  const master = off.createGain(); master.gain.value = 0.95; master.connect(off.destination);
  if (!isMusic) {
    const base = (type === 'sea' || type === 'forest') ? 'pink' : type;
    const src = off.createBufferSource();
    src.buffer = makeNoiseData(off, base);
    src.loop = true;
    if (type === 'brown') {
      const filter = off.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 480;
      const whoosh = off.createGain(); whoosh.gain.value = 0.82;
      src.connect(filter).connect(whoosh).connect(master);
      offlineLfo(off, 1 / 12, 0.16, whoosh.gain);
    } else if (type === 'sea') {
      const filter = off.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 620;
      const waves = off.createGain(); waves.gain.value = 0.72;
      src.connect(filter).connect(waves).connect(master);
      offlineLfo(off, 1 / 12, 330, filter.frequency);
      offlineLfo(off, 1 / 12, 0.26, waves.gain);
    } else if (type === 'forest') {
      const breeze = off.createGain(); breeze.gain.value = 0.07;
      src.connect(breeze).connect(master);
      for (const t0 of [0.8, 2.4, 4.2, 5.8, 7.6, 9.5, 11.0]) {
        const o = off.createOscillator(); o.type = 'sine';
        const g = off.createGain();
        const f0 = 2100 + ((t0 * 733) % 900);
        o.frequency.setValueAtTime(f0, t0);
        o.frequency.exponentialRampToValueAtTime(f0 * 1.35, t0 + 0.07);
        o.frequency.exponentialRampToValueAtTime(f0 * 0.92, t0 + 0.16);
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(0.06, t0 + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
        o.connect(g).connect(master);
        o.start(t0); o.stop(t0 + 0.25);
      }
    } else {
      src.connect(master);
    }
    src.start(0);
  } else {
    let t = 0.1;
    for (const [note, beats] of SONGS[type]) {
      offlinePling(off, master, NOTES[note], t, beats * 0.46);
      t += beats * 0.46;
    }
  }
  const rendered = await off.startRendering();
  const blob = bufferToWavBlob(rendered);
  blobCache[type] = blob;
  return blob;
}
async function startSound() {
  const type = $('sound-type').value;
  const label = $('sound-type').selectedOptions[0]?.textContent || 'som';
  setSoundStatus('Preparando o som…');
  if (!soundEl) { soundEl = new Audio(); soundEl.loop = true; soundEl.preload = 'auto'; }
  if (type.startsWith('file:')) {
    // cancoes enviadas pelo Marcos: arquivo pronto na pasta sounds/
    if (soundUrl) { URL.revokeObjectURL(soundUrl); soundUrl = null; }
    soundEl.src = `sounds/${type.slice(5)}`;
  } else {
    const blob = await renderSoundBlob(type);
    if (soundUrl) URL.revokeObjectURL(soundUrl);
    soundUrl = URL.createObjectURL(blob);
    soundEl.src = soundUrl;
  }
  soundEl.volume = Number($('sound-volume').value) / 100;
  await soundEl.play();
  soundOn = true;
  $('btn-sound').textContent = '■ Parar som';
  setSoundStatus(`Tocando agora: ${label}`);
  const mins = Number($('sound-timer').value);
  clearTimeout(soundTimer);
  if (mins > 0) soundTimer = setTimeout(stopSound, mins * 60000);
}
function stopSound() {
  soundOn = false;
  if (soundEl) soundEl.pause();
  clearTimeout(soundTimer);
  $('btn-sound').textContent = '▶ Tocar som';
  setSoundStatus('Som parado.');
}
$('btn-sound').addEventListener('click', async () => {
  if (soundOn) { stopSound(); return; }
  try { await startSound(); }
  catch (e) {
    setSoundStatus(`Não tocou: ${e?.message || 'o navegador bloqueou o áudio'}. Toque de novo ou aumente o volume do aparelho.`);
    toast('Não consegui tocar o som. Veja o aviso no cartão de sons.');
  }
});
$('sound-type').addEventListener('change', async () => {
  if (!soundOn) return;
  try { await startSound(); }
  catch { setSoundStatus('Não consegui trocar o som. Toque em parar e tocar de novo.'); }
});
$('sound-volume').addEventListener('input', () => { if (soundEl) soundEl.volume = Number($('sound-volume').value) / 100; });

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


// ---------------- acoes rapidas (atalhos do icone) ----------------
let pendingQuick = null;
try { pendingQuick = new URLSearchParams(window.location.search).get('quick'); } catch { /* ignora */ }
function runQuickAction() {
  if (!pendingQuick) return;
  const q = pendingQuick; pendingQuick = null;
  try { history.replaceState(null, '', window.location.pathname); } catch { /* ignora */ }
  if (!state.baby) return;
  if (q === 'diaper-wet') $('btn-diaper-wet').click();
  else if (q === 'diaper-dirty') $('btn-diaper-dirty').click();
  else if (q === 'sleep') $('btn-sleep').click();
  else if (q === 'contraction') {
    $('btn-contraction').click();
    document.querySelector('.contractions-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

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
  // Seguranca: o token nao fica na URL (historico/compartilhamentos) nem em cookie.
  const incomingToken = new URLSearchParams(window.location.search).get('token');
  if (incomingToken) {
    const clean = new URL(window.location.href);
    clean.searchParams.delete('token');
    history.replaceState(null, '', clean.pathname + clean.search + clean.hash);
  }
  try { document.cookie = 'ninho-token=; max-age=0; path=/ninho/; SameSite=Lax'; } catch { /* ignora */ }
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('local') === '1') { enterLocal(); return; } // atalho interno de testes
    if (sb) {
      const { data: { session } } = await sb.auth.getSession();
      if (session) { await afterAuth(); return; }
      const urlToken = incomingToken;
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
