import React from "react";

interface PageHeaderProps {
  title: string;
  description: string;
  children?: React.ReactNode;
}

export function PageHeader({ title, description, children }: PageHeaderProps) {
  return (
    <div style={{ 
      borderBottom: "1px solid rgba(226, 227, 233, 0.05)", 
      paddingBottom: "20px",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "flex-end",
      gap: "24px"
    }}>
      <div>
        <h1 className="serif-display" style={{ fontSize: "40px", margin: 0, fontWeight: 400 }}>
          {title}
        </h1>
        <p style={{ color: "var(--color-stone-text)", fontSize: "14px", margin: "8px 0 0 0", letterSpacing: "0.01em" }}>
          {description}
        </p>
      </div>
      {children && (
        <div style={{ display: "flex", gap: "12px", alignItems: "center", flexShrink: 0 }}>
          {children}
        </div>
      )}
    </div>
  );
}
