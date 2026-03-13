'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import s from './TopNav.module.css';

interface TopNavProps {
  activePage: 'terminal' | 'agents';
}

export default function TopNav({ activePage }: TopNavProps) {
  const router = useRouter();
  const [shortWallet, setShortWallet] = useState<string>('');

  useEffect(() => {
    const wallet = localStorage.getItem('yieldr_auth_wallet') ?? '';
    if (wallet) {
      setShortWallet(`${wallet.slice(0, 6)}…${wallet.slice(-4)}`);
    }
  }, []);

  function handleLogout() {
    localStorage.removeItem('yieldr_auth_wallet');
    localStorage.removeItem('yieldr_agent_id');
    router.push('/onboarding/connect');
  }

  return (
    <nav className={s.topnav}>
      <span className={s.logo} onClick={() => router.push('/demo/chat')}>YIELDR</span>
      <div className={s.navTabs}>
        <button
          className={`${s.navTab} ${activePage === 'terminal' ? s.active : ''}`}
          onClick={() => router.push('/demo/chat')}
        >Terminal</button>
        <button
          className={`${s.navTab} ${activePage === 'agents' ? s.active : ''}`}
          onClick={() => router.push('/agents')}
        >Agents</button>
        <button className={`${s.navTab} ${s.disabled}`} title="Coming soon">Traders</button>
        <button className={s.navTab} onClick={() => router.push('/demo/chat?funds=1')} title="Agent wallet & funds">Funds</button>
      </div>
      <div className={s.topnavRight}>
        <button className={s.getYldr} onClick={() => router.push('/demo/chat')}>+ Get YLDR</button>
        {shortWallet && (
          <div className={s.walletPill} onClick={handleLogout} title="Click to disconnect">
            {shortWallet}
          </div>
        )}
      </div>
    </nav>
  );
}
