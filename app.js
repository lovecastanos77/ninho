(() => {
  'use strict';

  const KEY = 'ninho-sleep-v1';
  const $ = (id) => document.getElementById(id);
  const initial = { baby: { name: '', birth: '' }, sessions: [], activeStart: null };
  let state = load();

  function load() {
    try {
      const value = JSON.parse(localStorage.getItem(KEY));
      if (!value || typeof value !== 'object') return structuredClone(initial);
      return {
        baby: { name: String(value.baby?.name || '').slice(0, 40), birth: String(value.baby?.birth || '') },
        sessions: Array.isArray(value.sessions) ? value.sessions.filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start).slice(-1000) : [],
        activeStart: Number.isFinite(value.activeStart) ? value.activeStart : null
      };
    } catch { return structuredClone(initial); }
  }

  function save() { localStorage.setItem(KEY, JSON.stringify(state)); render(); }
  function dayStart(date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime(); }
  function dayMinutes(day, session) {
    const start = dayStart(day);
    return Math.max(0, Math.min(session.end, start + 86400000) - Math.max(session.start, start)) / 60000;
  }
  function formatDuration(minutes) {
    const m = Math.max(0, Math.round(minutes));
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}`;
  }
  function clock(time) { return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(time); }
  function dateText(time) { return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' }).format(time); }
  function minutesAwakeByAge() {
    const birth = new Date(`${state.baby.birth}T12:00:00`);
    if (!Number.isFinite(birth.getTime())) return 120;
    const months = Math.max(0, (Date.now() - birth.getTime()) / (86400000 * 30.44));
    if (months < 2) return 60;
    if (months < 4) return 90;
    if (months < 6) return 120;
    if (months < 9) return 150;
    if (months < 13) return 180;
    if (months < 18) return 240;
    return 300;
  }

  function renderNext() {
    const content = $('next-content');
    content.replaceChildren();
    const title = document.createElement('p'); title.className = 'next-time';
    const description = document.createElement('p'); description.className = 'muted';
    const progress = $('window-progress');
    if (state.activeStart) {
      title.textContent = 'Agora';
      description.textContent = `Dormindo desde ${clock(state.activeStart)}`;
      progress.style.width = '100%';
      $('window-note').textContent = `Sono em andamento · ${formatDuration((Date.now() - state.activeStart) / 60000)}`;
    } else {
      const last = state.sessions.reduce((latest, s) => Math.max(latest, s.end), 0);
      if (!last) {
        title.textContent = '—';
        description.textContent = 'Registre o primeiro descanso para ver uma estimativa.';
        progress.style.width = '0%';
        $('window-note').textContent = 'Uma estimativa gentil para organizar o dia.';
      } else {
        const windowMinutes = minutesAwakeByAge();
        const target = last + windowMinutes * 60000;
        title.textContent = clock(target);
        description.textContent = target < Date.now() ? 'A janela estimada já chegou' : `Em cerca de ${formatDuration((target - Date.now()) / 60000)}`;
        progress.style.width = `${Math.min(100, Math.max(0, (Date.now() - last) / (windowMinutes * 600)))}%`;
        $('window-note').textContent = `Estimativa após ${formatDuration(windowMinutes)} acordado.`;
      }
    }
    content.append(title, description);
  }

  function renderStats() {
    const today = new Date();
    const sessions = state.sessions.filter((s) => dayMinutes(today, s) > 0);
    const active = state.activeStart ? [{ start: state.activeStart, end: Date.now() }] : [];
    const total = [...sessions, ...active].reduce((n, s) => n + dayMinutes(today, s), 0);
    $('total-sleep').textContent = formatDuration(total);
    $('sleep-count').textContent = `${sessions.length + active.length} ${sessions.length + active.length === 1 ? 'descanso registrado' : 'descansos registrados'}`;
    const bars = $('mini-bars'); bars.replaceChildren();
    for (let offset = 6; offset >= 0; offset--) {
      const date = new Date(); date.setDate(date.getDate() - offset);
      const minutes = [...state.sessions, ...active].reduce((n, s) => n + dayMinutes(date, s), 0);
      const bar = document.createElement('span');
      bar.style.height = `${Math.max(4, Math.min(54, minutes / 14))}px`;
      if (offset === 0) bar.className = 'today';
      bar.title = `${dateText(date)}: ${formatDuration(minutes)}`;
      bars.append(bar);
    }
  }

  function renderTimeline() {
    const timeline = $('timeline'); timeline.replaceChildren();
    const today = new Date();
    const entries = state.sessions.filter((s) => dayMinutes(today, s) > 0).sort((a, b) => b.start - a.start);
    if (!entries.length) {
      const empty = document.createElement('div'); empty.className = 'empty-state';
      const symbol = document.createElement('span'); symbol.textContent = '☾';
      empty.append(symbol, 'Nenhum soninho registrado hoje.'); timeline.append(empty);
      return;
    }
    entries.forEach((s) => {
      const row = document.createElement('div'); row.className = 'entry';
      const icon = document.createElement('span'); icon.className = 'entry-icon'; icon.textContent = '☾';
      const main = document.createElement('div'); main.className = 'entry-main';
      const title = document.createElement('strong'); title.textContent = 'Sono';
      const details = document.createElement('small'); details.textContent = `${clock(s.start)} – ${clock(s.end)}`;
      main.append(title, details);
      const duration = document.createElement('span'); duration.className = 'entry-duration'; duration.textContent = formatDuration((s.end - s.start) / 60000);
      const remove = document.createElement('button'); remove.className = 'delete-button'; remove.type = 'button'; remove.title = 'Excluir este sono'; remove.setAttribute('aria-label', `Excluir sono das ${clock(s.start)}`); remove.textContent = '×';
      remove.addEventListener('click', () => { state.sessions = state.sessions.filter((entry) => entry.id !== s.id); save(); });
      row.append(icon, main, duration, remove); timeline.append(row);
    });
  }

  function render() {
    const name = state.baby.name.trim();
    $('profile-label').textContent = name || 'Meu bebê';
    $('today-label').textContent = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date()).toUpperCase();
    $('action-title').textContent = state.activeStart ? 'Soninho em andamento' : 'Hora de registrar um soninho?';
    $('action-subtitle').textContent = state.activeStart ? `Começou às ${clock(state.activeStart)} · ${formatDuration((Date.now() - state.activeStart) / 60000)}` : 'Acompanhe cada descanso sem complicação.';
    $('toggle-sleep').firstChild.textContent = state.activeStart ? 'Encerrar sono ' : 'Começar sono ';
    renderNext(); renderStats(); renderTimeline();
  }

  $('profile-button').addEventListener('click', () => {
    $('baby-name').value = state.baby.name;
    $('baby-birth').value = state.baby.birth;
    $('baby-birth').max = new Date().toISOString().slice(0, 10);
    $('profile-dialog').showModal();
  });
  $('profile-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = $('baby-name').value.trim(); const birth = $('baby-birth').value;
    if (!name || !birth || new Date(`${birth}T12:00:00`).getTime() > Date.now()) return;
    state.baby = { name, birth }; save(); $('profile-dialog').close();
  });
  $('toggle-sleep').addEventListener('click', () => {
    if (!state.activeStart) state.activeStart = Date.now();
    else {
      const end = Date.now();
      if (end > state.activeStart) state.sessions.push({ id: crypto.randomUUID(), start: state.activeStart, end });
      state.activeStart = null;
    }
    save();
  });
  $('add-manual').addEventListener('click', () => {
    const now = new Date(); const before = new Date(now.getTime() - 30 * 60000);
    const localValue = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    $('sleep-start').value = localValue(before); $('sleep-end').value = localValue(now);
    $('form-error').textContent = ''; $('sleep-dialog').showModal();
  });
  $('sleep-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const start = new Date($('sleep-start').value).getTime(); const end = new Date($('sleep-end').value).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end > Date.now() + 60000) {
      $('form-error').textContent = 'Confira os horários: o fim deve ser posterior ao início e não pode estar no futuro.'; return;
    }
    state.sessions.push({ id: crypto.randomUUID(), start, end }); save(); $('sleep-dialog').close();
  });
  document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => $(button.dataset.close).close()));
  render(); setInterval(render, 60000);
})();
