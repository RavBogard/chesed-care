/**
 * What every public form carries against scripts: the server's signed render time (`stamp`, left out on a
 * form that is not timed) and the honeypot field `website`, off screen and out of the tab order. The server
 * reads both by name (src/server/public/form.ts), so the names and attributes here are fixed.
 */
export function BotGuard({ stamp }: { stamp?: string }) {
  return (
    <>
      {stamp === undefined ? null : <input type="hidden" name="stamp" value={stamp} />}
      <div aria-hidden="true" className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden">
        <label>
          Leave this empty
          <input type="text" name="website" tabIndex={-1} autoComplete="off" defaultValue="" />
        </label>
      </div>
    </>
  );
}
