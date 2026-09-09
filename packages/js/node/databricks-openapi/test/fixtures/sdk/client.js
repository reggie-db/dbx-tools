import {
  buildHttpRequest,
  executeHttpCall,
  marshalRequest,
  parseResponse,
  sendAndCheckError,
} from "./utils.js";
import { marshalUploadRequestSchema, marshalWidgetSchema, unmarshalWidgetSchema } from "./model.js";

var WidgetClient = class {
  /** Create a widget. */
  async createWidgetBase(req) {
    const { host, httpClient } = await this.resolveConfig();
    const url = `${host}/api/2.0/widgets/${req.parent ?? ""}/widgets`;
    const params = new URLSearchParams();
    if (req.view !== void 0) params.append("view", req.view);
    const query = params.toString();
    const fullUrl = query !== "" ? `${url}?${query}` : url;
    const body = marshalRequest(req.widget, marshalWidgetSchema);
    return parseResponse(
      await executeHttpCall({
        request: buildHttpRequest("POST", fullUrl, new Headers(), undefined, body),
        httpClient,
      }),
      unmarshalWidgetSchema,
    );
  }

  /** Create a widget. */
  async createWidget(req) {
    return this.createWidgetBase(req);
  }

  /** Upload widget content. */
  async uploadWidget(req) {
    const { host, httpClient } = await this.resolveConfig();
    const url = `${host}/api/2.0/widgets/${req.name ?? ""}:upload`;
    const body = marshalRequest(req, marshalUploadRequestSchema);
    return parseResponse(
      await executeHttpCall({
        request: buildHttpRequest("PUT", url, new Headers(), undefined, body),
        httpClient,
      }),
      unmarshalWidgetSchema,
    );
  }

  /** Download widget content. */
  async downloadWidget(req) {
    const { host, httpClient } = await this.resolveConfig();
    const url = `${host}/api/2.0/widgets/${req.name ?? ""}:download`;
    return {
      contents: (
        await sendAndCheckError({
          request: buildHttpRequest("GET", url, new Headers()),
          httpClient,
        })
      ).body,
    };
  }
};

export { WidgetClient };
