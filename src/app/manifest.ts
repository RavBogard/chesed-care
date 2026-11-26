import type { MetadataRoute } from "next";
import { GROUND, SHELL } from "@/lib/brand";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "CRC Care",
    short_name: "CRC Care",
    description: "Pastoral care for the clergy of Central Reform Congregation",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: GROUND,
    theme_color: SHELL,
    icons: [
      { src: "/icon", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
