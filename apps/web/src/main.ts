import React from "react";
import ReactDOM from "react-dom/client";
import { ConsoleApp } from "./console-app";
import "./style.css";

const rootElement = document.getElementById("root");
if (rootElement) {
  const root = ReactDOM.createRoot(rootElement);
  root.render(React.createElement(ConsoleApp));
}
