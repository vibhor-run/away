import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

// Translucent sidebars exist only on macOS; other platforms get a solid sidebar.
document.documentElement.dataset.platform = window.away.platform;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
