import React, { useEffect, useRef } from "react";

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}

export const Dialog: React.FC<DialogProps> = ({ open, onOpenChange, children }) => {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) {
        onOpenChange(false);
      }
    };
    if (open) {
      document.body.style.overflow = "hidden";
      window.addEventListener("keydown", handleKeyDown);
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onOpenChange]);

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        backgroundColor: "rgba(0, 0, 0, 0.8)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
      }}
      onClick={(e) => {
        if (e.target === overlayRef.current) {
          onOpenChange(false);
        }
      }}
    >
      {children}
    </div>
  );
};

export const DialogContent: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  style,
  className = "",
  children,
  ...props
}) => {
  return (
    <div
      style={{
        backgroundColor: "#1A1A1A",
        border: "1px solid #1F2228",
        borderRadius: "8px",
        boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5)",
        width: "100%",
        maxWidth: "520px",
        maxHeight: "90vh",
        overflowY: "auto",
        padding: "24px",
        position: "relative",
        color: "#EDEDED",
        ...style,
      }}
      className={`ui-dialog-content ${className}`}
      {...props}
    >
      {children}
    </div>
  );
};

export const DialogHeader: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  style,
  children,
  ...props
}) => (
  <div style={{ marginBottom: "16px", ...style }} {...props}>
    {children}
  </div>
);

export const DialogTitle: React.FC<React.HTMLAttributes<HTMLHeadingElement>> = ({
  style,
  children,
  ...props
}) => (
  <h2
    style={{
      fontSize: "18px",
      fontWeight: 600,
      color: "#EDEDED",
      margin: 0,
      fontFamily: "var(--font-sans)",
      ...style,
    }}
    {...props}
  >
    {children}
  </h2>
);

export const DialogDescription: React.FC<React.HTMLAttributes<HTMLParagraphElement>> = ({
  style,
  children,
  ...props
}) => (
  <p
    style={{
      fontSize: "13px",
      color: "#A1A1AA",
      marginTop: "6px",
      lineHeight: "1.5",
      ...style,
    }}
    {...props}
  >
    {children}
  </p>
);

export const DialogFooter: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  style,
  children,
  ...props
}) => (
  <div
    style={{
      marginTop: "24px",
      display: "flex",
      justifyContent: "flex-end",
      gap: "10px",
      ...style,
    }}
    {...props}
  >
    {children}
  </div>
);
