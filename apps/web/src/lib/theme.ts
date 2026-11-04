/** Thème : suit le système, peut être forcé (docs/frontend.md § 11). Préférence gardée dans ce navigateur seulement. */
export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = 'sentinel-theme';
const media = () => window.matchMedia('(prefers-color-scheme: dark)');

export function readTheme(): ThemeChoice {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(choice: ThemeChoice = readTheme()) {
  const dark = choice === 'dark' || (choice === 'system' && media().matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

export function setTheme(choice: ThemeChoice) {
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Stockage indisponible (navigation privée) : le choix vaut pour cette page.
  }
  applyTheme(choice);
}

export function watchSystemTheme() {
  media().addEventListener('change', () => applyTheme());
}
