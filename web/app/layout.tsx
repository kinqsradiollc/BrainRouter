import type { Metadata } from "next";
import "./globals.css";
import { AuthGuard } from "../components/AuthGuard";
import { AuthProvider } from "../components/AuthProvider";
import { LayoutWrapper } from "../components/LayoutWrapper";
import { ThemeProvider } from "../components/ThemeProvider";

export const metadata: Metadata = {
  title: "BrainRouter | Cognitive Memory Engine",
  description: "The decentralized cognitive gateway. Establish your local memory routing core to synchronize multiple autonomous agents and maintain persistent identity context.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
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
