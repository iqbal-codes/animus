import React, { useState, useRef, useEffect, useMemo } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/form";
import { Badge } from "./ui/badge";

export interface VirtualizedLogViewerProps {
  logs: string[];
  height?: number;
  itemHeight?: number;
  overscan?: number;
  onClear?: () => void;
  title?: string;
  isStreaming?: boolean;
}

export const VirtualizedLogViewer: React.FC<VirtualizedLogViewerProps> = ({
  logs,
  height = 360,
  itemHeight = 22,
  overscan = 5,
  onClear,
  title = "Live Observation Logs",
  isStreaming = false,
}) => {
  const [filter, setFilter] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const filteredLogs = useMemo(() => {
    if (!filter.trim()) return logs;
    const lower = filter.toLowerCase();
    return logs.filter((line) => line.toLowerCase().includes(lower));
  }, [logs, filter]);

  const totalItems = filteredLogs.length;
  const totalHeight = totalItems * itemHeight;

  const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
  const visibleCount = Math.ceil(height / itemHeight) + 2 * overscan;
  const endIndex = Math.min(totalItems, startIndex + visibleCount);

  const visibleItems = useMemo(() => {
    const items: Array<{ index: number; line: string }> = [];
    for (let i = startIndex; i < endIndex; i++) {
      items.push({ index: i, line: filteredLogs[i] });
    }
    return items;
  }, [filteredLogs, startIndex, endIndex]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    setScrollTop(target.scrollTop);

    const isAtBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 40;
    if (autoScroll !== isAtBottom) {
      setAutoScroll(isAtBottom);
    }
  };

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [totalItems, autoScroll]);

  const copyToClipboard = () => {
    void navigator.clipboard?.writeText(filteredLogs.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        backgroundColor: "#141414",
        border: "1px solid #1F2228",
        borderRadius: "8px",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px",
          backgroundColor: "#1A1A1A",
          borderBottom: "1px solid #1F2228",
          gap: "8px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ fontSize: "12px", fontWeight: 600, color: "#EDEDED" }}>{title}</span>
          <Badge variant={isStreaming ? "accent" : "secondary"}>
            {isStreaming ? "LIVE" : "BUFFER"} ({totalItems})
          </Badge>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <Input
            placeholder="Filter logs..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ width: "160px", height: "26px", fontSize: "11px", padding: "2px 8px" }}
          />
          <Button
            size="sm"
            variant={autoScroll ? "default" : "outline"}
            onClick={() => setAutoScroll((v) => !v)}
            style={{ height: "26px", fontSize: "11px", padding: "2px 8px" }}
          >
            {autoScroll ? "Auto-scroll ON" : "Auto-scroll OFF"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={copyToClipboard}
            style={{ height: "26px", fontSize: "11px", padding: "2px 8px" }}
          >
            {copied ? "Copied!" : "Copy"}
          </Button>
          {onClear && (
            <Button
              size="sm"
              variant="outline"
              onClick={onClear}
              style={{ height: "26px", fontSize: "11px", padding: "2px 8px" }}
            >
              Clear
            </Button>
          )}
        </div>
      </div>

      <div
        ref={containerRef}
        onScroll={handleScroll}
        style={{
          height: `${height}px`,
          overflowY: "auto",
          position: "relative",
          fontFamily: "var(--font-mono)",
          fontSize: "12px",
          lineHeight: `${itemHeight}px`,
          color: "#EDEDED",
          backgroundColor: "#0A0A0A",
        }}
      >
        {totalItems === 0 ? (
          <div
            style={{
              padding: "24px",
              textAlign: "center",
              color: "#A1A1AA",
              fontSize: "13px",
            }}
          >
            No logs captured yet.
          </div>
        ) : (
          <div style={{ height: `${totalHeight}px`, position: "relative" }}>
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                transform: `translateY(${startIndex * itemHeight}px)`,
              }}
            >
              {visibleItems.map(({ index, line }) => (
                <div
                  key={index}
                  style={{
                    display: "flex",
                    height: `${itemHeight}px`,
                    padding: "0 12px",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    borderBottom: "1px solid rgba(31, 34, 40, 0.4)",
                  }}
                >
                  <span
                    style={{
                      width: "48px",
                      color: "#52525B",
                      userSelect: "none",
                      flexShrink: 0,
                    }}
                  >
                    {index + 1}
                  </span>
                  <span
                    style={{
                      color:
                        line.includes("ERROR") || line.includes("failed")
                          ? "#F87171"
                          : line.includes("WARN")
                            ? "#FBBF24"
                            : "#EDEDED",
                    }}
                  >
                    {line}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
