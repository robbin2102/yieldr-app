/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          green: '#00C805',
          dark: '#00A000',
        },
        background: '#000000',
        card: '#0A0A0A',
        border: '#1A1A1A',
      },
    },
  },
  plugins: [],
}
