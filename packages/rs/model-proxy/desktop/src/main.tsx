import React from "react";
import { QueryClient } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import { client, rspc } from "./rspc.ts";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Model Proxy desktop root was not found");
const queryClient = new QueryClient();

createRoot(root).render(
  <React.StrictMode>
    <rspc.Provider client={client} queryClient={queryClient}>
      <App />
    </rspc.Provider>
  </React.StrictMode>,
);
