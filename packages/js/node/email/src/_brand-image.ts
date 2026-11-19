/**
 * Email-safe brand image normalization.
 *
 * Browser-supported artwork is not necessarily inbox-supported: SVG, WebP,
 * remote URLs, and several other formats can render as broken images after a
 * mail client proxies or sanitizes the message. This module resolves a data or
 * HTTP(S) image, bounds the input, rasterizes it through Sharp, and returns one
 * related PNG attachment for CID delivery.
 *
 * @module
 */

import { combineAbortSignals, log, toError } from "@dbx-tools/shared-core";
import type { EmailBrand } from "@dbx-tools/shared-email-template";
import type { SendMailOptions } from "nodemailer";
import sharp from "sharp";

const logger = log.logger("email/brand-image");

/** RFC 2392-style identifier shared by the HTML and related attachment. */
const INLINE_BRAND_CID = "dbx-tools-brand-logo@dbx.tools";

/** Keep remote artwork small enough for synchronous message preparation. */
const MAX_BRAND_IMAGE_BYTES = 2 * 1024 * 1024;

/** Bound decoded image memory independently of compressed input size. */
const MAX_BRAND_IMAGE_PIXELS = 16 * 1024 * 1024;

/** Bound remote image reads so a logo cannot delay authentication mail. */
const BRAND_IMAGE_FETCH_TIMEOUT_MS = 5_000;

/** Four-times the displayed logo height, with room for wide wordmarks. */
const NORMALIZED_BRAND_IMAGE_SIZE = { width: 1_200, height: 136 } as const;

const normalizedBrandImages = new Map<string, string>();

/** The brand and optional related attachment used for SMTP rendering. */
export interface InlineEmailBrandImage {
  brand: EmailBrand;
  attachment?: NonNullable<SendMailOptions["attachments"]>[number];
}

/** Decode an image data URL, including percent-encoded SVG. */
function dataUrlBytes(value: string): Buffer | undefined {
  const match = /^data:(image\/[^;,]+)((?:;[^,]*)?),(.*)$/is.exec(value);
  if (!match) return undefined;
  const [, , parameters, payload] = match;
  const bytes = parameters?.split(";").some((parameter) => parameter.toLowerCase() === "base64")
    ? Buffer.from(payload!, "base64")
    : Buffer.from(decodeURIComponent(payload!), "utf8");
  if (bytes.byteLength > MAX_BRAND_IMAGE_BYTES) {
    throw new RangeError(`Brand image exceeds ${MAX_BRAND_IMAGE_BYTES} bytes`);
  }
  return bytes;
}

/** Read a response without allowing an unbounded body into memory. */
async function responseBytes(response: Response): Promise<Buffer> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Brand image request failed with HTTP ${response.status}`);
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BRAND_IMAGE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new RangeError(`Brand image exceeds ${MAX_BRAND_IMAGE_BYTES} bytes`);
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BRAND_IMAGE_BYTES) {
        throw new RangeError(`Brand image exceeds ${MAX_BRAND_IMAGE_BYTES} bytes`);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  );
}

/** Resolve one supported data or network URL into bounded source bytes. */
async function brandImageBytes(value: string, signal?: AbortSignal): Promise<Buffer> {
  const inline = dataUrlBytes(value);
  if (inline) return inline;

  const url = new URL(value);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw new TypeError("Brand logo must be an HTTP(S) or image data URL");
  }
  const response = await fetch(url, {
    redirect: "follow",
    signal: combineAbortSignals(signal, AbortSignal.timeout(BRAND_IMAGE_FETCH_TIMEOUT_MS)),
  });
  return responseBytes(response);
}

/** Rasterize any Sharp-supported image input into one bounded transparent PNG. */
async function normalizedBrandImage(value: string, signal?: AbortSignal): Promise<string> {
  const cached = normalizedBrandImages.get(value);
  if (cached) return cached;
  const source = await brandImageBytes(value, signal);
  const png = await sharp(source, {
    autoOrient: true,
    density: 144,
    failOn: "warning",
    limitInputPixels: MAX_BRAND_IMAGE_PIXELS,
    pages: 1,
  })
    .resize({
      ...NORMALIZED_BRAND_IMAGE_SIZE,
      fit: "inside",
      withoutEnlargement: true,
    })
    .png({ compressionLevel: 9 })
    .toBuffer();
  signal?.throwIfAborted();
  if (png.byteLength > MAX_BRAND_IMAGE_BYTES) {
    throw new RangeError(`Normalized brand image exceeds ${MAX_BRAND_IMAGE_BYTES} bytes`);
  }
  const encoded = png.toString("base64");
  normalizedBrandImages.set(value, encoded);
  return encoded;
}

/**
 * Normalize the configured brand mark for SMTP delivery.
 *
 * Conversion failures do not block the message. The React Email template uses
 * the styled brand name when `logoUrl` is empty, preserving a readable header
 * while logging the asset problem for operators.
 */
export async function inlineEmailBrandImage(
  brand: EmailBrand,
  signal?: AbortSignal,
): Promise<InlineEmailBrandImage> {
  if (!brand.logoUrl) return { brand };
  try {
    const content = await normalizedBrandImage(brand.logoUrl, signal);
    return {
      brand: { ...brand, logoUrl: `cid:${INLINE_BRAND_CID}` },
      attachment: {
        filename: "brand-logo.png",
        content,
        encoding: "base64",
        contentType: "image/png",
        cid: INLINE_BRAND_CID,
      },
    };
  } catch (error) {
    signal?.throwIfAborted();
    logger.warn("brand-image-normalization-failed", { error: toError(error) });
    return { brand: { ...brand, logoUrl: "" } };
  }
}

/** Drop normalized artwork when the process-wide email runtime resets. */
export function clearBrandImageCache(): void {
  normalizedBrandImages.clear();
}
