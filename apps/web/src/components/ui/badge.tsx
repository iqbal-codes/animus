import React from "react";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: "default" | "secondary" | "outline" | "success" | "warning" | "destructive" | "accent";
}

export const Badge: React.FC<BadgeProps> = ({
  variant = "default",
  style,
  className = "",
  children,
  ...props
}) => {
  const baseStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    padding: "2px 8px",
    borderRadius: "4px",
    fontSize: "11px",
    fontWeight: 600,
    fontFamily: "var(--font-mono)",
    letterSpacing: "0.02em",
    lineHeight: "1.2",
    whiteSpace: "nowrap",
    border: "1px solid transparent",
    ...style,
  };

  const variantStyles: Record<string, React.CSSProperties> = {
    default: {
      backgroundColor: "#1F2228",
      color: "#EDEDED",
      borderColor: "#2D3139",
    },
    secondary: {
      backgroundColor: "#262626",
      color: "#A1A1AA",
      borderColor: "#333333",
    },
    outline: {
      backgroundColor: "transparent",
      color: "#EDEDED",
      borderColor: "#1F2228",
    },
    accent: {
      backgroundColor: "rgba(255, 99, 8, 0.15)",
      color: "#FF6308",
      borderColor: "rgba(255, 99, 8, 0.4)",
    },
    success: {
      backgroundColor: "rgba(22, 163, 74, 0.15)",
      color: "#4ADE80",
      borderColor: "rgba(22, 163, 74, 0.4)",
    },
    warning: {
      backgroundColor: "rgba(217, 119, 6, 0.15)",
      color: "#FBBF24",
      borderColor: "rgba(217, 119, 6, 0.4)",
    },
    destructive: {
      backgroundColor: "rgba(220, 38, 38, 0.15)",
      color: "#F87171",
      borderColor: "rgba(220, 38, 38, 0.4)",
    },
  };

  return (
    <span
      style={{ ...baseStyle, ...variantStyles[variant] }}
      className={`ui-badge ${className}`}
      {...props}
    >
      {children}
    </span>
  );
};
