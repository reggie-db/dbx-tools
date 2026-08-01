// Enable code splitting so shared vendor code (echarts, shiki, mastra client,
// adaptivecards) is deduped into shared chunks instead of duplicated per entry -
// keeping every chunk under the Databricks Apps 10 MB/file import limit. Drop
// sourcemaps: they add a 14 MB `.map` that blows the same limit and a deployed
// app has no use for them.
export default {
  splitting: true,
  sourcemap: "none",
};
