import type { Metadata } from "next";
import "./globals.css";
import "katex/dist/katex.min.css";
import { AuthGuard } from "../components/AuthGuard";
import { AuthProvider } from "../components/AuthProvider";
import { LayoutWrapper } from "../components/LayoutWrapper";
import { ThemeProvider } from "../components/ThemeProvider";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";

export const metadata: Metadata = {
  title: "BrainRouter | Cognitive Memory Engine",
  description: "The decentralized cognitive gateway. Establish your local memory routing core to synchronize multiple autonomous agents and maintain persistent identity context.",
  openGraph: {
    title: "BrainRouter",
    description: "The Cognitive Memory Layer for Autonomous AI Assistants.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `
          (function() {
            var theme = localStorage.getItem('theme') || 'dark';
            document.documentElement.setAttribute('data-theme', theme);
          })()
        `}} />
      </head>
      <body>
        <ThemeProvider>
          <AuthProvider>
            <AuthGuard>
              <LayoutWrapper>{children}</LayoutWrapper>
            </AuthGuard>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
