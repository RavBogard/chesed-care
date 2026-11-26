import qrcode from "qrcode-generator";

/**
 * A QR code of `text` as inline SVG, made here on the server: no image request, no
 * third-party service and no script. Ink on paper, with the four-module quiet zone the
 * standard asks for, so a phone reads it from a printed page.
 */
export function QrCode({ text, label, className }: { text: string; label: string; className?: string }) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  const size = n + quiet * 2;
  return (
    <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} className={className} shapeRendering="crispEdges">
      <rect width={size} height={size} className="fill-surface" />
      <path d={d} className="fill-ink" />
    </svg>
  );
}
