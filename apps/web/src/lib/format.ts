/** Dates, durées et nombres au format de docs/frontend.md § 9. Fuseau du navigateur, toujours affiché. */

const pad = (value: number) => String(value).padStart(2, '0');

/** `UTC+1`, `UTC−3`, `UTC+5:30` pour une date donnée (le décalage change avec l'heure d'été). */
export function zoneLabel(date: Date): string {
  const offset = -date.getTimezoneOffset();
  if (offset === 0) return 'UTC';
  const sign = offset > 0 ? '+' : '−';
  const hours = Math.floor(Math.abs(offset) / 60);
  const minutes = Math.abs(offset) % 60;
  return `UTC${sign}${hours}${minutes ? `:${pad(minutes)}` : ''}`;
}

/** `03/11/2026 14:32:10` */
export function exactDate(value: string | Date): string {
  const date = new Date(value);
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export const exactDateWithZone = (value: string | Date) => `${exactDate(value)} ${zoneLabel(new Date(value))}`;

/** `2 h 14 min`, `45 s`, `3 j 2 h`. */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
  const days = Math.floor(hours / 24);
  return `${days} j${hours % 24 ? ` ${hours % 24} h` : ''}`;
}

/** `il y a 3 min`, `à l'instant`. */
export function relative(value: string | Date, now = Date.now()): string {
  const ms = now - new Date(value).getTime();
  if (ms < 0) return 'dans un instant';
  if (ms < 45_000) return "à l'instant";
  return `il y a ${duration(ms)}`;
}

export const number = (value: number) => new Intl.NumberFormat('fr-FR').format(value).replace(/ | /g, ' ');
export const amount = (value: number, currency?: string | null) => `${number(value)}${currency ? ` ${currency}` : ''}`;

export function bytes(value: number): string {
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1).replace('.', ',')} ${units[unit]}`;
}

export const percent = (value: number) => `${String(Math.round(value * 10) / 10).replace('.', ',')} %`;
