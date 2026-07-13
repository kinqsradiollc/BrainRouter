import React from "react";

interface PremiumButtonProps {
  variant?: "primary" | "ghost" | "danger" | "success" | "text";
  size?: "small" | "medium";
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit" | "reset";
  style?: React.CSSProperties;
  children: React.ReactNode;
}

export function PremiumButton({
  variant = "ghost",
  size = "medium",
  onClick,
  disabled = false,
  title,
  type = "button",
  style,
  children,
}: PremiumButtonProps) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`premium-button premium-button--${variant} premium-button--${size}`}
      style={style}
    >
      {children}
    </button>
  );
}
