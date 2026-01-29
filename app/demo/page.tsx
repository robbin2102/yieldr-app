'use client';

import { useState, useEffect } from 'react';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useRouter } from 'next/navigation';

type Goal = 'invest' | 'improve' | 'fund';

export default function CreateAgentPage() {
  const [mounted, setMounted] = useState(false);
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const [agentName, setAgentName] = useState('');
  const [selectedGoals, setSelectedGoals] = useState<Goal[]>([]);
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  const goals: Array<{
    id: Goal;
    icon: string;
    title: string;
    description: string;
    tag: string;
    disabled: boolean;
  }> = [
    {
      id: 'invest',
      icon: '💰',
      title: 'Invest with Top Traders',
      description: 'Your agent learns & executes trades following top traders',
      tag: '→ Best for passive investors',
      disabled: false,
    },
    {
      id: 'improve',
      icon: '📈',
      title: 'Improve My Trading',
      description: 'Get AI insights on your own trades',
      tag: '→ Best for active traders',
      disabled: true,
    },
    {
      id: 'fund',
      icon: '🏦',
      title: 'Launch a Fund',
      description: 'Launch & manage investor capital with your agent',
      tag: '→ Best for professional traders',
      disabled: true,
    },
  ];

  const toggleGoal = (goalId: Goal) => {
    if (goals.find(g => g.id === goalId)?.disabled) return;

    setSelectedGoals(prev => {
      if (prev.includes(goalId)) {
        return prev.filter(g => g !== goalId);
      }
      // Allow max 2 selections
      if (prev.length >= 2) {
        return [...prev.slice(1), goalId];
      }
      return [...prev, goalId];
    });
  };

  const canContinue = agentName.trim().length > 0 && selectedGoals.length > 0;

  // Handle wallet connection
  useEffect(() => {
    if (isConnected && address && isCreating) {
      // Store agent setup data
      localStorage.setItem('agentSetup', JSON.stringify({
        name: agentName,
        goals: selectedGoals,
        wallet: address,
        step: 1,
      }));

      // Navigate to launching page
      router.push('/demo/launching');
    }
  }, [isConnected, address, isCreating, agentName, selectedGoals, router]);

  const handleContinue = () => {
    setIsCreating(true);
  };

  if (!mounted) return null;

  return (
    <div className="min-h-screen flex items-center justify-center p-4 md:p-8">
      <div className="max-w-[500px] w-full">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-xs font-medium text-[#6E6E6E]">Step 1 of 2</span>
            <div className="flex-1 h-[3px] bg-[#1E1E1E] rounded-full overflow-hidden">
              <div className="h-full bg-[#00C805] w-1/2 transition-all duration-300" />
            </div>
          </div>
          <h1 className="text-2xl font-bold">Create Your AI Agent</h1>
        </div>

        {/* Form */}
        <div className="space-y-8">
          {/* Agent Name */}
          <div>
            <label className="block text-sm font-semibold mb-3">
              Name your agent
            </label>
            <input
              type="text"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
              placeholder="e.g. AlphaHunter, YieldBot, TrendSeeker"
              maxLength={30}
              className="w-full px-4 py-3.5 bg-[#0B0B0B] border border-[#1E1E1E] rounded-lg text-white placeholder-[#6E6E6E] focus:outline-none focus:border-[#00C805] transition-colors"
            />
          </div>

          {/* Goals */}
          <div>
            <label className="block text-sm font-semibold mb-3">
              What&apos;s your goal?
            </label>
            <div className="space-y-3">
              {goals.map((goal) => (
                <button
                  key={goal.id}
                  onClick={() => toggleGoal(goal.id)}
                  disabled={goal.disabled}
                  className={`w-full text-left p-5 rounded-lg border-2 transition-all ${
                    goal.disabled
                      ? 'opacity-50 cursor-not-allowed bg-[#0B0B0B] border-[#1E1E1E]'
                      : selectedGoals.includes(goal.id)
                      ? 'bg-[#00C805]/5 border-[#00C805]'
                      : 'bg-[#0B0B0B] border-[#1E1E1E] hover:border-[#2A2A2A] hover:bg-[#161616]'
                  }`}
                >
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-2xl">{goal.icon}</span>
                    <span className="font-semibold">{goal.title}</span>
                    {goal.disabled && (
                      <span className="ml-auto px-2 py-1 bg-[#0088FF] text-black text-[10px] font-bold rounded uppercase tracking-wide">
                        Coming Soon
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-[#9E9E9E] mb-2">{goal.description}</p>
                  <p className="text-xs text-[#6E6E6E] font-medium">{goal.tag}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-3 pt-4">
            <button
              onClick={() => router.push('/')}
              className="flex-1 py-3.5 px-6 rounded-lg border border-[#1E1E1E] text-white font-semibold hover:bg-[#161616] hover:border-[#2A2A2A] transition-all"
            >
              Back
            </button>

            {!isConnected ? (
              <div className="flex-1">
                {canContinue ? (
                  <div onClick={handleContinue}>
                    <ConnectButton.Custom>
                      {({ openConnectModal }) => (
                        <button
                          onClick={openConnectModal}
                          className="w-full py-3.5 px-6 rounded-lg bg-[#00C805] text-black font-semibold hover:bg-[#00E006] hover:-translate-y-0.5 hover:shadow-[0_4px_20px_rgba(0,200,5,0.4)] transition-all"
                        >
                          Connect Wallet →
                        </button>
                      )}
                    </ConnectButton.Custom>
                  </div>
                ) : (
                  <button
                    disabled
                    className="w-full py-3.5 px-6 rounded-lg bg-[#00C805] text-black font-semibold opacity-50 cursor-not-allowed"
                  >
                    Connect Wallet →
                  </button>
                )}
              </div>
            ) : (
              <button
                onClick={() => router.push('/demo/launching')}
                disabled={!canContinue}
                className={`flex-1 py-3.5 px-6 rounded-lg bg-[#00C805] text-black font-semibold transition-all ${
                  canContinue
                    ? 'hover:bg-[#00E006] hover:-translate-y-0.5 hover:shadow-[0_4px_20px_rgba(0,200,5,0.4)]'
                    : 'opacity-50 cursor-not-allowed'
                }`}
              >
                Continue →
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
