import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MalinkApp } from "./MalinkApp";
import "./globals.css";

const root = document.getElementById("root");
if (!root) throw new Error("The static Malink application root is missing.");

createRoot(root).render(
  <StrictMode>
    <MalinkApp />
  </StrictMode>,
);
