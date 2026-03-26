import { desktopFetch } from "@/lib/backend-client";

type ImageResponse = {
  id: string;
  file_path: string;
  original_name: string;
  mime_type: string | null;
  size_bytes: number;
  hash: string;
  created_at: string;
  updated_at: string;
};

type ImageEnvelope = {
  image: ImageResponse;
};

const encode = (value: string): string => encodeURIComponent(value);

export const uploadImage = async (file: File): Promise<ImageResponse> => {
  const formData = new FormData();
  formData.append("image", file);
  const { image } = await desktopFetch<ImageEnvelope>("/rpc/images/upload", {
    method: "POST",
    body: formData,
  });
  return image;
};

export const uploadTaskImage = async (
  taskId: string,
  file: File,
): Promise<ImageResponse> => {
  const formData = new FormData();
  formData.append("image", file);
  const { image } = await desktopFetch<ImageEnvelope>(
    `/rpc/tasks/${encode(taskId)}/images/upload`,
    {
      method: "POST",
      body: formData,
    },
  );
  return image;
};

export const uploadTaskRunImage = async (
  taskRunId: string,
  file: File,
): Promise<ImageResponse> => {
  const formData = new FormData();
  formData.append("image", file);
  const { image } = await desktopFetch<ImageEnvelope>(
    `/rpc/task-runs/${encode(taskRunId)}/images/upload`,
    {
      method: "POST",
      body: formData,
    },
  );
  return image;
};

export const deleteImage = async (imageId: string): Promise<void> => {
  await desktopFetch(`/rpc/images/${encode(imageId)}`, {
    method: "DELETE",
  });
};
