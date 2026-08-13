# Databricks Volume Video Streaming and Timeline UI

## Status

Proposed.

## Summary

Add reusable server and React packages for playing videos stored in Unity Catalog
Volumes without copying media into an app bundle or loading complete files into app
memory. The server package should translate standard HTTP byte-range requests into
authenticated Databricks Files API reads. The UI package should provide an HTML5 video
component plus an optional analysis timeline for timestamped transcript, detection, and
annotation overlays.

The initial design is proven in the Inspire creative-analysis application. This proposal
moves the generic pieces into `dbx-tools`, removes application-specific assumptions, and
establishes testable contracts suitable for other Databricks Apps.

## Goals

- Stream media directly from `/Volumes/<catalog>/<schema>/<volume>/...`.
- Support browser metadata probes, playback, seeking, and repeated scrubbing through
  RFC 7233 byte ranges.
- Bound app memory and upstream bandwidth; never buffer an entire video by default.
- Preserve Databricks authentication and Unity Catalog authorization.
- Offer a small server primitive that works with AppKit's Express extension point.
- Offer a reusable React player that remains presentation-focused and accepts timeline
  data through props.
- Support transcript segments, model detections, bounding boxes, and arbitrary timed
  observations without coupling the package to one pipeline schema.
- Keep the Node transport and UI contracts separable so either can be used alone.

## Non-goals

- Transcoding, adaptive-bitrate packaging, or HLS/DASH generation.
- Acting as a public CDN or bypassing Unity Catalog permissions.
- Owning video-analysis pipelines, model serving, or annotation persistence.
- Inferring timestamps from byte offsets. The browser and media container own that
  mapping; the server only serves byte ranges.
- Shipping app-specific campaign metadata, thumbnails, or detector taxonomies.

## Proposed package layout

### `@dbx-tools/databricks-media`

Node-only transport helpers:

```text
packages/js/node/databricks-media/
  src/range.ts
  src/volume-media.ts
  src/express.ts
  test/range.test.ts
  test/express.test.ts
  README.md
```

Responsibilities:

- Parse and validate one HTTP `Range` request.
- Read file metadata with `WorkspaceClient.files.getMetadata`.
- Forward an authenticated range request to `/api/2.0/fs/files<path>`.
- Stream upstream chunks to the response with backpressure.
- Cancel upstream reads when the client disconnects.
- Emit correct `206`, `Content-Range`, `Content-Length`, `Accept-Ranges`, ETag or
  last-modified, content type, and `416` responses.
- Expose framework-neutral primitives first and a thin Express adapter second.

This belongs beside `@dbx-tools/databricks`, but should be a separate package if adding
Express or streaming-specific dependencies would enlarge the filesystem package for all
users. Confirm the boundary during implementation.

### `@dbx-tools/ui-media`

Browser-safe React components and shared types:

```text
packages/js/ui/media/
  src/react/volume-video.tsx
  src/react/video-timeline.tsx
  src/react/use-video-playhead.ts
  src/types.ts
  test/volume-video.test.tsx
  README.md
```

Responsibilities:

- Render an accessible HTML5 `<video>` element against a range-capable URL.
- Default to `preload="metadata"` and `playsInline`.
- Report time, duration, buffered ranges, seeking state, and playback errors.
- Provide imperative seek support through a forwarded ref or explicit controller.
- Render optional timeline tracks without assuming a detector schema.
- Allow consumers to render transcript ticks, detections, chapters, and selection ranges.
- Keep application data fetching outside the component.

## Public API sketch

### Range transport

```ts
export type ByteRange = {
  start: number;
  end: number;
  length: number;
};

export function parseByteRange(
  value: string | undefined,
  fileSize: number,
  options?: { defaultChunkBytes?: number; maxChunkBytes?: number },
): ByteRange;

export type VolumeMediaSource = {
  path: `/Volumes/${string}`;
  contentType?: string;
  cacheControl?: string;
};

export function createVolumeMediaHandler(options: {
  client?: WorkspaceClient;
  resolve: (request: Request) => Promise<VolumeMediaSource | null>;
  defaultChunkBytes?: number;
  maxChunkBytes?: number;
}): RequestHandler;
```

The handler should not accept arbitrary client-supplied volume paths by default. An app
must resolve an opaque media id to an authorized path, preventing path traversal and
turning the route into a general file oracle.

### React player

```tsx
export type TimedMarker = {
  id: string;
  start: number;
  end?: number;
  label?: string;
  confidence?: number;
  data?: unknown;
};

export type VideoTrack = {
  id: string;
  label: string;
  markers: TimedMarker[];
  color?: string;
};

<VolumeVideo
  src={`/api/media/${mediaId}`}
  poster={posterUrl}
  preload="metadata"
  tracks={tracks}
  onTimeChange={setTime}
  renderMarker={renderDetection}
/>
```

`VolumeVideo` should remain useful without `tracks`. If the timeline grows substantial,
export `VideoTimeline` separately and compose it in examples rather than making the
base player heavy.

## Streaming behavior

### Initial load

Browsers commonly issue a small metadata request, often `bytes=0-`, before playback.
When the requested range is open-ended, cap the response to a configurable chunk (for
example 8 MiB) instead of proxying the complete object. Subsequent browser requests
continue from the next required offset.

### Seeking and scrubbing

The browser maps timestamps to byte offsets using the MP4 container metadata and sends a
new `Range` request when the playhead moves outside buffered data. The server must:

1. Validate the range against the current file size.
2. Request only that range from the Databricks Files API.
3. Return `206 Partial Content` with the exact range and total size.
4. Stop reading immediately when the browser abandons an obsolete scrub request.
5. Respect response backpressure rather than accumulating chunks in memory.

This provides timestamp seeking without inventing a server-side time-to-byte index.
Fast-start MP4 files with the `moov` atom near the beginning give the best experience.
Document `ffmpeg -movflags +faststart` as an optional ingest normalization step, but do
not require ffmpeg in the runtime package.

### Range policy

- Support one range per request in the first release.
- Return `416` for malformed, unsatisfiable, or multi-range requests.
- Cap open-ended and oversized ranges to `maxChunkBytes`.
- Support suffix ranges for standards compatibility.
- Preserve upstream `content-type` and last-modified metadata.
- Add a short private cache policy; do not make authenticated media public-cacheable.

## Security model

- Use the App service principal or AppKit per-request/OBO `WorkspaceClient` according to
  the application's authorization model.
- Require `USE CATALOG`, `USE SCHEMA`, and `READ VOLUME` on the backing objects.
- Resolve opaque ids server-side; reject direct arbitrary paths unless an explicit,
  separately named unsafe API is requested.
- Normalize and require `/Volumes/` paths before any upstream request.
- Avoid logging bearer tokens, full query strings, or sensitive volume paths.
- Enforce configurable content-type and extension allowlists.
- Preserve the existing dbx-tools SDK boundary: browser packages must not import the
  Databricks SDK or Node APIs.

## Timeline and analysis enhancements

Deliver the UI in layers:

1. **Player foundation** — play, pause, current time, duration, seek, buffered ranges,
   keyboard controls, loading and error states.
2. **Transcript track** — timestamp ticks, active segment highlighting, click-to-seek,
   and optional auto-scroll callback.
3. **Detection track** — point or interval markers with confidence and detector labels.
4. **Bounding-box overlay** — render boxes active at the current timestamp; scale source
   coordinates to the displayed video rectangle, including letterboxing.
5. **Multi-track timeline** — collapsible transcript, logo, object, mood, audio, chapter,
   and user-annotation tracks.
6. **Scrub previews** — optional thumbnail sprite/WebVTT provider, kept separate from the
   core range transport.
7. **Accessibility** — keyboard seek increments, captions slot, reduced-motion behavior,
   focus-visible controls, and screen-reader descriptions for markers.

## Databricks App integration

Document a minimal AppKit example:

```ts
appkit.createApp({
  onPluginsReady(instance) {
    instance.server.extend((app) => {
      app.use(createVolumeMediaHandler({
        resolve: async (request) => lookupMedia(request.params.id),
      }));
    });
  },
});
```

The example should query metadata from backing tables and use volume paths only on the
server. The browser receives opaque ids and range-capable URLs.

## Testing strategy

### Unit tests

- Explicit, open-ended, and suffix ranges.
- Bounds at zero and at `fileSize - 1`.
- Invalid units, multiple ranges, negative values, overflow, reversed ranges, and empty
  files.
- Chunk caps for open-ended and oversized requests.
- Content headers for `206` and `416`.

### Transport tests

Use a fake `WorkspaceClient` or fetch adapter with a generated byte buffer:

- Assert that the upstream `Range` header exactly matches the bounded client range.
- Assert that only requested bytes reach the response.
- Simulate response backpressure and verify bounded memory behavior.
- Abort the client mid-stream and verify the upstream reader is canceled.
- Verify metadata errors, authorization errors, missing files, and changed file sizes.

### Browser tests

Use a small fast-start MP4 fixture:

- Initial playback requests a bounded range.
- Seeking near the end issues a later range and resumes at the requested timestamp.
- Rapid scrubbing cancels obsolete requests without crashing the route.
- Current-time events activate the correct timeline markers.
- Bounding boxes scale correctly across responsive sizes and letterboxing.

Keep media fixtures tiny and generated or permissively licensed. Do not add customer or
commercial videos to the package repository.

## Observability

Add optional callbacks rather than a mandatory telemetry dependency:

```ts
type VolumeMediaEvent = {
  mediaId?: string;
  path?: string;
  start: number;
  end: number;
  bytes: number;
  durationMs: number;
  status: "completed" | "aborted" | "failed";
};
```

Consumers can connect these events to AppKit logging or OpenTelemetry. Recommended
metrics include range request count, bytes served, first-byte latency, aborted scrub
requests, upstream authorization errors, and cache hit rate if caching is added later.

## Delivery plan

### Phase 1 — shared contracts and transport

- Decide whether transport extends `@dbx-tools/databricks` or becomes
  `@dbx-tools/databricks-media`.
- Add `ByteRange`, parser, metadata lookup, authenticated ranged fetch, and Express
  adapter.
- Add exhaustive unit and transport tests.
- Document required Unity Catalog privileges.

### Phase 2 — player component

- Add `@dbx-tools/ui-media` with `VolumeVideo` and playhead state.
- Add Storybook/example-app coverage using a fake range server.
- Verify Chrome, Safari, and Firefox playback and seeking.

### Phase 3 — analysis timeline

- Add generic tracks, markers, active ranges, click-to-seek, and transcript composition.
- Add bounding-box overlays with source-to-display coordinate transforms.
- Provide an example mapping normalized Databricks detection observations to tracks.

### Phase 4 — production hardening

- Add ETag/If-Range handling and optional bounded cache integration.
- Add telemetry hooks and load tests for concurrent viewers.
- Evaluate signed direct-download URLs only if Databricks exposes a secure, short-lived
  mechanism that preserves authorization; retain proxy streaming as the baseline.
- Evaluate thumbnail sprites and HLS as separate optional packages, not scope creep in
  the core player.

## Acceptance criteria

- A 500 MiB volume video starts without allocating or downloading 500 MiB in the app
  process.
- A seek to an unbuffered timestamp produces a new bounded byte-range request and starts
  playback without restarting from zero.
- Ten rapid scrubs cancel obsolete reads and leave memory bounded by active chunks plus
  stream buffers.
- Unauthorized volume access returns a safe 403/404 without leaking credentials.
- The base React component imports no Node modules or Databricks SDK code.
- Timeline markers and bounding boxes update accurately with the media playhead.
- The example app reads media metadata from backing data and never bundles videos.

## Open questions

- Should the transport live in the existing Node Databricks package or a media-specific
  package with an optional Express adapter?
- Can AppKit expose a per-request OBO client cleanly for media routes, or should the
  first release standardize on the app service principal?
- What default and maximum chunk sizes perform best through Databricks Apps and the Files
  API across AWS, Azure, and GCP?
- Does the Files API consistently honor single-range requests and return stable ETags on
  all clouds?
- Should thumbnail generation and fast-start normalization be a pipeline helper package
  or remain deployment guidance?
