/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: {
          // OCT Agent — bioluminescent deep-ocean palette (jellyfish-inspired)
          50:  '#f3eeff',
          100: '#e8dcff',
          200: '#d0b9ff',
          300: '#B87EFF', // jellyfish tentacle violet — glow
          400: '#9D6FFF', // mid-violet
          500: '#7B5FFF', // primary bioluminescent purple
          600: '#5A3FD4', // deep ocean purple
          700: '#3E28A8',
          800: '#271878',
          900: '#140D4A',
          950: '#090912', // deep void black
        },
        ocean: {
          300: '#93D5FF',
          400: '#4F9EFF', // deep ocean blue
          500: '#1E7BFF',
          600: '#1056CC',
        },
      },
      transitionTimingFunction: {
        // Apple-inspired spring physics — slight overshoot gives tactile "snap"
        spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
        // Smooth deceleration — used for dismissals / outgoing elements
        out: 'cubic-bezier(0, 0, 0.2, 1)',
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-in-out',
        'slide-up': 'slideUp 0.3s ease-out',
        'pulse-soft': 'pulseSoft 2s ease-in-out infinite',
        // Nav active pill springs into place
        'nav-pill': 'navPillIn 0.26s cubic-bezier(0.34, 1.56, 0.64, 1) forwards',
        // Page content fades up on mount
        'page-enter': 'pageEnter 0.22s cubic-bezier(0, 0, 0.2, 1) forwards',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        pulseSoft: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.7' },
        },
        navPillIn: {
          '0%':   { opacity: '0', transform: 'scale(0.84)' },
          '65%':  { opacity: '1', transform: 'scale(1.04)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        pageEnter: {
          '0%':   { opacity: '0', transform: 'translateY(7px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
};
