import { appIcon } from "@/components/seo/site-art";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return appIcon(size.width);
}
