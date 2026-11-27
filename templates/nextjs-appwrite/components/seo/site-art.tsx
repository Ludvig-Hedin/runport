import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { appearance, appName } from "@/runport.config";
import type { Themed } from "@/components/auth/appearance";

const light = (value: Themed | undefined, fallback: string) =>
  (typeof value === "string" ? value : value?.light) ?? fallback;

const primary = light(appearance.variables?.colorPrimary, "#111111");
const primaryText = light(appearance.variables?.colorPrimaryText, "#ffffff");
const background = light(appearance.variables?.colorBackground, "#ffffff");
const text = light(appearance.variables?.colorText, "#111111");

function Mark({ size }: { size: number }) {
  return (
    <div style={{
      display: "flex", width: size, height: size, borderRadius: size * 0.23,
      backgroundColor: primary, color: primaryText, alignItems: "center", justifyContent: "center",
      fontSize: size * 0.57, fontWeight: 700,
    }}>
      {Array.from(appName.trim())[0]?.toUpperCase() || "R"}
    </div>
  );
}

export function appIcon(size: number) {
  return new ImageResponse(<Mark size={size} />, { width: size, height: size });
}

export async function shareImage() {
  const name = appName.trim();
  const inter = await readFile(join(process.cwd(), "assets", "inter-latin-600-normal.woff"));
  return new ImageResponse(
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "flex-start", justifyContent: "center",
      width: "100%", height: "100%", padding: 96, gap: 44,
      backgroundColor: background, color: text,
    }}>
      <Mark size={96} />
      <div style={{
        display: "flex", fontSize: name.length > 27 ? 66 : 100, fontFamily: "Inter", fontWeight: 600,
        lineHeight: 1.1, letterSpacing: "-0.035em", overflowWrap: "break-word", maxWidth: "100%",
      }}>
        {name}
      </div>
    </div>,
    { width: 1200, height: 630, fonts: [{ name: "Inter", data: inter, weight: 600 }] },
  );
}
