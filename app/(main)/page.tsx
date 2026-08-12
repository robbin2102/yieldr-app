'use client';

import { useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useRouter } from 'next/navigation';
import styles from './onboarding.module.css';

type Step = 'market' | 'name' | 'connect';

const DEFAULT_AGENT_NAME = 'meme-quantdesk-01';

export default function LandingPage() {
  // WalletConnect/RainbowKit touch localStorage during setup, which doesn't
  // exist during Next's server-side render - gate all wallet-dependent
  // rendering until after client mount, same pattern as app/demo/page.tsx.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const { address, isConnected } = useAccount();
  const router = useRouter();

  const [step, setStep] = useState<Step>('market');
  const [agentName, setAgentName] = useState(DEFAULT_AGENT_NAME);

  useEffect(() => {
    if (isConnected && address) {
      router.push(`/edge/${address}`);
    }
  }, [isConnected, address, router]);

  if (!mounted) return null;

  return (
    <div className={styles.page}>
      <div className={styles.nav}>
        <div className={styles.navBrand}>YIELDR</div>
        <div className={styles.navR}>LAUNCH AGENT</div>
      </div>

      {step === 'market' && (
        <div className={styles.laWrap}>
          <div className={styles.laEyebrow}>Launch Agent</div>
          <h1 className={styles.laH1}>
            Choose a market to <em>analyse your edge</em>
          </h1>
          <p className={styles.laSub}>
            The Quant Agent reads your wallet&apos;s transaction history on the selected market and scores whether
            your performance is repeatable edge — before you commit to launching an agent vault.
          </p>
          <div className={styles.laGrid}>
            <div className={`${styles.laCard} ${styles.active}`} onClick={() => setStep('name')}>
              <div className={styles.laCardTop}>
                <span className={styles.laCardIcon}>🐈</span>
                <span className={`${styles.laCardBadge} ${styles.ready}`}>Ready</span>
              </div>
              <div className={styles.laCardName}>Meme &amp; Alt Coins</div>
              <div className={styles.laCardApps}>
                <span>FOMO · pump.fun</span>
              </div>
              <div className={styles.laCardDesc}>
                Analyses trading history across meme &amp; alt-coin activity on FOMO and pump.fun — HOOD Chain &amp;
                Solana.
              </div>
              <div className={`${styles.laCardCta} ${styles.ready}`}>Launch Quant →</div>
            </div>

            <div className={`${styles.laCard} ${styles.disabled}`}>
              <div className={styles.laCardTop}>
                <span className={styles.laCardIcon}>🔮</span>
                <span className={`${styles.laCardBadge} ${styles.soon}`}>Coming Soon</span>
              </div>
              <div className={styles.laCardName}>Predictions</div>
              <div className={styles.laCardApps}>
                <span>Polymarket · Limitless</span>
              </div>
              <div className={styles.laCardDesc}>
                Edge analysis vs. implied probability across prediction market positions.
              </div>
              <div className={`${styles.laCardCta} ${styles.soon}`}>Notify Me</div>
            </div>

            <div className={`${styles.laCard} ${styles.disabled}`}>
              <div className={styles.laCardTop}>
                <span className={styles.laCardIcon}>💧</span>
                <span className={`${styles.laCardBadge} ${styles.soon}`}>Coming Soon</span>
              </div>
              <div className={styles.laCardName}>Liquidity</div>
              <div className={styles.laCardApps}>
                <span>Uniswap · Aerodrome</span>
              </div>
              <div className={styles.laCardDesc}>
                LP positioning and concentrated liquidity edge analysis across DEXes.
              </div>
              <div className={`${styles.laCardCta} ${styles.soon}`}>Notify Me</div>
            </div>
          </div>
        </div>
      )}

      {step === 'name' && (
        <div className={styles.connectWrap}>
          <div className={styles.stepIndicator}>
            <span>Step 1 of 2</span>
            <span className={styles.dots}>
              <span className={`${styles.dot} ${styles.active}`} />
              <span className={styles.dot} />
            </span>
          </div>
          <div className={styles.termBox}>
            <div className={styles.agentCardHeader}>
              <div className={styles.agentCardIcon}>🐈</div>
              <div>
                <div className={styles.agentCardTitle}>Set up your Quant Agent</div>
                <div className={styles.agentCardSub}>Meme &amp; Alt Coins</div>
              </div>
            </div>
            <div className={styles.agentChipRow}>
              <div className={styles.agentChip}>
                <span className={styles.k}>Market</span>
                <span className={styles.v}>Meme &amp; Alt Coins</span>
              </div>
              <div className={styles.agentChip}>
                <span className={styles.k}>Sources</span>
                <span className={styles.v}>FOMO · pump.fun</span>
              </div>
            </div>
            <label className={styles.agentLabel} htmlFor="agentNameInput">
              Agent name
            </label>
            <div className={styles.agentInputWrap}>
              <input
                className={styles.agentInput}
                id="agentNameInput"
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
                placeholder={DEFAULT_AGENT_NAME}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className={styles.agentHelper}>
              This is how your agent will appear across Yieldr — you can rename it any time. Default:{' '}
              <b>{DEFAULT_AGENT_NAME}</b>.
            </div>
            <button className={styles.btnConnect} onClick={() => setStep('connect')} disabled={!agentName.trim()}>
              Continue →
            </button>
          </div>
        </div>
      )}

      {step === 'connect' && (
        <div className={styles.connectWrap}>
          <div className={styles.stepIndicator}>
            <span>Step 2 of 2</span>
            <span className={styles.dots}>
              <span className={`${styles.dot} ${styles.done}`} />
              <span className={`${styles.dot} ${styles.active}`} />
            </span>
          </div>
          <div className={styles.termBox}>
            <div className={styles.agentCardHeader}>
              <div className={styles.agentCardIcon}>🔗</div>
              <div>
                <div className={styles.agentCardTitle}>Connect your wallet</div>
                <div className={styles.agentCardSub}>{agentName}</div>
              </div>
            </div>
            <div className={styles.agentChipRow}>
              <div className={styles.agentChip}>
                <span className={styles.k}>Agent</span>
                <span className={styles.v}>{agentName}</span>
              </div>
              <div className={styles.agentChip}>
                <span className={styles.k}>Market</span>
                <span className={styles.v}>Meme &amp; Alt Coins</span>
              </div>
            </div>
            <div className={styles.agentBodyText}>
              Connect a wallet so <b>your Quant Agent</b> can reconstruct your trade history and score your edge.
            </div>
            <ConnectButton.Custom>
              {({ openConnectModal }) => (
                <button className={styles.btnConnect} onClick={openConnectModal}>
                  Connect Wallet
                </button>
              )}
            </ConnectButton.Custom>
            <button className={styles.agentBackLink} onClick={() => setStep('name')}>
              ← Back
            </button>
            {isConnected && address && (
              <div className={styles.walletAddr}>
                {address.slice(0, 6)}...{address.slice(-4)} connected — launching agent...
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
