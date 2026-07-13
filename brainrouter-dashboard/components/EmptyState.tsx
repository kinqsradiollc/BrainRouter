import React from "react";

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description: string;
  children?: React.ReactNode;
}

export function EmptyState({ icon, title, description, children }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon" aria-hidden>{icon ?? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="8" /><path d="M8.5 12h7M12 8.5v7" /></svg>}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {children && <div className="empty-state__actions">{children}</div>}
    </div>
  );
}
