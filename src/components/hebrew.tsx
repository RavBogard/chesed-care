const HEBREW_LETTER = /\p{Script=Hebrew}/u;

/**
 * The right-hand half of a facing line: a Hebrew name or date, set a step larger than the
 * English beside it so the two look the same size. Salesforce sometimes holds a Hebrew name
 * in Latin letters; that is shown left to right and not announced as Hebrew.
 * `size` is the text size class; the default suits a name in a list.
 */
export function Hebrew({ children, size = "text-xl", className = "" }: { children: string; size?: string; className?: string }) {
  const text = children.trim();
  if (!text) return null;
  const hebrew = HEBREW_LETTER.test(text);
  return (
    <span lang={hebrew ? "he" : "he-Latn"} dir={hebrew ? "rtl" : "ltr"} className={`ml-auto max-w-full font-serif leading-snug font-medium [overflow-wrap:anywhere] ${hebrew ? `text-right ${size}` : "text-base italic"} ${className}`}>
      {text}
    </span>
  );
}
