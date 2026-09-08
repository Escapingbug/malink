import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MalinkApp } from "./MalinkApp";
import {
  StartupRecoveryBoundary,
  markPwaStartupPhase,
  reportPwaStartupFailure,
} from "./StartupRecoveryBoundary";
import "./globals.css";

const root = document.getElementById("root");
if (!root) throw new Error("The static Malink application root is missing.");

markPwaStartupPhase("booting");
createRoot(root, {
  onUncaughtError: (error, info) => {
    reportPwaStartupFailure(error, info.componentStack ?? "");
  },
}).render(
  <StrictMode>
    <StartupRecoveryBoundary>
      <MalinkApp />
    </StartupRecoveryBoundary>
  </StrictMode>,
);
