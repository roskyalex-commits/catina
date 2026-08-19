import type { Metadata } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import "./globals.css";

/**
 * Inter rather than Geist: the reference product uses a neo-grotesque with
 * tight apertures, and Inter is the closest free match. Geist_Mono stays for
 * code and CUI/CAEN codes, where a monospace column matters.
 */
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin", "latin-ext"], // latin-ext carries ă, â, î, ș, ț
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Cătină — find the buyers already in the market",
  description:
    "Paste your website. Cătină works out who buys from you, finds those people " +
    "across the Romanian company registry and the web, and drafts the outreach.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
