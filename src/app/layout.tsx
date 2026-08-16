import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Enactus SFU · Lead Agent",
  description: "AI agent that finds sponsors and sales leads, researches them, and drafts outreach.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
