import { createRoot } from "react-dom/client";
import { App } from "./App";

// No `export` here -> this entry file is skipped by the barrel generator (rule 2).
const el = document.getElementById("root");
if (el) createRoot(el).render(<App />);
