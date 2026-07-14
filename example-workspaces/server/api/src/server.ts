import { greet } from "@dbx-tools/shared-core";
import express from "express";

/**
 * A tiny Express server. The route surface is described by the tsoa controllers in
 * this package (see `greetingController.ts`) - that is what `dbxtools openapi`
 * turns into the generated `@dbx-tools/openapi-api` package (spec + typed client).
 *
 * Return type is annotated (not inferred) so the emitted type names `express.Express`
 * via the direct `express` dep, avoiding TS2742's non-portable reference to the
 * transitive `@types/express-serve-static-core` under pnpm's strict node_modules.
 */
export function createServer(): express.Express {
  const app = express();
  app.get("/greeting/:name", (req, res) => {
    res.json({ message: greet(req.params.name) });
  });
  return app;
}

createServer().listen(3000, () => {
  console.log("Server is running on port 3000");
});
