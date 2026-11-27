import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        ink: "#08090d",
        panel: "#11131a",
        line: "rgba(255,255,255,.09)",
        violet: "#a78bfa",
        cyan: "#7dd3fc"
      },
      boxShadow: { glow: "0 0 80px rgba(139,92,246,.18)" }
    }
  },
  plugins: []
};

export default config;
