import type { Metadata } from "next";
import "./globals.css";
import { AuthGuard } from "../components/AuthGuard";
import { AuthProvider } from "../components/AuthProvider";
import { LayoutWrapper } from "../components/LayoutWrapper";
import { ThemeProvider } from "../components/ThemeProvider";

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
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
        <script dangerouslySetInnerHTML={{ __html: `
          (function() {
            var theme = localStorage.getItem('theme') || 'light';
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
