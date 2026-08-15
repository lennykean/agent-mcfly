// root workspace colors: 16 presets, ephemeral, randomly assigned — the same
// hue ties together an agent's rows in AGENTS, its linked terminal tab, and
// the titlebar while it is active
export const PALETTE = [
  '#f14c4c', '#ee9d28', '#e5e510', '#8bc34a',
  '#23d18b', '#2aa198', '#29b8db', '#3b8eea',
  '#0078d4', '#7c4dff', '#bc3fbc', '#d670d6',
  '#f472d0', '#c2185b', '#a1887f', '#78909c',
];

export function rgba(hex: string, alpha: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// a tint layered over a base surface color (inline style value)
export const tintOver = (hex: string, alpha: number, base: string) =>
  `linear-gradient(${rgba(hex, alpha)}, ${rgba(hex, alpha)}) ${base}`;
