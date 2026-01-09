# ALL-IN.WTF

A provably fair gaming platform on Solana blockchain featuring Plinko and 3-Dice games with on-chain token betting.

## Features

- **Plinko Game**: Drop balls through a pyramid of pegs, aim for up to 110x multipliers
- **3-Dice Game**: Roll three dice, match combinations for multipliers up to 100x
- **Provably Fair**: All game outcomes are verifiable on-chain via Solana transactions
- **Instant Payouts**: Win payouts are sent directly to your connected wallet
- **Wallet Integration**: Supports Phantom, Solflare, and other Solana wallets
- **Share Wins**: One-click sharing to X (Twitter) with custom branding

## Tech Stack

- **Frontend**: React 18, TypeScript, Tailwind CSS, Vite
- **Backend**: Node.js, Express, TypeScript
- **Database**: PostgreSQL with Drizzle ORM
- **Blockchain**: Solana Web3.js, SPL Token
- **Animations**: Framer Motion, Matter.js (physics), Canvas Confetti

## How It Works

1. Connect your Solana wallet (Phantom recommended)
2. Transfer tokens to the house wallet before playing
3. Choose bet amount (10K - 1M tokens)
4. Play Plinko or Dice
5. Wins are paid out instantly to your wallet
6. Verify any game result on Solscan

## Environment Variables

```env
DATABASE_URL=            # PostgreSQL connection string
SOLANA_RPC_URL=          # Solana RPC endpoint
SOLANA_PRIVATE_KEY=      # Base58 encoded private key for payouts
PUMPPORTAL_API_KEY=      # PumpPortal API key (optional)
TOKEN_CONTRACT_ADDRESS=  # Token mint address
ADMIN_PASSWORD=          # Password for admin panel
SESSION_SECRET=          # Express session secret
```

## Development

```bash
# Install dependencies
npm install

# Push database schema
npm run db:push

# Start development server
npm run dev
```

## Links

- Website: [all-in.wtf](https://all-in.wtf)
- X (Twitter): [@ALLINwtfSOL](https://x.com/ALLINwtfSOL)

## License

MIT
