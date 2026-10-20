# X API v2 - Pay Per Use Setup Guide

## Step 1: Create Developer Account

1. Go to https://developer.x.com
2. Sign in with the @yieldrdotorg X account
3. Sign up for developer access
4. Select **"Pay Per Use"** plan (formerly Basic tier)

## Step 2: Create a Project & App

1. In the Developer Portal, go to **Projects & Apps**
2. Click **"+ Create Project"**
3. Project name: `yieldr-content-agent`
4. Use case: "Making a bot" or "Managing content"
5. Create an **App** within the project
6. App name: `yieldr-x-agent`

## Step 3: Set App Permissions

**CRITICAL - Do this BEFORE generating tokens:**

1. In App Settings → **User authentication settings** → click **Set up**
2. Set **App permissions** to **"Read and Write"**
3. Type of App: **"Web App, Automated App or Bot"**
4. Callback URL: `https://yieldr.org/callback` (required but not used)
5. Website URL: `https://yieldr.org`
6. Save

## Step 4: Generate API Keys

In the App's **"Keys and tokens"** tab, generate:

| Key | Env Variable | How to Get |
|-----|-------------|------------|
| API Key | `X_API_KEY` | Under "Consumer Keys" → Generate |
| API Key Secret | `X_API_SECRET` | Under "Consumer Keys" → Generate |
| Bearer Token | `X_BEARER_TOKEN` | Under "Authentication Tokens" → Generate |
| Access Token | `X_ACCESS_TOKEN` | Under "Authentication Tokens" → Generate |
| Access Token Secret | `X_ACCESS_SECRET` | Under "Authentication Tokens" → Generate |

**Important:** Access Token and Secret must be generated AFTER setting Read+Write permissions. If you change permissions later, you must regenerate these tokens.

## Step 5: Add Credits

1. In Developer Portal → **Billing**
2. Add payment method
3. Add **$5 credit** for testing
4. Pay-per-use pricing (approximate):
   - **Tweet creation** (POST /2/tweets): ~$0.01 per tweet
   - **Tweet reads** (GET endpoints): ~$0.01 per request
   - **User lookup**: ~$0.01 per request
   - **Mentions timeline**: ~$0.01 per request
   - **Search tweets**: ~$0.01-0.03 per request

## Step 6: Add to .env.local

Add these to your `.env.local` at the project root:

```
X_API_KEY=your_consumer_key
X_API_SECRET=your_consumer_secret
X_ACCESS_TOKEN=your_access_token
X_ACCESS_SECRET=your_access_token_secret
X_BEARER_TOKEN=your_bearer_token
```

## Step 7: Test

```bash
cd services/x-content-agent
npm run test:x-api           # Test auth + reads only
npm run test:x-api -- --post  # Test auth + reads + write (posts a test tweet, then deletes it)
```

## Cost Estimates

### Testing ($5 budget)
- Auth verification: ~$0.01
- 10 test tweets: ~$0.10
- 20 mention checks: ~$0.20
- 10 user lookups: ~$0.10
- **Total test cost: ~$0.50**

### Production (daily)
- 16-18 posts/day: ~$0.18
- 20 reply posts/day: ~$0.20
- 96 mention checks/day (every 3 min × 8 active hours): ~$0.96
- 5 Base account timeline reads: ~$0.05
- **Daily cost: ~$1.50-2.00**
- **Monthly cost: ~$45-60**

## API Rate Limits (Pay Per Use)

- **POST /2/tweets**: 100 tweets per 15 min (per user)
- **GET /2/users/me**: 75 requests per 15 min
- **GET /2/users/:id/mentions**: 180 requests per 15 min
- **GET /2/tweets/search/recent**: 60 requests per 15 min

These limits are generous for our use case (16-18 posts + ~20 replies per day).

## Troubleshooting

- **401 Unauthorized**: Tokens expired or permissions changed. Regenerate tokens.
- **403 Forbidden**: App doesn't have Read+Write. Check User Authentication settings.
- **429 Too Many Requests**: Rate limited. Wait 15 minutes.
- **Insufficient credits**: Add more credit to billing in Developer Portal.
