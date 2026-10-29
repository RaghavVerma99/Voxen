import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Voxen — AI voice agent",
    template: "%s · Voxen",
  },
  description:
    "Talk to an AI assistant out loud. Voxen listens, reasons, searches the web, and answers in a natural voice.",
  applicationName: "Voxen",
  robots: { index: true, follow: true },
  openGraph: {
    title: "Voxen — AI voice agent",
    description:
      "A browser-based voice assistant with web search and spoken answers.",
    type: "website",
    siteName: "Voxen",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#070a12",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
