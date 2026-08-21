function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  updateThemeButton(next);
}

function updateThemeButton(theme) {
  const btn = document.getElementById('themeToggle');
  if (btn) btn.textContent = theme === 'dark' ? '☀️ Светлая' : '🌙 Тёмная';
}

document.addEventListener('DOMContentLoaded', function () {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  updateThemeButton(current);
});
