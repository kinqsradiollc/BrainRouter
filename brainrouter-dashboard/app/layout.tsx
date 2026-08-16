import type { Metadata } from "next";
import "./globals.css";
import "@kinqs/brainrouter-ui/planner.css";
import "katex/dist/katex.min.css";
import { AuthGuard } from "../components/AuthGuard";
import { AuthProvider } from "../components/AuthProvider";
import { LayoutWrapper } from "../components/LayoutWrapper";
import { ThemeProvider } from "../components/ThemeProvider";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";

export const metadata: Metadata = {
  title: "BrainRouter | One workspace your team works in",
  description: "Plan the day, run the meeting, write the doc, ship the change — and keep the thread. Planner, meetings, notes, the team board, agents, review, and the knowledge that connects them, in one workspace.",
  openGraph: {
    title: "BrainRouter",
    description: "One workspace your agents actually work in — plan, meet, write, build, verify, and keep the thread.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
  },
  icons: {
    icon: [{ url: "/ico.svg", type: "image/svg+xml", sizes: "any" }],
    shortcut: "/ico.svg",
  },
  manifest: "/site.webmanifest",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#000000",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" data-scroll-behavior="smooth" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `
          (function() {
            localStorage.setItem('theme', 'dark');
            document.documentElement.setAttribute('data-theme', 'dark');
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
