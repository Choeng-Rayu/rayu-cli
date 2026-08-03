/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx}',
    /*
     * Rayu Studio is styled by UnoCSS, not Tailwind (see uno.config.ts). The
     * './app/**' glob above would otherwise match app/studio/**, making both
     * engines emit utilities for the same files — and disagree on the ones whose
     * definitions differ between presetUno and Tailwind (line-heights, shadows,
     * default colour scales).
     *
     * Note studio/** is not listed at all, so only this negation is needed.
     */
    '!./app/studio/**',
  ],
  theme: {
    extend: {
      colors: {
        // Map the project's CSS variables to Tailwind utility classes
        'rayu-green':     'var(--green)',
        'rayu-green-dim': 'var(--green-dim)',
        'rayu-bg':        'var(--bg)',
        'rayu-bg2':       'var(--bg2)',
        'rayu-bg3':       'var(--bg3)',
        'rayu-border':    'var(--border)',
        'rayu-text':      'var(--text)',
        'rayu-muted':     'var(--muted)',
        'rayu-red':       'var(--red)',
      },
      fontFamily: {
        orbitron: ['Orbitron', 'sans-serif'],
        'dm-mono': ['DM Mono', 'monospace'],
      },
    },
  },
  plugins: [],
};
