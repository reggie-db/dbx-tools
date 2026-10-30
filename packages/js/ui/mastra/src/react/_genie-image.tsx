import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@databricks/appkit-ui/react";
import type { GenieVisualizationEmbed, StatementData } from "@dbx-tools/shared-mastra";
import { useEffect, useState } from "react";
import { DataGrid } from "./data-grid.tsx";
import { useMastraClient, useVisualizationFetch } from "../support/mastra-client.ts";

const GENIE_IMAGE_LOADING_HEIGHT_PX = 320;
const GENIE_IMAGE_MAX_SCALE = 2;

interface ImageDimensions {
  height: number;
  width: number;
}

const GenieImageLoading = () => (
  <div
    className="flex items-center justify-center rounded border border-border bg-card"
    style={{ height: GENIE_IMAGE_LOADING_HEIGHT_PX, width: "100%" }}
  >
    <Spinner className="size-5 text-muted-foreground" />
    <span className="sr-only">Loading Genie chart</span>
  </div>
);

/** Chart/Table presentation for Genie's server-processed PNG. */
export function GenieImageTabs({
  src,
  data,
  tableLoading = false,
}: {
  src: string;
  data?: StatementData;
  tableLoading?: boolean;
}) {
  const [imageState, setImageState] = useState<"loading" | "loaded" | "error">("loading");
  const [imageDimensions, setImageDimensions] = useState<ImageDimensions>();
  useEffect(() => {
    setImageState("loading");
    setImageDimensions(undefined);
  }, [src]);
  return (
    <Tabs defaultValue="chart" className="not-prose my-3 min-w-0 max-w-full">
      <TabsList>
        <TabsTrigger value="chart">Chart</TabsTrigger>
        <TabsTrigger value="table">Table</TabsTrigger>
      </TabsList>
      <TabsContent value="chart">
        {imageState === "error" ? (
          <p role="status" className="py-3 text-sm text-muted-foreground">
            Genie chart unavailable. Open Table to view the query result.
          </p>
        ) : (
          <>
            {imageState === "loading" ? <GenieImageLoading /> : null}
            <Dialog>
              <DialogTrigger asChild>
                <button
                  type="button"
                  aria-label="Open Genie visualization"
                  className="block max-w-full cursor-zoom-in appearance-none rounded border border-border bg-transparent p-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  style={imageState === "loaded" ? undefined : { display: "none" }}
                >
                  <img
                    src={src}
                    alt="Genie query visualization"
                    className="block h-auto max-w-full rounded"
                    onLoad={(event) => {
                      setImageDimensions({
                        height: event.currentTarget.naturalHeight,
                        width: event.currentTarget.naturalWidth,
                      });
                      setImageState("loaded");
                    }}
                    onError={() => setImageState("error")}
                  />
                </button>
              </DialogTrigger>
              <DialogContent className="max-h-[calc(100dvh-1rem)] w-fit max-w-[calc(100dvw-1rem)] gap-0 overflow-hidden p-2 sm:max-w-[calc(100dvw-1rem)]">
                <DialogTitle className="sr-only">Genie query visualization</DialogTitle>
                <img
                  src={src}
                  alt="Genie query visualization"
                  className="block h-auto max-h-[calc(100dvh-2rem)] max-w-[calc(100dvw-2rem)] object-contain"
                  style={
                    imageDimensions
                      ? {
                          aspectRatio: `${imageDimensions.width} / ${imageDimensions.height}`,
                          width: imageDimensions.width * GENIE_IMAGE_MAX_SCALE,
                        }
                      : undefined
                  }
                />
              </DialogContent>
            </Dialog>
          </>
        )}
      </TabsContent>
      <TabsContent value="table" forceMount className="data-[state=inactive]:hidden">
        {data ? (
          <DataGrid
            columns={data.columns}
            rows={data.rows}
            rowCount={data.rowCount}
            truncated={data.truncated}
          />
        ) : (
          <p role="status" className="py-3 text-sm text-muted-foreground">
            {tableLoading ? "Loading query result…" : "Query result unavailable."}
          </p>
        )}
      </TabsContent>
    </Tabs>
  );
}

/** Resolve a durable image reference through the caller's authenticated app routes. */
export function GenieImageSlot({ reference }: { reference: GenieVisualizationEmbed }) {
  const client = useMastraClient();
  const { data, loading } = useVisualizationFetch(reference.statementId);
  const src = client.genieVisualizationImageUrl(reference);
  return <GenieImageTabs key={src} src={src} data={data} tableLoading={loading} />;
}
