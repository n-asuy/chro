import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { backendUrl, desktopFetch } from "@/lib/backend-client";
import { attachedImagePath } from "@/session/components/markdown-image-source";
import type { LocalImageMetadata } from "@/session/context/local-images-context";

type ImageMetadata = {
  exists: boolean;
  id?: string;
  path?: string;
  proxy_url?: string;
  file_name?: string;
  size_bytes?: number;
  format?: string;
};

export function useImageMetadata(
  src: string,
  localImages?: LocalImageMetadata[],
) {
  const path = attachedImagePath(src);

  // Synchronous lookup for local images (newly uploaded, not yet persisted)
  const localImage = useMemo(
    () => localImages?.find((img) => img.path === path),
    [localImages, path],
  );

  // Convert to ImageMetadata format
  const localImageMetadata: ImageMetadata | null = useMemo(
    () =>
      localImage
        ? {
            exists: true,
            path: localImage.path,
            proxy_url: localImage.proxy_url,
            file_name: localImage.file_name,
            size_bytes: localImage.size_bytes,
            format: localImage.format,
          }
        : null,
    [localImage],
  );

  // Only fetch from API if: chro image and NO local image
  const shouldFetch = path !== null && !localImage;

  const query = useQuery({
    queryKey: ["imageMetadata", path],
    queryFn: async (): Promise<ImageMetadata | null> => {
      const data = await desktopFetch<ImageMetadata>(
        `/rpc/images/metadata?path=${encodeURIComponent(path ?? "")}`,
      );
      return data;
    },
    enabled: shouldFetch,
    staleTime: Infinity,
  });

  // proxy_url is server-relative; <img> needs it on the backend's origin.
  const metadata = localImageMetadata ?? query.data;
  const data = useMemo(
    () =>
      metadata?.proxy_url
        ? { ...metadata, proxy_url: backendUrl(metadata.proxy_url) }
        : metadata,
    [metadata],
  );

  // Return local data if available, otherwise query result
  return {
    data,
    isLoading: localImage ? false : query.isLoading,
  };
}
