"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function PublicHeader() {
  const pathname = usePathname();

  return (
    <header className="public-header">
      <div className="public-header-inner">
        <Link href="/" className="logo">
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <div 
              style={{ 
                width: "8px", 
                height: "8px", 
                borderRadius: "50%", 
                background: "var(--color-golden-accent)",
                boxShadow: "0 0 10px var(--color-golden-accent)" 
              }} 
            />
            <span className="serif-display" style={{ fontSize: "20px", color: "var(--color-pure-white)", fontWeight: 500 }}>
              BrainRouter
            </span>
          </div>
        </Link>

        <nav className="public-nav">
          <Link href="/" className={`public-nav-link ${pathname === "/" ? "active" : ""}`}>
            Home
          </Link>
          <Link href="/about" className={`public-nav-link ${pathname === "/about" ? "active" : ""}`}>
            About Us
          </Link>
          <a 
            href="https://github.com/kinqsradiollc/BrainRouter" 
            target="_blank" 
            rel="noopener noreferrer" 
            className="public-nav-link"
            style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
          >
            <svg style={{ width: "16px", height: "16px" }} viewBox="0 0 24 24" fill="currentColor">
              <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482C19.138 20.193 22 16.44 22 12.017 22 6.484 17.522 2 12 2z" />
            </svg>
            GitHub
          </a>
          <Link href="/auth">
            <button className="pill-btn button-gold-primary" style={{ padding: "8px 18px", borderRadius: "var(--radius-pill)", fontSize: "13px", fontWeight: 600 }}>
              Sign In
            </button>
          </Link>
        </nav>
      </div>
    </header>
  );
}
