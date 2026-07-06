/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx}',
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
