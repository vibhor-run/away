import { Check, Copy, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { Pairing } from "../../shared/api";
import { Button } from "./ui";

/** Modal sheet showing a single-use pairing QR code with a live expiry countdown. */
export function PairSheet({ onClose }: { onClose: () => void }) {
  const [pairing, setPairing] = useState<Pairing>();
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);

  async function create() {
    setError(undefined);
    setPairing(undefined);
    try {
      setPairing(await window.away.createPairing());
    } catch (createError) {
      setError((createError as Error).message);
    }
  }

  useEffect(() => {
    void create();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      clearInterval(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const remaining = pairing ? Math.max(0, pairing.expiresAt - now) : 0;
  const expired = pairing !== undefined && remaining === 0;
  const countdown = `${Math.floor(remaining / 60000)}:${String(Math.floor((remaining % 60000) / 1000)).padStart(2, "0")}`;

  return (
    <div className="animate-fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/25 backdrop-blur-[2px] dark:bg-black/50" onClick={onClose}>
      <div
        className="animate-sheet-in w-[360px] rounded-2xl bg-white p-6 shadow-2xl ring-1 ring-black/10 dark:bg-neutral-900 dark:ring-white/10"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-[15px] font-semibold">Pair a phone</h2>
            <p className="mt-0.5 text-xs text-neutral-500">Scan with the Away app on your phone.</p>
          </div>
          <Button variant="ghost" className="-mr-1.5 px-1.5" onClick={onClose} aria-label="Close">
            <X size={15} />
          </Button>
        </div>

        <div className="relative mx-auto mt-5 flex size-[260px] items-center justify-center overflow-hidden rounded-xl bg-white ring-1 ring-black/5">
          {pairing && <img src={pairing.qr} alt="Pairing QR code" className={`size-full transition duration-300 ${expired ? "opacity-10 blur-sm" : ""}`} />}
          {!pairing && !error && <div className="size-6 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-700" />}
          {expired && (
            <Button variant="primary" className="absolute" onClick={() => void create()}>
              <RefreshCw size={13} /> New code
            </Button>
          )}
        </div>

        {error && <p className="mt-3 text-center text-xs text-red-500">{error}</p>}

        <div className="mt-4 flex items-center justify-between text-xs text-neutral-500">
          <span>{pairing ? (expired ? "Expired" : `Expires in ${countdown} · single use`) : "Creating code…"}</span>
          <Button
            variant="ghost"
            disabled={!pairing || expired}
            onClick={async () => {
              if (!pairing) return;
              await window.away.copyText(pairing.offer);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy link"}
          </Button>
        </div>

        <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
          Anyone who scans this code in the next few minutes can control agents on this Mac. Only show it to your own phone.
        </p>
      </div>
    </div>
  );
}
