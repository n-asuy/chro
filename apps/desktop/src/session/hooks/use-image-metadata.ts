import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { desktopFetch } from "@/lib/backend-client";
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
  const isChroImage = src.startsWith(".chro-context/");

  // Synchronous lookup for local images (newly uploaded, not yet persisted)
  const localImage = useMemo(
    () => localImages?.find((img) => img.path === src),
    [localImages, src],
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
  const shouldFetch = isChroImage && !localImage;

  const query = useQuery({
    queryKey: ["imageMetadata", src],
    queryFn: async (): Promise<ImageMetadata | null> => {
      const data = await desktopFetch<ImageMetadata>(
        `/rpc/images/metadata?path=${encodeURIComponent(src)}`,
      );
      return data;
    },
    enabled: shouldFetch,
    staleTime: Infinity,
  });

  // Return local data if available, otherwise query result
  return {
    data: localImageMetadata ?? query.data,
    isLoading: localImage ? false : query.isLoading,
  };
}
