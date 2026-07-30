import React from "react";

interface PageHeaderProps {
  title: string;
  description?: string;
  children?: React.ReactNode;
}

// Class-based (see .page-header rules in globals.css) so the title scales down
// and the action slot wraps under the heading on mobile without a client hook.
export function PageHeader({ title, description, children }: PageHeaderProps) {
  return (
    <div className="page-header">
      <div className="page-header__text">
        <h1 className="page-header__title">{title}</h1>
        {description && <p className="page-header__desc">{description}</p>}
      </div>
      {children && <div className="page-header__actions">{children}</div>}
    </div>
  );
}
