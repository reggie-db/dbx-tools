import { brandUtils } from "@dbx-tools/shared-core";
import {
  createContext,
  type ImgHTMLAttributes,
  type PropsWithChildren,
  useContext,
  useEffect,
  useMemo,
} from "react";
import { applyBrandContext, type BrandAssetResolver, resolveBrandAsset } from "../browser.ts";

interface BrandState {
  context: brandUtils.BrandContext;
  resolveAsset: BrandAssetResolver;
}

const BrandReactContext = createContext<BrandState>({
  context: brandUtils.defaultBrandContext,
  resolveAsset: resolveBrandAsset,
});

export interface BrandProviderProps extends PropsWithChildren {
  context?: brandUtils.BrandContextInput;
  resolveAsset?: BrandAssetResolver;
  applyToDocument?: boolean;
}

export function BrandProvider({
  children,
  context,
  resolveAsset = resolveBrandAsset,
  applyToDocument = false,
}: BrandProviderProps) {
  const parsed = useMemo(() => brandUtils.parseBrandContext(context), [context]);
  const value = useMemo(() => ({ context: parsed, resolveAsset }), [parsed, resolveAsset]);

  useEffect(() => {
    if (applyToDocument) applyBrandContext(parsed, { resolveAsset });
  }, [applyToDocument, parsed, resolveAsset]);

  return <BrandReactContext.Provider value={value}>{children}</BrandReactContext.Provider>;
}

export function useBrand(): BrandState {
  return useContext(BrandReactContext);
}

export interface BrandImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt"> {
  alt?: string;
  mode?: "auto" | "light" | "dark";
}

function BrandImage({
  asset,
  alt,
  mode = "auto",
  ...props
}: BrandImageProps & { asset: brandUtils.BrandAssetSet }) {
  const { resolveAsset } = useBrand();
  const light = resolveAsset(asset.light);
  const dark = resolveAsset(asset.dark ?? asset.light);

  if (mode !== "auto") {
    return <img src={mode === "dark" ? dark : light} alt={alt ?? ""} {...props} />;
  }
  return (
    <picture>
      <source media="(prefers-color-scheme: dark)" srcSet={dark} />
      <img src={light} alt={alt ?? ""} {...props} />
    </picture>
  );
}

export function BrandIcon(props: BrandImageProps) {
  const { context } = useBrand();
  const { alt, ...imageProps } = props;
  return (
    <BrandImage asset={context.assets.icon} alt={alt ?? `${context.name} icon`} {...imageProps} />
  );
}

export function BrandLogo(props: BrandImageProps) {
  const { context } = useBrand();
  const { alt, ...imageProps } = props;
  return <BrandImage asset={context.assets.logo} alt={alt ?? context.name} {...imageProps} />;
}
