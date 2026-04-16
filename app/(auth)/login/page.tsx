'use client';

import { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        router.replace('/copy-trading');
      } else {
        setError('Incorrect password');
      }
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-black flex items-center justify-center font-mono">
      <form onSubmit={handleSubmit} className="bg-[#0A0A0A] border border-[#1A1A1A] rounded p-8 w-full max-w-sm space-y-4">
        <div className="text-[10px] text-[#6E6E6E] tracking-widest mb-6">YIELDR / ACCESS</div>
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="password"
          autoFocus
          className="w-full bg-[#111] border border-[#1A1A1A] rounded px-3 py-2 text-sm text-[#E0E0E0] placeholder-[#444] focus:outline-none focus:border-[#00C805]"
        />
        {error && <p className="text-xs text-[#FF4757]">{error}</p>}
        <button
          type="submit"
          disabled={loading || !password}
          className="w-full px-4 py-2 text-xs font-bold rounded border border-[#00C805]/30 text-[#00C805] hover:bg-[#00C805]/10 transition-colors disabled:opacity-40">
          {loading ? '...' : 'ACCESS'}
        </button>
      </form>
    </div>
  );
}
