import React from "react";

export const Table: React.FC<React.TableHTMLAttributes<HTMLTableElement>> = ({
  style,
  className = "",
  children,
  ...props
}) => (
  <div style={{ width: "100%", overflowX: "auto" }}>
    <table
      style={{
        width: "100%",
        borderCollapse: "collapse",
        fontSize: "13px",
        fontFamily: "var(--font-sans)",
        textAlign: "left",
        ...style,
      }}
      className={`ui-table ${className}`}
      {...props}
    >
      {children}
    </table>
  </div>
);

export const TableHeader: React.FC<React.HTMLAttributes<HTMLTableSectionElement>> = ({
  style,
  children,
  ...props
}) => (
  <thead
    style={{
      borderBottom: "1px solid #1F2228",
      backgroundColor: "#141414",
      ...style,
    }}
    {...props}
  >
    {children}
  </thead>
);

export const TableBody: React.FC<React.HTMLAttributes<HTMLTableSectionElement>> = ({
  style,
  children,
  ...props
}) => (
  <tbody style={{ ...style }} {...props}>
    {children}
  </tbody>
);

export const TableRow: React.FC<React.HTMLAttributes<HTMLTableRowElement>> = ({
  style,
  className = "",
  children,
  ...props
}) => (
  <tr
    style={{
      borderBottom: "1px solid #1F2228",
      transition: "background-color 0.1s ease",
      ...style,
    }}
    className={`ui-table-row ${className}`}
    {...props}
  >
    {children}
  </tr>
);

export const TableHead: React.FC<React.ThHTMLAttributes<HTMLTableCellElement>> = ({
  style,
  children,
  ...props
}) => (
  <th
    style={{
      padding: "10px 14px",
      fontWeight: 600,
      color: "#A1A1AA",
      fontSize: "12px",
      letterSpacing: "0.03em",
      textTransform: "uppercase",
      ...style,
    }}
    {...props}
  >
    {children}
  </th>
);

export const TableCell: React.FC<React.TdHTMLAttributes<HTMLTableCellElement>> = ({
  style,
  children,
  ...props
}) => (
  <td
    style={{
      padding: "10px 14px",
      color: "#EDEDED",
      verticalAlign: "middle",
      ...style,
    }}
    {...props}
  >
    {children}
  </td>
);
