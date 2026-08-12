'use client';

import { useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useRouter } from 'next/navigation';
import styles from '../pricing.module.css';

type Billing = 'm' | 'a';

interface Plan {
  key: string;
  name: string;
  desc: string;
  m: number;
  a: number;
  credits: string;
  features: string[];
  highlight?: boolean;
  badge?: string;
}

const PLANS: Plan[] = [
  {
    key: 'Scout',
    name: 'Scout',
    desc: 'The insurance tier — for one wallet, one clear answer',
    m: 50,
    a: 38,
    credits: '⚡ 1M agent inference credits / mo',
    features: [
      'Quant Agent — 1 wallet, full Edge Grade',
      'Entry / Exit / Sizing breakdown + agent chat',
      'No live Terminal, no real-time alerts',
    ],
  },
  {
    key: 'Trader',
    name: 'Trader',
    desc: 'Full terminal, live alerts, built for daily use',
    m: 100,
    a: 75,
    credits: '⚡ 5M agent inference credits / mo',
    features: [
      'Everything in Scout, 3 wallets tracked',
      'Full Quant Terminal — signals, chart lenses, leaderboard',
      'Live alerts: pullback setups, OG exits, dev dumps',
    ],
    highlight: true,
    badge: 'Most Reserved',
  },
  {
    key: 'Desk',
    name: 'Desk',
    desc: 'Unlimited wallets, priority signal delivery',
    m: 199,
    a: 149,
    credits: '⚡ 15M agent inference credits / mo',
    features: [
      'Everything in Trader, unlimited wallets',
      'Priority / lowest-latency signal delivery',
      'First access to new markets (predictions, liquidity — 2027)',
    ],
  },
];

const FAQS = [
  {
    q: 'Am I buying a token right now?',
    a: "No. You're prepaying for the Quant Agent and Terminal subscription, same as any SaaS pre-order. The 1x–2x token reward is a bonus tied to your subscription, not a separate token sale.",
  },
  {
    q: 'When am I actually charged?',
    a: "Once, today — your Genesis payment. Your subscription doesn't start running until the beta product goes live, so there are no charges between now and launch. What you pay today is credited against your first billing period once the product launches.",
  },
  {
    q: 'Does Yieldr ever trade for me?',
    a: 'No. Yieldr is intelligence only — read-only wallet analysis and market signals. It never custodies funds or executes trades on your behalf.',
  },
  {
    q: "What if I don't renew after the free trial?",
    a: 'Your Genesis reward is earned by your prepayment today, not by staying subscribed forever. Product access requires an active subscription once the free trial ends at public launch.',
  },
];

export default function PricingPage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const { address, isConnected } = useAccount();
  const router = useRouter();

  const [billing, setBilling] = useState<Billing>('m');
  const [openFaq, setOpenFaq] = useState<number>(0);
  const [checkoutPlan, setCheckoutPlan] = useState<Plan | null>(null);
  const [reserved, setReserved] = useState(false);

  if (!mounted) return null;

  const price = (p: Plan) => (billing === 'a' ? p.a : p.m);

  return (
    <div className={styles.page}>
      <div className={styles.nav}>
        <div className={`${styles.wrap} ${styles.navIn}`}>
          <div className={styles.navName}>YIELDR</div>
          <button className={styles.navBack} onClick={() => router.back()}>
            ← Back to Edge Analysis
          </button>
        </div>
      </div>

      {/* ============ CREDIBILITY ============ */}
      <div className={styles.sec}>
        <div className={styles.wrap}>
          <div className={styles.slbl}>
            <span>Why Trust This</span>
            <span className={styles.slblLn} />
          </div>
          <h2 className={styles.secH}>Before you pay — who&apos;s actually building this.</h2>
          <div className={styles.credGrid} style={{ marginTop: 20 }}>
            <a
              className={styles.credCard}
              href="https://x.com/buildonbase/status/2023855121189220609"
              target="_blank"
              rel="noreferrer"
            >
              <div className={styles.credTop}>
                <div className={styles.credIc}>🏆</div>
                <span className={styles.credBadge}>Base Batches 002</span>
              </div>
              <div className={styles.credName}>Base Batches 002 Winner</div>
              <div className={styles.credDesc}>
                Selected from 900+ projects for building DeFi infrastructure on Base. Part of the Incubase
                accelerator. View the announcement →
              </div>
            </a>
            <a className={styles.credCard} href="https://www.circuit-accelerator.com/" target="_blank" rel="noreferrer">
              <div className={styles.credTop}>
                <div className={styles.credIc}>🚀</div>
                <span className={styles.credBadge}>Base × Newcampus</span>
              </div>
              <div className={styles.credName}>Circuit Accelerator</div>
              <div className={styles.credDesc}>
                Backed by Base × Newcampus HQ — selected for the Circuit accelerator cohort in Singapore. View the
                program →
              </div>
            </a>
            <a className={styles.credCard} href="https://www.yieldr.org/build-in-public" target="_blank" rel="noreferrer">
              <div className={styles.credTop}>
                <div className={styles.credIc}>📊</div>
              </div>
              <div className={styles.credName}>Building in Public</div>
              <div className={styles.credDesc}>
                Weekly build logs, real treasury data, live trading performance. No sanitisation, no narrative
                management. See the log →
              </div>
            </a>
          </div>
        </div>
      </div>

      {/* ============ PRICING ============ */}
      <div className={styles.sec} id="pricing">
        <div className={styles.wrap}>
          <div className={styles.slbl}>
            <span>Genesis Pricing</span>
            <span className={styles.slblLn} />
          </div>
          <h2 className={styles.secH}>Lock this price before public launch.</h2>
          <p className={styles.secP}>
            Genesis subscribers pay this price for as long as they stay subscribed. Public pricing at Q4 launch will
            be higher.
          </p>

          <div className={styles.toggleRow}>
            <div className={styles.toggle}>
              <button className={billing === 'm' ? styles.on : ''} onClick={() => setBilling('m')}>
                Monthly
              </button>
              <button className={billing === 'a' ? styles.on : ''} onClick={() => setBilling('a')}>
                Annual
              </button>
            </div>
            <span className={styles.saveTag}>Annual saves up to 25%</span>
          </div>

          <div className={styles.plans}>
            {PLANS.map((p) => (
              <div key={p.key} className={`${styles.plan} ${p.highlight ? styles.hi : ''}`}>
                {p.badge && <div className={styles.planBadge}>{p.badge}</div>}
                <div className={styles.planName}>{p.name}</div>
                <div className={styles.planDesc}>{p.desc}</div>
                <div className={styles.planPrice}>
                  <span className={styles.n}>${price(p)}</span>
                  <span className={styles.u}>/mo</span>
                </div>
                {billing === 'a' && (
                  <div className={styles.planOrig}>${p.m * 12}/yr billed monthly</div>
                )}
                <div className={styles.planCredits}>{p.credits}</div>
                <ul>
                  {p.features.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
                <button className={styles.planBtn} onClick={() => setCheckoutPlan(p)}>
                  Reserve {p.name}
                </button>
                <div className={styles.planReward}>🎁 Genesis reward: 1x–2x back in $YLDR at TGE</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ============ REWARD ============ */}
      <div className={styles.sec} style={{ paddingTop: 0 }}>
        <div className={styles.wrap}>
          <div className={styles.reward}>
            <div className={styles.rewardGrid}>
              <div>
                <span className={styles.badgePill}>Genesis Reward</span>
                <h2 className={styles.secH} style={{ marginTop: 16, maxWidth: 480 }}>
                  Worst case, you get your money back. Best case, you double it.
                </h2>
                <p className={styles.secP} style={{ maxWidth: 480 }}>
                  Every Genesis subscription is airdropped back in tokens at TGE — somewhere between{' '}
                  <b style={{ color: 'var(--ink-1)' }}>1x and 2x</b> what you paid. You keep full product access
                  either way.
                </p>
                <div className={styles.assetRow}>
                  <span className={styles.assetChip}>$YLDR</span>
                  <span className={styles.assetChip}>$SPCX</span>
                  <span className={styles.assetChip}>$TSLA</span>
                </div>
                <div className={styles.rewardFine} style={{ marginTop: 10 }}>
                  Your airdrop may be paid in $YLDR, stock-linked tokens like $SPCX or $TSLA, or a mix of both in
                  value — final composition confirmed before TGE.
                </div>
              </div>
              <div>
                <div className={styles.rewardRange}>
                  <div className={`${styles.rrBox} ${styles.floor}`}>
                    <div className={styles.k}>Floor</div>
                    <div className={styles.v}>1.0x</div>
                  </div>
                  <div className={styles.rrArrow}>→</div>
                  <div className={`${styles.rrBox} ${styles.ceil}`}>
                    <div className={styles.k}>Ceiling</div>
                    <div className={styles.v}>2.0x</div>
                  </div>
                </div>
                <div className={styles.rewardFine}>
                  Valued in tokens at TGE launch price, distributed to your wallet within 30 days of TGE. Where you
                  land in the range isn&apos;t announced in advance. Final composition and exact terms confirmed
                  before TGE.
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ============ FAQ ============ */}
      <div className={styles.sec} style={{ paddingTop: 0 }}>
        <div className={styles.wrap} style={{ maxWidth: 760, margin: '0 auto' }}>
          <div className={styles.slbl}>
            <span>Before You Reserve</span>
            <span className={styles.slblLn} />
          </div>
          {FAQS.map((f, i) => (
            <div key={f.q} className={`${styles.faqItem} ${openFaq === i ? styles.open : ''}`}>
              <button className={styles.faqQ} onClick={() => setOpenFaq(openFaq === i ? -1 : i)}>
                {f.q}
                <span className={styles.chev}>▾</span>
              </button>
              <div className={styles.faqA}>
                <p>{f.a}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {checkoutPlan && (
        <CheckoutModal
          plan={checkoutPlan}
          billing={billing}
          price={price(checkoutPlan)}
          address={address}
          isConnected={isConnected}
          reserved={reserved}
          onReserved={() => setReserved(true)}
          onClose={() => {
            setCheckoutPlan(null);
            setReserved(false);
          }}
        />
      )}
    </div>
  );
}

function CheckoutModal({
  plan,
  billing,
  price,
  address,
  isConnected,
  reserved,
  onReserved,
  onClose,
}: {
  plan: Plan;
  billing: Billing;
  price: number;
  address: string | undefined;
  isConnected: boolean;
  reserved: boolean;
  onReserved: () => void;
  onClose: () => void;
}) {
  return (
    <div className={styles.modalOverlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.modal}>
        <div className={styles.modalHd}>
          <span className={styles.t}>Confirm Genesis Reservation</span>
          <button className={styles.modalClose} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className={styles.modalBody}>
          <div className={styles.modalPlan}>
            <div>
              <div className={styles.modalPlanName}>{plan.name}</div>
              <div className={styles.modalPlanCycle}>
                {billing === 'a' ? 'Billed annually · Genesis price' : 'Billed monthly · Genesis price'}
              </div>
            </div>
            <div className={styles.modalPlanPrice}>${price}</div>
          </div>
          <div className={styles.modalNote}>
            You&apos;re charged <b>once, today</b>, for this Genesis reservation. Your subscription doesn&apos;t
            start running until the beta product goes live — <b>no charges between now and launch</b>. What you pay
            today is credited in full against your first billing period once the product launches.
          </div>
          <div className={styles.modalReward}>
            <div className={styles.k}>Estimated Genesis Reward</div>
            <div className={styles.v}>
              ${price} – ${price * 2} in tokens
            </div>
            <div className={styles.s}>
              1x–2x your payment, valued at TGE launch price. Distributed to your connected wallet within 30 days of
              TGE.
            </div>
          </div>
          <div className={styles.modalActions}>
            {!isConnected && (
              <ConnectButton.Custom>
                {({ openConnectModal }) => (
                  <button className={`${styles.modalBtn} ${styles.connect}`} onClick={openConnectModal}>
                    Connect Wallet to Pay
                  </button>
                )}
              </ConnectButton.Custom>
            )}
            {isConnected && !reserved && (
              <button className={`${styles.modalBtn} ${styles.pay}`} onClick={onReserved}>
                Pay ${price} Now
              </button>
            )}
            {reserved && (
              <div className={styles.modalNote}>
                Genesis checkout isn&apos;t live yet — payments open shortly before public launch. We&apos;ll notify{' '}
                <b>{address ? `${address.slice(0, 6)}...${address.slice(-4)}` : 'your wallet'}</b> the moment it does,
                so your {plan.name} reservation at today&apos;s Genesis price is locked in.
              </div>
            )}
            <div className={`${styles.modalWalletState} ${isConnected ? styles.connected : ''}`}>
              {isConnected && address
                ? `Wallet connected · ${address.slice(0, 6)}...${address.slice(-4)}`
                : 'No wallet connected'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
