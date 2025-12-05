import fetch from 'node-fetch';
import { config } from '../config';
import { createLogger } from '../utils/logger';

const logger = createLogger('Notifications');

/**
 * Send notification to webhook
 */
export async function sendWebhookNotification(event: string, data: any): Promise<void> {
  if (!config.webhookUrl || config.webhookUrl.includes('placeholder')) {
    logger.debug(`Webhook not configured, skipping notification for event: ${event}`);
    return;
  }

  try {
    const payload = {
      event,
      timestamp: new Date().toISOString(),
      data,
    };

    const response = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      logger.error(`Webhook notification failed: ${response.status} ${response.statusText}`);
    } else {
      logger.debug(`Webhook notification sent for event: ${event}`);
    }
  } catch (error) {
    logger.error(`Failed to send webhook notification:`, error);
  }
}

/**
 * Send error notification email (placeholder for now)
 */
export async function sendErrorEmail(error: Error, context: string): Promise<void> {
  // For now, just log the error
  // In production, integrate with SendGrid, AWS SES, or similar
  logger.error(`[${context}] Error occurred:`, {
    message: error.message,
    stack: error.stack,
    recipient: config.errorEmail,
  });

  // TODO: Implement actual email sending
  // Example with SendGrid:
  // const sgMail = require('@sendgrid/mail');
  // sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  // const msg = {
  //   to: config.errorEmail,
  //   from: 'noreply@yieldr.org',
  //   subject: `Polymarket Tracker Error: ${context}`,
  //   text: `Error: ${error.message}\n\nStack: ${error.stack}`,
  // };
  // await sgMail.send(msg);

  console.error('\n' + '='.repeat(60));
  console.error('ERROR NOTIFICATION');
  console.error('='.repeat(60));
  console.error(`To: ${config.errorEmail}`);
  console.error(`Context: ${context}`);
  console.error(`Message: ${error.message}`);
  console.error(`Stack: ${error.stack}`);
  console.error('='.repeat(60) + '\n');
}

/**
 * Send notification when initial fetch completes
 */
export async function notifyInitialFetchComplete(
  walletAddress: string,
  metrics: any
): Promise<void> {
  await sendWebhookNotification('initial_fetch_complete', {
    walletAddress,
    metrics: {
      totalPnl: metrics.totalPnl,
      roi: metrics.overallRoi,
      winRate: metrics.winRate,
      openPositions: metrics.openPositionsCount,
      closedPositions: metrics.closedPositionsCount,
    },
  });
}

/**
 * Send notification when poller starts
 */
export async function notifyPollerStarted(
  walletAddress: string,
  intervalMs: number
): Promise<void> {
  await sendWebhookNotification('poller_started', {
    walletAddress,
    intervalMs,
    nextPoll: new Date(Date.now() + intervalMs).toISOString(),
  });
}
