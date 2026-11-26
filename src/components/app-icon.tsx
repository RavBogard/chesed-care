import { GROUND, SHELL } from "@/lib/brand";

/** The app icon: the shell's navy square with a simple heart, drawn as SVG so it needs no image file or font. */
export function AppIcon({ size }: { size: number }) {
  return (
    <div style={{ width: size, height: size, display: "flex", alignItems: "center", justifyContent: "center", background: SHELL }}>
      <svg width={size * 0.56} height={size * 0.56} viewBox="0 0 24 24" fill={GROUND}>
        <path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 2.8 4.8 6.3 4.8c2 0 3.7 1.1 4.7 2.7h2c1-1.6 2.7-2.7 4.7-2.7 3.5 0 5.4 3.6 3.9 7C19.5 16.4 12 21 12 21z" />
      </svg>
    </div>
  );
}
