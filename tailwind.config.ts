import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#0a0e14",
          900: "#0f141c",
          800: "#161d28",
          700: "#1f2937",
          600: "#2b3647",
        },
        accent: {
          DEFAULT: "#3ddc97",
          600: "#22c07a",
          700: "#16a766",
        },
        flag: {
          fail: "#ff5c5c",
          warn: "#ffb547",
          review: "#5aa9ff",
          pass: "#3ddc97",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
