import type { Metadata, Viewport } from "next";
import { Manrope } from "next/font/google";
import "./globals.css";

const manrope = Manrope({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-ui", display: "swap" });

const TAGLINE = "Turn pictures into living particle fields. Export loops for the web.";

export const metadata: Metadata = {
  title: "Motefield",
  description: TAGLINE,
  applicationName: "Motefield",
  openGraph: { title: "Motefield", description: TAGLINE, type: "website", siteName: "Motefield" },
  twitter: { card: "summary", title: "Motefield", description: TAGLINE },
};

export const viewport: Viewport = {
  themeColor: "#07080a",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={manrope.variable}>
      <body>{children}</body>
    </html>
  );
}
