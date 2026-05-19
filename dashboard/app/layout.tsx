import type { Metadata } from "next";
import "./globals.css";
import { AuthGuard } from "../components/AuthGuard";
import { AuthProvider } from "../components/AuthProvider";
import { LayoutWrapper } from "../components/LayoutWrapper";

export const metadata: Metadata = {
  title: "BrainRouter | Cognitive Memory Engine",
  description: "The decentralized cognitive gateway. Establish your local memory routing core to synchronize multiple autonomous agents and maintain persistent identity context.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          <AuthGuard>
            <LayoutWrapper>{children}</LayoutWrapper>
          </AuthGuard>
        </AuthProvider>
      </body>
    </html>
  );
}
