import React from "react";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "secondary" | "outline" | "destructive" | "ghost";
  size?: "sm" | "md" | "lg";
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { variant = "default", size = "md", style, className = "", disabled, children, ...props },
    ref,
  ) => {
    const baseStyle: React.CSSProperties = {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      fontWeight: 500,
      fontFamily: "var(--font-sans)",
      borderRadius: "6px",
      transition: "all 0.15s ease",
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.5 : 1,
      border: "1px solid transparent",
      textDecoration: "none",
      userSelect: "none",
      whiteSpace: "nowrap",
      ...style,
    };

    const sizeStyles: Record<string, React.CSSProperties> = {
      sm: { padding: "4px 10px", fontSize: "12px", height: "28px" },
      md: { padding: "6px 14px", fontSize: "13px", height: "34px" },
      lg: { padding: "8px 18px", fontSize: "14px", height: "40px" },
    };

    const variantStyles: Record<string, React.CSSProperties> = {
      default: {
        backgroundColor: "#FF6308",
        color: "#0A0A0A",
        fontWeight: 600,
        borderColor: "#FF6308",
      },
      secondary: {
        backgroundColor: "#262626",
        color: "#EDEDED",
        borderColor: "#333333",
      },
      outline: {
        backgroundColor: "transparent",
        color: "#EDEDED",
        borderColor: "#1F2228",
      },
      destructive: {
        backgroundColor: "#DC2626",
        color: "#FFFFFF",
        borderColor: "#DC2626",
      },
      ghost: {
        backgroundColor: "transparent",
        color: "#EDEDED",
        borderColor: "transparent",
      },
    };

    return (
      <button
        ref={ref}
        disabled={disabled}
        style={{ ...baseStyle, ...sizeStyles[size], ...variantStyles[variant] }}
        className={`ui-button ${className}`}
        {...props}
      >
        {children}
      </button>
    );
  },
);

Button.displayName = "Button";
