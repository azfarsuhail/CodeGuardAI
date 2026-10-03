import { Atkinson_Hyperlegible_Mono, Atkinson_Hyperlegible_Next, Bricolage_Grotesque } from "next/font/google";

// Atkinson Hyperlegible: designed for low-vision readability, used for UI text and code alike.
// Next has no metric overrides for Atkinson Next, so fall back to system fonts explicitly.
export const sans = Atkinson_Hyperlegible_Next({
  subsets: ["latin"],
  variable: "--font-sans",
  fallback: ["system-ui", "Arial", "sans-serif"],
  adjustFontFallback: false,
});
export const mono = Atkinson_Hyperlegible_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  fallback: ["ui-monospace", "Consolas", "monospace"],
  adjustFontFallback: false,
});
export const display = Bricolage_Grotesque({ subsets: ["latin"], variable: "--font-display", axes: ["opsz", "wdth"] });
