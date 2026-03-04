# x402 vs Conventional Payment Gateway — POC

A hands-on comparison of the **x402 open payment protocol** versus a
**conventional (Stripe-like)** payment gateway for API monetisation.

---

## What is x402?

x402 is an open HTTP payment protocol built by Coinbase (Apache 2.0 licensed).
When a client requests a paid resource:

1. The server responds with **HTTP 402 Payment Required** and payment instructions.
2. The client's SDK signs a payment authorisation (EIP-712 Permit2 signature).
3. The signed payload is sent back in a `PAYMENT-SIGNATURE` header.
4. A **Facilitator** (a public verification/settlement service) verifies and
   settles the crypto payment on-chain.
5. The server returns the resource.

This all happens **inside a single HTTP round-trip** (or two at most). No accounts,
no KYC, no sessions, no chargebacks.

---

## Project Structure

```
x402-poc/
├── x402-server/           Express server protected by x402 middleware
│   └── src/server.ts
│
├── x402-client/           Client that auto-pays via @x402/fetch + viem wallet
│   ├── src/client.ts
│   └── .env.example
│
├── conventional-server/   Express server with Stripe-like auth + payment flow
│   └── src/server.ts
│
├── conventional-client/   Client walking through all 5 conventional steps
│   └── src/client.ts
│
└── README.md              ← You are here
```

---

## Quick Start

### Prerequisites

| Tool | Version |
|------|---------|
| Node.js | ≥ 18 |
| npm | ≥ 9 |

### 1 — Install dependencies

```bash
# Install all packages (run from repo root)
npm run install:all
```

Or per-module:

```bash
cd x402-server        && npm install
cd ../x402-client     && npm install
cd ../conventional-server && npm install
cd ../conventional-client && npm install
```

### 2 — (x402 only) Set up a testnet wallet

The x402 client needs a wallet with **USDC on Base Sepolia** (testnet — no real money).

```bash
# Option A: Generate a fresh keypair with Foundry
npx cast w new

# Option B: Use any EVM wallet and export the private key
```

Fund the wallet:
- Go to <https://portal.cdp.coinbase.com/products/faucet>
- Network: **Base Sepolia**
- Token: **USDC**

Then create `x402-client/.env`:

```bash
cp x402-client/.env.example x402-client/.env
# Edit .env and paste your 0x... private key
```

### 3 — Run the servers (each in its own terminal)

```bash
# Terminal A — x402 payment server (port 4021)
cd x402-server && npm start

# Terminal B — Conventional payment server (port 4022)
cd conventional-server && npm start
```

### 4 — Run the clients

```bash
# Terminal C — x402 client (auto-pays with crypto wallet)
cd x402-client && npm start

# Terminal D — Conventional client (walks through 5-step flow)
cd conventional-client && npm start
```

---

## What You'll See

### Running the x402 client

```
SETUP  (done once, ~5 lines of code)
  ✅  Wallet address : 0xAbC...
  ✅  x402 client ready (3ms)
  ✅  Scheme registered: exact / eip155:* (EVM)

REQUEST 1 — Weather Data  ($0.001 USDC)
  🔄  Sending request...
  ✅  Response received in 412ms
  📊  Weather data: { city: "San Francisco", ... }
  🧾  Payment settled: { txHash: "0x...", ... }

REQUEST 2 — News Headlines  ($0.001 USDC)
  ...

REQUEST 3 — Stock Quote: AAPL  ($0.002 USDC)
  ...

x402 SUMMARY
  ✅  3 paid API requests completed
  💡  Total developer setup:
        - 1 npm install
        - 3 lines to configure the client
        - 0 account registrations
        - 0 API keys needed
        - 0 KYC or approvals
        - Payment handled transparently in HTTP layer
```

### Running the conventional client

```
STEP 1 / 5 — Register Account
  ✅  Registered successfully
  ⚠️  KYC verification required before you can make payments

STEP 2 / 5 — KYC Identity Verification
  ✅  KYC status: approved (SIMULATED)
  ℹ️   In production: requires government ID upload, takes 1-3 business days.

STEP 3 / 5 — Add Payment Method
  ✅  Payment method added
  ⚠️  Chargeback risk: you bear the liability

STEP 4 / 5 — Create Payment Intent
  ❌  Amount too small. Minimum is $0.50 USD...   ← $0.001 micropayment?  Impossible.

STEP 5 / 5 — Confirm & Charge
  ✅  Payment confirmed!
  💸  Platform fee: $0.33 on a $1.00 transaction  ← 33% gone immediately

CONVENTIONAL PAYMENT SUMMARY
  📋  Steps completed:   5
  ⏱️   Setup time:       480ms (simulated — production = DAYS)
  ⚠️  Minimum transaction: $0.50 (can't do $0.001 micropayments)
  ⚠️  Platform fee: 2.9% + $0.30 on every transaction
  ⚠️  AI agents cannot use this flow (no wallet concept)
```

---

## Side-by-Side Comparison

| Dimension | x402 | Conventional (Stripe) |
|-----------|------|----------------------|
| **Setup steps for buyer** | 1 (configure wallet) | 5–7 (register, KYC, card, intent, confirm…) |
| **Onboarding time** | Seconds | Hours → Days (KYC) |
| **Minimum payment** | ~$0.0001 (fractions of a cent) | $0.50 USD |
| **Platform fee** | Only blockchain gas (~$0.0001) | 2.9% + $0.30 per transaction |
| **Payout delay** | Seconds (on-chain) | 2–7 business days |
| **Chargebacks** | Impossible (cryptographic, final) | ~1% chargeback rate |
| **KYC required** | ❌ None | ✅ Yes (often days) |
| **Works for AI agents** | ✅ Yes (wallet + signature) | ❌ No (requires human card) |
| **Micropayments** | ✅ Yes | ❌ No ($0.50 floor) |
| **Accounts/API keys** | ❌ Not needed | ✅ Required |
| **PCI-DSS compliance** | ❌ Not required | ✅ Required |
| **Server integration** | 1 middleware call | 5+ route handlers |
| **Privacy** | ✅ Pseudonymous (wallet address) | ❌ Full identity required |
| **Works without internet banks** | ✅ Yes | ❌ No |
| **Open standard** | ✅ Apache 2.0 | ❌ Proprietary |

---

## When to Use x402

✅ **Great fit for:**
- API monetisation with per-request pricing
- Micropayments (< $0.50)
- AI agent / autonomous client payments
- Global access (no bank account needed)
- Developer tools and data APIs
- Privacy-sensitive applications
- When you want zero chargebacks and instant settlement

❌ **Not ideal for:**
- Consumer e-commerce (most buyers don't have crypto wallets yet)
- Regulated industries requiring KYC on the buyer side
- High-value transactions where fiat refunds are legally required
- Markets where crypto adoption is low

---

## When to Use Conventional Payments (Stripe)

✅ **Great fit for:**
- Consumer-facing products (everyone has a credit card)
- SaaS subscriptions with monthly billing
- High-value purchases where buyer protection/refunds matter
- Regulated financial products
- Cases where chargeback disputes are acceptable

❌ **Not ideal for:**
- Micropayments (fees eat the margin)
- Machine-to-machine payments
- Global access without KYC overhead
- Real-time settlement requirements

---

## Network Details (Testnet)

| Parameter | Value |
|-----------|-------|
| Protocol | x402 v2 |
| Network | Base Sepolia (eip155:84532) |
| Token | USDC (testnet) |
| Facilitator | https://x402.org/facilitator |
| Mainnet facilitator | https://api.cdp.coinbase.com/platform/v2/x402 |

---

## Resources

- [x402 Website](https://x402.org)
- [x402 Documentation](https://docs.x402.org)
- [x402 GitHub](https://github.com/coinbase/x402)
- [Base Sepolia Faucet](https://portal.cdp.coinbase.com/products/faucet)
- [Foundry (cast wallet tool)](https://getfoundry.sh)
