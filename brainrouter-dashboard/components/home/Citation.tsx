"use client";

/**
 * Citation — the footnote that keeps the landing page honest.
 *
 * It used to cite the papers behind the memory-science slides. The page now
 * describes a product rather than a theory, so it cites the thing a product
 * claim has to be backed by: the route that implements it. Same job, same
 * visual language — a claim on this page should always be one click from the
 * surface that makes it true.
 *
 * Internal routes render as links only when the dashboard is running with a
 * backend; in presentation-only mode there is nothing behind them, so they
 * degrade to plain text rather than to a dead link.
 */

import Link from "next/link";

import { STATIC_PRESENTATION } from "../../lib/presentation";

export interface CitationLink {
  /** How the destination is named in the product's own navigation. */
  readonly short: string;
  /** A dashboard route ("/reviews") or an absolute external URL. */
  readonly href: string;
}

function isExternal(href: string): boolean {
  return !href.startsWith("/");
}

export function Citation({ label = "Grounded in", links }: { label?: string; links: readonly CitationLink[] }) {
  return (
    <div className="home-citation">
      <span className="home-citation-label">{label}</span>
      {links.map((link) => {
        const arrow = (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <line x1="7" y1="17" x2="17" y2="7" />
            <polyline points="7 7 17 7 17 17" />
          </svg>
        );
        if (isExternal(link.href)) {
          return (
            <a key={link.href} className="home-citation-link" href={link.href} target="_blank" rel="noopener noreferrer">
              {link.short}{arrow}
            </a>
          );
        }
        if (STATIC_PRESENTATION) {
          return <span key={link.href} className="home-citation-link home-citation-link--static">{link.short}</span>;
        }
        return (
          <Link key={link.href} className="home-citation-link" href={link.href}>
            {link.short}{arrow}
          </Link>
        );
      })}
    </div>
  );
}
