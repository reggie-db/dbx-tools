import type { FileUIPart } from "ai";

export const MAX_COMPOSER_IMAGES = 4;
export const MAX_COMPOSER_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_COMPOSER_IMAGE_EDGE = 2048;

type ImageDimensions = {
  width: number;
  height: number;
};

/** Fit image dimensions within a maximum edge while preserving aspect ratio. */
export function fitImageDimensions(
  width: number,
  height: number,
  maxEdge = MAX_COMPOSER_IMAGE_EDGE,
): ImageDimensions {
  if (width <= maxEdge && height <= maxEdge) return { width, height };
  const scale = maxEdge / Math.max(width, height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function dataUrlForBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read image"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Unable to decode ${file.name || "image"}`));
    };
    image.src = url;
  });
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Unable to resize image"))),
      type,
      quality,
    );
  });
}

function resizedFilename(filename: string, mediaType: string): string {
  const extension = mediaType === "image/webp" ? "webp" : mediaType === "image/png" ? "png" : "jpg";
  const stem = filename.replace(/\.[^.]+$/, "") || "image";
  return `${stem}.${extension}`;
}

async function shrinkImage(
  file: File,
  maxBytes: number,
): Promise<{ blob: Blob; filename: string }> {
  const image = await loadImage(file);
  const fitted = fitImageDimensions(image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image resizing is unavailable in this browser");

  let smallest: Blob | undefined;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const scale = 0.82 ** Math.floor(attempt / 2);
    canvas.width = Math.max(1, Math.round(fitted.width * scale));
    canvas.height = Math.max(1, Math.round(fitted.height * scale));
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const quality = attempt % 2 === 0 ? 0.84 : 0.66;
    const blob = await canvasBlob(canvas, "image/webp", quality);
    if (!smallest || blob.size < smallest.size) smallest = blob;
    if (blob.size <= maxBytes) {
      return { blob, filename: resizedFilename(file.name, blob.type) };
    }
  }

  if (!smallest || smallest.size > maxBytes) {
    throw new Error(`${file.name || "Image"} could not be reduced below 4 MB`);
  }
  return { blob: smallest, filename: resizedFilename(file.name, smallest.type) };
}

/** Convert an image file to the native AI SDK file part, shrinking oversized images first. */
export async function imageFileToUIPart(
  file: File,
  maxBytes = MAX_COMPOSER_IMAGE_BYTES,
): Promise<FileUIPart> {
  if (!file.type.startsWith("image/")) throw new Error(`${file.name || "File"} is not an image`);
  const prepared =
    file.size > maxBytes ? await shrinkImage(file, maxBytes) : { blob: file, filename: file.name };
  return {
    type: "file",
    mediaType: prepared.blob.type || file.type,
    filename: prepared.filename || "image",
    url: await dataUrlForBlob(prepared.blob),
  };
}
