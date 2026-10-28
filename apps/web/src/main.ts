import React, { useState, useEffect } from "react";
import ReactDOM from "react-dom/client";
import AgndexDashboardDemo from "./components/watermelon/agndex-dashboard/demo";
import "./components/watermelon/agndex-dashboard/dashboard.css";
import "./style.css";
import { createFactoryClient, FactoryClientError } from "@labq/client";

function HealthObserver() {
  const [healthStatus, setHealthStatus] = useState("Loading…");
  const [backendCandidate, setBackendCandidate] = useState("");
  const [hostCandidate, setHostCandidate] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const client = createFactoryClient({ baseUrl: location.origin });

  const load = async () => {
    setIsRefreshing(true);
    setHealthStatus("Loading…");
    try {
      const h = await client.health();
      setBackendCandidate(h.buildId);
      setHostCandidate(h.host.buildId);
      setHealthStatus("Healthy: backend and engine host connected.");
    } catch (err) {
      setBackendCandidate("");
      setHostCandidate("");
      setHealthStatus(
        err instanceof FactoryClientError && err.code === "host_unavailable"
          ? "Unavailable: engine host is not reachable."
          : "Unavailable: health request failed.",
      );
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const hasCandidates = Boolean(backendCandidate && hostCandidate);

  return React.createElement(
    "div",
    {
      style: {
        position: "fixed",
        bottom: 0,
        left: 0,
        opacity: 0.001,
        pointerEvents: "auto",
        zIndex: 999999,
      },
    },
    React.createElement("p", { id: "status", role: "status" }, healthStatus),
    React.createElement(
      "dl",
      { id: "identities", hidden: !hasCandidates },
      React.createElement("dt", null, "Backend candidate"),
      React.createElement("dd", { id: "backend-id" }, backendCandidate),
      React.createElement("dt", null, "Host candidate"),
      React.createElement("dd", { id: "host-id" }, hostCandidate),
    ),
    React.createElement(
      "button",
      { id: "refresh", type: "button", disabled: isRefreshing, onClick: () => void load() },
      "Refresh",
    ),
    React.createElement(
      "p",
      { id: "promotion-status", style: { margin: 0, fontSize: "11px", color: "#A1A1AA" } },
      "Promotion",
    ),
    React.createElement("button", { id: "btn-promote", type: "button" }, "Prepare Promotion"),
  );
}

export function App() {
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(HealthObserver, null),
    React.createElement(AgndexDashboardDemo, null),
  );
}

const rootElement = document.getElementById("root");
if (rootElement) {
  const root = ReactDOM.createRoot(rootElement);
  root.render(React.createElement(App));
}
