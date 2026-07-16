import { strings } from "@dbx-tools/example-shared-core";
import { Controller, Get, Path, Route, SuccessResponse } from "tsoa";

/** A greeting payload (the response schema, inferred by tsoa from this type). */
export interface Greeting {
  message: string;
}

/**
 * A tsoa controller - the source of the OpenAPI spec. `dbxtools openapi` runs
 * tsoa's spec generator over the `server` tag's controllers to produce the
 * read-only `@dbx-tools/openapi-*` package (spec + a typed openapi-fetch client).
 *
 * No JSDoc/YAML: the route, path parameter, and response schema are inferred from
 * the decorators and the TypeScript types - annotate methods, nothing more.
 */
@Route("greeting")
export class GreetingController extends Controller {
  @Get("{name}")
  @SuccessResponse(200, "OK")
  public async greet(@Path() name: string): Promise<Greeting> {
    return { message: strings.greet(name) };
  }
}
