import { Spinner, Tabs, TabsContent, TabsList, TabsTrigger } from "@databricks/appkit-ui/react";
import type { GenieVisualizationEmbed, StatementData } from "@dbx-tools/shared-mastra";
import { useEffect, useState } from "react";
import { DataGrid } from "./data-grid.tsx";
import { useMastraClient, useVisualizationFetch } from "../support/mastra-client.ts";

const GENIE_IMAGE_LOADING_HEIGHT_PX = 320;

const GenieImageLoading = () => (
  <div
    className="flex items-center justify-center rounded border border-border bg-card"
    style={{ height: GENIE_IMAGE_LOADING_HEIGHT_PX, width: "100%" }}
  >
    <Spinner className="size-5 text-muted-foreground" />
    <span className="sr-only">Loading Genie chart</span>
  </div>
);

/** Chart/Table presentation for Genie's original, unmodified PNG. */
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
  useEffect(() => {
    setImageState("loading");
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
            <img
              src={src}
              alt="Genie query visualization"
              className="block h-auto max-w-full rounded border border-border"
              style={imageState === "loaded" ? undefined : { display: "none" }}
              onLoad={() => setImageState("loaded")}
              onError={() => setImageState("error")}
            />
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
