import type { NextConfig } from "next";
import { join } from "node:path";
import { discoverPublicPages } from "./lib/seo-routes";

const config: NextConfig = {
  env: {
    RUNPORT_PUBLIC_PAGES: JSON.stringify(discoverPublicPages(join(process.cwd(), "app"))),
  },
};

export default config;
