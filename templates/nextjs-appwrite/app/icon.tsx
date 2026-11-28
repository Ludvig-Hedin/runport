import { appIcon } from "@/components/seo/site-art";

export const size = { width: 64, height: 64 };
export const contentType = "image/png";

export default function Icon() {
  return appIcon(size.width);
}
