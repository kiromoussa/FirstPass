import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Page surfaces (light). `deep` keeps its name for shared headers/footers.
        deep: {
          DEFAULT: "#fbfcfa",
          900: "#ffffff",
          800: "#f3f6f0",
        },
        // Soft green tint used for badges / icon chips.
        rich: {
          DEFAULT: "#eef7f0",
          600: "#e6f3ea",
          700: "#dcefe1",
        },
        // Primary brand green (formerly teal).
        teal: {
          DEFAULT: "#1f8a4c",
          600: "#1a7a42",
          700: "#16633a",
        },
        accent: {
          DEFAULT: "#1f8a4c",
          600: "#1a7a42",
          700: "#16633a",
        },
        // Neutral scale. `ink` (no number) is primary dark text; the numbered
        // steps are light surfaces/borders so dark-theme classes flip cleanly.
        ink: {
          DEFAULT: "#15170f",
          950: "#fbfcfa",
          900: "#ffffff",
          800: "#f3f6f0",
          700: "#e7e9e2",
          600: "#d5d8cd",
        },
        canvas: "#fbfcfa",
        body: "#54584d",
        muted: "#82867a",
        faint: "#9aa093",
        hairline: "#eceee7",
        flag: {
          fail: "#c2410c",
          warn: "#b07a09",
          review: "#6E56CF",
          pass: "#1f8a4c",
        },
      },
      fontFamily: {
        display: ["var(--font-display)", "ui-sans-serif", "system-ui", "sans-serif"],
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      boxShadow: {
        card: "0 18px 50px -30px rgba(20, 40, 25, 0.4)",
        float: "0 30px 70px -34px rgba(20, 40, 25, 0.45)",
      },
      borderRadius: {
        xl: "12px",
        "2xl": "16px",
        "3xl": "20px",
      },
    },
  },
  plugins: [],
} satisfies Config;
