// dashboard-common.js — Shared utilities: esc, shortModel, getToken, toast

export function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s ?? '');
  return d.innerHTML;
}

export function shortModel(m) {
  if (!m || m === 'unknown') return '-';
  const parts = m.split('/');
  let name = parts[parts.length - 1];
  name = name.replace(/-a\d+b$/, '');
  return name;
}

export function getToken() {
  return new URLSearchParams(window.location.search).get('token') || '';
}

export function toast(msg, type = 'info') {
  let c = document.getElementById('toastContainer');
  if (!c) { c = document.createElement('div'); c.id = 'toastContainer'; c.className = 'toast-container'; document.body.appendChild(c); }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  const icons = { info: '\u25B6', success: '\u2713', warn: '\u26A0', error: '\u2717' };
  el.textContent = `${icons[type] || '\u25B6'} ${msg}`;
  c.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    el.style.transform = 'translateX(40px) translateY(-8px)';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 350);
  }, 3000);
}
