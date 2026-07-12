import { greet } from "@dbx-tools/shared-core";
import express from "express";

/**
 * A tiny Express server. The `@openapi` JSDoc annotation below is what the
 * `openapi` scope generator (dbxtools openapi) detects to produce
 * `@dbx-tools/openapi-api` (spec + typed client).
 *
 * @openapi
 * /greeting/{name}:
 *   get:
 *     summary: Greet someone by name.
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       "200":
 *         description: A greeting.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [message]
 *               properties:
 *                 message:
 *                   type: string
 */
export function createServer() {
  const app = express();
  app.get("/greeting/:name", (req, res) => {
    res.json({ message: greet(req.params.name) });
  });
  return app;
}
