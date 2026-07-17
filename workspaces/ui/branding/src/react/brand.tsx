import {
  createContext,
  type ImgHTMLAttributes,
  type PropsWithChildren,
  useContext,
  useEffect,
  useMemo,
} from "react";
import { brand } from "@dbx-tools/shared-core";
import { applyBrandContext, type BrandAssetResolver, resolveBrandAsset } from "../browser";

interface BrandState {
  context: brand.BrandContext;
  resolveAsset: BrandAssetResolver;
}

const BrandReactContext = createContext<BrandState>({
  context: brand.defaultBrandContext,
  resolveAsset: resolveBrandAsset,
});

export interface BrandProviderProps extends PropsWithChildren {
  context?: brand.BrandContextInput;
  resolveAsset?: BrandAssetResolver;
  applyToDocument?: boolean;
}

export function BrandProvider({
  children,
  context,
  resolveAsset = resolveBrandAsset,
  applyToDocument = false,
}: BrandProviderProps) {
  const parsed = useMemo(() => brand.parseBrandContext(context), [context]);
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
}: BrandImageProps & { asset: brand.BrandAssetSet }) {
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
