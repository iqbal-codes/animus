import React from "react";

export const Label: React.FC<React.LabelHTMLAttributes<HTMLLabelElement>> = ({
  style,
  className = "",
  children,
  ...props
}) => (
  <label
    style={{
      display: "block",
      fontSize: "12px",
      fontWeight: 600,
      color: "#A1A1AA",
      marginBottom: "6px",
      fontFamily: "var(--font-sans)",
      ...style,
    }}
    className={`ui-label ${className}`}
    {...props}
  >
    {children}
  </label>
);

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ style, className = "", ...props }, ref) => (
  <input
    ref={ref}
    style={{
      display: "block",
      width: "100%",
      padding: "8px 12px",
      backgroundColor: "#141414",
      border: "1px solid #1F2228",
      borderRadius: "6px",
      color: "#EDEDED",
      fontSize: "13px",
      fontFamily: "var(--font-mono)",
      outline: "none",
      boxSizing: "border-box",
      transition: "border-color 0.15s ease",
      ...style,
    }}
    className={`ui-input ${className}`}
    {...props}
  />
));
Input.displayName = "Input";

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ style, className = "", children, ...props }, ref) => (
  <select
    ref={ref}
    style={{
      display: "block",
      width: "100%",
      padding: "8px 12px",
      backgroundColor: "#141414",
      border: "1px solid #1F2228",
      borderRadius: "6px",
      color: "#EDEDED",
      fontSize: "13px",
      fontFamily: "var(--font-sans)",
      outline: "none",
      boxSizing: "border-box",
      cursor: "pointer",
      ...style,
    }}
    className={`ui-select ${className}`}
    {...props}
  >
    {children}
  </select>
));
Select.displayName = "Select";

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ style, className = "", ...props }, ref) => (
  <textarea
    ref={ref}
    style={{
      display: "block",
      width: "100%",
      padding: "8px 12px",
      backgroundColor: "#141414",
      border: "1px solid #1F2228",
      borderRadius: "6px",
      color: "#EDEDED",
      fontSize: "13px",
      fontFamily: "var(--font-mono)",
      outline: "none",
      boxSizing: "border-box",
      minHeight: "80px",
      resize: "vertical",
      ...style,
    }}
    className={`ui-textarea ${className}`}
    {...props}
  />
));
Textarea.displayName = "Textarea";

export const FormError: React.FC<React.HTMLAttributes<HTMLParagraphElement>> = ({
  style,
  children,
  ...props
}) => {
  if (!children) return null;
  return (
    <p
      style={{
        fontSize: "12px",
        color: "#F87171",
        marginTop: "4px",
        fontFamily: "var(--font-sans)",
        ...style,
      }}
      {...props}
    >
      {children}
    </p>
  );
};
