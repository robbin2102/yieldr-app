'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

export type WSEventType = 'alert' | 'positions' | 'profile' | 'connected' | 'error';

export interface WSMessage {
  type: WSEventType;
  data: any;
  timestamp: number;
}

export interface AlertData {
  traderWallet: string;
  traderLabel: string;
  conditionId: string;
  market: string;
  outcome: string;
  side: string;
  size: number;
  price: number;
  usdcValue: number;
  timestamp: number;
  transactionHash: string;
}

interface UsePolymarketWSOptions {
  onAlert?: (alert: AlertData) => void;
  onPositions?: (data: { wallet: string; positions: any[]; count: number }) => void;
  onProfile?: (data: { wallet: string; profile: any }) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  autoReconnect?: boolean;
  reconnectDelay?: number;
}

export function usePolymarketWS(options: UsePolymarketWSOptions = {}) {
  const {
    onAlert,
    onPositions,
    onProfile,
    onConnect,
    onDisconnect,
    autoReconnect = true,
    reconnectDelay = 3000,
  } = options;

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const [isConnected, setIsConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<WSMessage | null>(null);
  const [alerts, setAlerts] = useState<AlertData[]>([]);

  const wsUrl = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:8080';

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    try {
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        console.log('[WS] Connected to Polymarket Worker');
        setIsConnected(true);
        onConnect?.();
      };

      ws.onclose = () => {
        console.log('[WS] Disconnected');
        setIsConnected(false);
        onDisconnect?.();

        // Auto-reconnect
        if (autoReconnect) {
          reconnectTimeoutRef.current = setTimeout(() => {
            console.log('[WS] Attempting reconnect...');
            connect();
          }, reconnectDelay);
        }
      };

      ws.onerror = (error) => {
        console.error('[WS] Error:', error);
      };

      ws.onmessage = (event) => {
        try {
          const message: WSMessage = JSON.parse(event.data);
          setLastMessage(message);

          switch (message.type) {
            case 'alert':
              const alert = message.data as AlertData;
              setAlerts(prev => [alert, ...prev].slice(0, 100)); // Keep last 100
              onAlert?.(alert);
              break;

            case 'positions':
              onPositions?.(message.data);
              break;

            case 'profile':
              onProfile?.(message.data);
              break;

            case 'connected':
              console.log('[WS] Server says:', message.data.message);
              break;
          }
        } catch (e) {
          console.error('[WS] Failed to parse message:', e);
        }
      };

      wsRef.current = ws;
    } catch (error) {
      console.error('[WS] Connection failed:', error);
    }
  }, [wsUrl, autoReconnect, reconnectDelay, onAlert, onPositions, onProfile, onConnect, onDisconnect]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const clearAlerts = useCallback(() => {
    setAlerts([]);
  }, []);

  useEffect(() => {
    connect();

    return () => {
      disconnect();
    };
  }, [connect, disconnect]);

  return {
    isConnected,
    lastMessage,
    alerts,
    clearAlerts,
    connect,
    disconnect,
  };
}
