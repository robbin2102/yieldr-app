import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';

export type WSEventType =
  | 'alert'           // New trade alert
  | 'positions'       // Positions updated
  | 'profile'         // Profile data updated
  | 'connected'       // Connection established
  | 'error';          // Error occurred

export interface WSMessage {
  type: WSEventType;
  data: any;
  timestamp: number;
}

class WebSocketManager {
  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();

  start(port: number): void {
    this.wss = new WebSocketServer({ port });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const clientIp = req.socket.remoteAddress;
      console.log(`[WS] Client connected from ${clientIp}`);

      this.clients.add(ws);

      // Send connection confirmation
      this.sendTo(ws, {
        type: 'connected',
        data: { message: 'Connected to Polymarket Worker' },
        timestamp: Date.now(),
      });

      ws.on('close', () => {
        console.log(`[WS] Client disconnected`);
        this.clients.delete(ws);
      });

      ws.on('error', (error) => {
        console.error('[WS] Client error:', error.message);
        this.clients.delete(ws);
      });

      // Handle incoming messages (for future use - subscriptions, etc.)
      ws.on('message', (message: Buffer) => {
        try {
          const data = JSON.parse(message.toString());
          console.log('[WS] Received:', data);
          // Could handle subscription requests here
        } catch (e) {
          // Ignore invalid messages
        }
      });
    });

    console.log(`[WS] WebSocket server started on port ${port}`);
  }

  private sendTo(client: WebSocket, message: WSMessage): void {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  }

  broadcast(message: WSMessage): void {
    const payload = JSON.stringify(message);
    let sent = 0;

    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
        sent++;
      }
    }

    if (sent > 0) {
      console.log(`[WS] Broadcast ${message.type} to ${sent} clients`);
    }
  }

  // Convenience methods for different event types
  broadcastAlert(alert: any): void {
    this.broadcast({
      type: 'alert',
      data: alert,
      timestamp: Date.now(),
    });
  }

  broadcastPositions(wallet: string, positions: any[]): void {
    this.broadcast({
      type: 'positions',
      data: { wallet, positions, count: positions.length },
      timestamp: Date.now(),
    });
  }

  broadcastProfile(wallet: string, profile: any): void {
    this.broadcast({
      type: 'profile',
      data: { wallet, profile },
      timestamp: Date.now(),
    });
  }

  getClientCount(): number {
    return this.clients.size;
  }

  stop(): void {
    if (this.wss) {
      this.wss.close();
      this.clients.clear();
      console.log('[WS] Server stopped');
    }
  }
}

// Singleton instance
export const wsManager = new WebSocketManager();
