import * as path from 'path';
import * as fs from 'fs';

const ASSETS_DIR = path.resolve(__dirname, '../../assets');

const CATEGORY_MAP: Record<string, string> = {
  TRADER_PROFILE: 'trader-signal.png',
  HIGH_CONVICTION: 'live-signal.png',
  VAULT_PERFORMANCE: 'vault-update.png',
  VAULT_LOSS: 'vault-alert.png',
};

export function getCategoryImage(category: string, isLoss?: boolean): string | null {
  const file = isLoss && category === 'VAULT_PERFORMANCE'
    ? CATEGORY_MAP.VAULT_LOSS
    : CATEGORY_MAP[category];

  if (!file) return null;

  const fullPath = path.join(ASSETS_DIR, file);
  if (!fs.existsSync(fullPath)) {
    console.warn(`[Images] Missing asset: ${fullPath}`);
    return null;
  }
  return fullPath;
}
