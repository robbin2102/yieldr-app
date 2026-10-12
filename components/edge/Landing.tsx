"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import ExamplePrint from "./ExamplePrint";
import { walletInput } from "@/lib/edge/domain";
import type { Scan, TopTrader } from "@/types/edge";
import { Header, fetchJson, date } from "./shared";
export default function Landing() {
  const router = useRouter();
  const [wallet, setWallet] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [traders, setTraders] = useState<TopTrader[] | null>(null);
  const [traderError, setTraderError] = useState("");
  useEffect(() => {
    let live = true;
    fetchJson<{ traders: TopTrader[] }>("/api/edge/traders/validated?limit=3")
      .then((x) => {
        if (live) setTraders(x.traders);
      })
      .catch((e) => {
        if (live) setTraderError(e.message);
      });
    return () => {
      live = false;
    };
  }, []);
  async function start(value: string) {
    if (busy) return;
    setError("");
    if (!walletInput(value)) {
      setError("Enter a valid EVM (0x…) or Solana wallet address.");
      return;
    }
    setBusy(true);
    try {
      const s = await fetchJson<Scan>("/api/edge/scans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: value }),
      });
      router.push(s.cached ? `/edge/result/${s.scanId}?cached=1` : `/edge/scan/${s.scanId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Please try again.");
      setBusy(false);
    }
  }
  return (
    <>
      <Header landing />
      <main className="edge-landing">
        <section className="landing-intro">
          <p className="edge-label positive">An agent for Fomo traders</p>
          <h1>
            Find your <em>edge</em>.<br />
            Trade only that.
          </h1>
          <p className="landing-copy">
            Paste the wallet you trade with on Fomo. Analyze your latest 90-day
            history, the behaviors that made or lost money, and the evidence
            behind every finding.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void start(wallet);
            }}
            className="wallet-form"
          >
            <label>
              <span className="edge-label">Fomo wallet</span>
              <input
                aria-label="Your Fomo wallet address"
                aria-describedby="wallet-help wallet-error"
                aria-invalid={!!error}
                value={wallet}
                onChange={(e) => setWallet(e.target.value)}
                placeholder="Paste EVM or Solana address"
                autoComplete="off"
                spellCheck={false}
                maxLength={64}
              />
            </label>
            <button className="edge-button primary" disabled={busy}>
              {busy ? "Checking your wallet…" : "Find your edge →"}
            </button>
          </form>
          <p id="wallet-error" role="alert" className="negative">
            {error}
          </p>
          <p id="wallet-help" className="edge-muted small">
            Read-only. No keys or approvals. Scans less than 3 days old open instantly.
          </p>
          <div id="how" className="landing-benefits">
            <div>
              <b>Your edge, in dollars</b>
              <p>See which behaviors made money and which cost you.</p>
            </div>
            <div>
              <b>Evidence before a label</b>
              <p>Validated findings stay distinct from early observations.</p>
            </div>
            <div>
              <b>The complete story</b>
              <p>Follow each position from its first buy to its final exit.</p>
            </div>
          </div>
        </section>
        <aside className="landing-preview">
          <section className="edge-card illustration">
            <div className="section-heading">
              <span className="edge-label">An Edge Print</span>
              <span className="edge-muted small">
                Illustration only · example amounts
              </span>
            </div>
            <ExamplePrint/>
          </section>
          <section className="edge-card trader-list">
            <div className="section-heading">
              <h2 className="edge-label">Top traders with validated edge</h2>
              <span className="edge-chip">Indexed</span>
            </div>
            {traderError ? (
              <p className="empty-state" role="status">
                {traderError}
              </p>
            ) : traders === null ? (
              <p className="empty-state" role="status">
                Loading validated evidence…
              </p>
            ) : traders.length === 0 ? (
              <p className="empty-state">
                No traders currently meet the compatible validation criteria.
                Observed behavior is not a validated edge.
              </p>
            ) : (
              traders.map((t) => (
                <article key={t.identity.id} className="trader-row">
                  <span>
                    <b>{t.identity.name}</b>
                    <small>
                      {t.validatedCount} validated finding
                      {t.validatedCount === 1 ? "" : "s"} · {date(t.analyzedAt)}
                    </small>
                  </span>
                  <span className="edge-chip positive">Validated</span>
                </article>
              ))
            )}
          </section>
          <p className="edge-muted small">
            Historical evidence, not a forecast or trading recommendation.
          </p>
        </aside>
      </main>
    </>
  );
}
