import React, { createContext, useContext, useState } from "react";

interface TabsContextType {
  value: string;
  onValueChange: (val: string) => void;
}

const TabsContext = createContext<TabsContextType | null>(null);

export interface TabsProps {
  defaultValue?: string;
  value?: string;
  onValueChange?: (val: string) => void;
  children: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
}

export const Tabs: React.FC<TabsProps> = ({
  defaultValue,
  value: controlledValue,
  onValueChange,
  children,
  style,
  className = "",
}) => {
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue ?? "");
  const value = controlledValue !== undefined ? controlledValue : uncontrolledValue;

  const handleValueChange = (val: string) => {
    if (controlledValue === undefined) {
      setUncontrolledValue(val);
    }
    onValueChange?.(val);
  };

  return (
    <TabsContext.Provider value={{ value, onValueChange: handleValueChange }}>
      <div style={{ width: "100%", ...style }} className={`ui-tabs ${className}`}>
        {children}
      </div>
    </TabsContext.Provider>
  );
};

export const TabsList: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  style,
  className = "",
  children,
  ...props
}) => (
  <div
    role="tablist"
    style={{
      display: "flex",
      alignItems: "center",
      gap: "4px",
      backgroundColor: "#141414",
      padding: "4px",
      borderRadius: "6px",
      border: "1px solid #1F2228",
      ...style,
    }}
    className={`ui-tabs-list ${className}`}
    {...props}
  >
    {children}
  </div>
);

export interface TabsTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
}

export const TabsTrigger: React.FC<TabsTriggerProps> = ({
  value,
  style,
  className = "",
  children,
  ...props
}) => {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error("TabsTrigger must be used inside Tabs");
  const isSelected = ctx.value === value;

  return (
    <button
      role="tab"
      aria-selected={isSelected}
      onClick={() => ctx.onValueChange(value)}
      style={{
        padding: "6px 12px",
        fontSize: "13px",
        fontWeight: 500,
        fontFamily: "var(--font-sans)",
        borderRadius: "4px",
        border: "none",
        cursor: "pointer",
        transition: "all 0.15s ease",
        backgroundColor: isSelected ? "#1F2228" : "transparent",
        color: isSelected ? "#EDEDED" : "#A1A1AA",
        outline: "none",
        ...style,
      }}
      className={`ui-tabs-trigger ${className}`}
      {...props}
    >
      {children}
    </button>
  );
};

export interface TabsContentProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
}

export const TabsContent: React.FC<TabsContentProps> = ({
  value,
  style,
  className = "",
  children,
  ...props
}) => {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error("TabsContent must be used inside Tabs");
  if (ctx.value !== value) return null;

  return (
    <div
      role="tabpanel"
      style={{ marginTop: "16px", ...style }}
      className={`ui-tabs-content ${className}`}
      {...props}
    >
      {children}
    </div>
  );
};
