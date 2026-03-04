/**
 * x402 Payment Server
 *
 * This server demonstrates the x402 payment protocol.
 * It is 100% "serverless" in terms of payment setup — no accounts, no API keys,
 * no KYC. Clients just pay per request with USDC on Base Sepolia (testnet).
 *
 * The magic:  Adding paymentMiddleware() is the ONLY change needed to monetize an API.
 */

import express, { type Request, type Response } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

const app = express();
app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

// The address that will RECEIVE payments (your wallet address on Base Sepolia)
// Replace with your own testnet wallet address, or keep this for demo purposes
const PAYMENT_RECEIVER =
  process.env.PAYMENT_RECEIVER ||
  "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";

const PORT = 4021;
const NETWORK = "eip155:84532"; // Base Sepolia (testnet) — change to eip155:8453 for mainnet

// ─────────────────────────────────────────────────────────────────────────────
// x402 Setup — this is ALL the payment infrastructure you need
// ─────────────────────────────────────────────────────────────────────────────

const facilitatorClient = new HTTPFacilitatorClient({
  // Public testnet facilitator hosted by x402.org
  // For mainnet: "https://api.cdp.coinbase.com/platform/v2/x402"
  url: "https://x402.org/facilitator",
});

const resourceServer = new x402ResourceServer(facilitatorClient).register(
  NETWORK,
  new ExactEvmScheme()
);

// ─────────────────────────────────────────────────────────────────────────────
// Payment Middleware — single call protects ALL configured routes
// ─────────────────────────────────────────────────────────────────────────────

app.use(
  paymentMiddleware(
    {
      "GET /premium/weather": {
        accepts: {
          scheme: "exact",
          price: "$0.001", // $0.001 USDC per request (~fraction of a cent)
          network: NETWORK,
          payTo: PAYMENT_RECEIVER,
          maxTimeoutSeconds: 60,
        },
        description: "Real-time weather data (testnet demo)",
        mimeType: "application/json",
      },
      "GET /premium/news": {
        accepts: {
          scheme: "exact",
          price: "$0.001",
          network: NETWORK,
          payTo: PAYMENT_RECEIVER,
          maxTimeoutSeconds: 60,
        },
        description: "Latest news headlines (testnet demo)",
        mimeType: "application/json",
      },
      "GET /premium/stock/:symbol": {
        accepts: {
          scheme: "exact",
          price: "$0.002", // More expensive — more valuable data
          network: NETWORK,
          payTo: PAYMENT_RECEIVER,
          maxTimeoutSeconds: 60,
        },
        description: "Stock quote data (testnet demo)",
        mimeType: "application/json",
      },
    },
    resourceServer
  )
);

// ─────────────────────────────────────────────────────────────────────────────
// Protected API Endpoints (only reachable after valid x402 payment)
// ─────────────────────────────────────────────────────────────────────────────

app.get("/premium/weather", (_req: Request, res: Response) => {
  res.json({
    success: true,
    protocol: "x402",
    data: {
      city: "San Francisco",
      temperature: 68,
      unit: "°F",
      condition: "Partly Cloudy",
      humidity: 72,
      wind: "12 mph NW",
      uv_index: 4,
      forecast: [
        { day: "Tomorrow", high: 71, low: 55, condition: "Sunny" },
        { day: "Wed", high: 65, low: 52, condition: "Foggy" },
        { day: "Thu", high: 69, low: 54, condition: "Clear" },
      ],
      timestamp: new Date().toISOString(),
    },
  });
});

app.get("/premium/news", (_req: Request, res: Response) => {
  res.json({
    success: true,
    protocol: "x402",
    data: {
      headlines: [
        {
          title: "Tech stocks rally as AI sector booms",
          source: "TechDaily",
          publishedAt: new Date().toISOString(),
        },
        {
          title: "Climate summit reaches new emissions agreement",
          source: "WorldNews",
          publishedAt: new Date().toISOString(),
        },
        {
          title: "Study reveals benefits of shorter work weeks",
          source: "ScienceToday",
          publishedAt: new Date().toISOString(),
        },
      ],
      timestamp: new Date().toISOString(),
    },
  });
});

app.get("/premium/stock/:symbol", (req: Request, res: Response) => {
  const { symbol } = req.params;
  res.json({
    success: true,
    protocol: "x402",
    data: {
      symbol: symbol.toUpperCase(),
      price: (Math.random() * 400 + 100).toFixed(2),
      change: (Math.random() * 10 - 5).toFixed(2),
      changePercent: (Math.random() * 5 - 2.5).toFixed(2) + "%",
      volume: Math.floor(Math.random() * 10_000_000),
      marketCap: "$2.4T",
      timestamp: new Date().toISOString(),
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Free Endpoints
// ─────────────────────────────────────────────────────────────────────────────

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    protocol: "x402",
    port: PORT,
    network: NETWORK,
    facilitator: "https://x402.org/facilitator",
    payTo: PAYMENT_RECEIVER,
    routes: {
      "GET /premium/weather": "$0.001 USDC",
      "GET /premium/news": "$0.001 USDC",
      "GET /premium/stock/:symbol": "$0.002 USDC",
    },
  });
});

app.get("/", (_req: Request, res: Response) => {
  res.json({
    name: "x402 Demo Server",
    description:
      "Premium data API powered by x402 — pay per request with crypto, no accounts needed",
    freeEndpoints: ["GET /health"],
    paidEndpoints: {
      "GET /premium/weather": "$0.001 USDC per request",
      "GET /premium/news": "$0.001 USDC per request",
      "GET /premium/stock/:symbol": "$0.002 USDC per request",
    },
    howToPayNatively: "Send HTTP request → get 402 → client auto-pays → retry with PAYMENT-SIGNATURE header",
    testnet: true,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n┌─────────────────────────────────────────────────────┐`);
  console.log(`│            🚀 x402 Payment Server                    │`);
  console.log(`├─────────────────────────────────────────────────────┤`);
  console.log(`│  URL:       http://localhost:${PORT}                   │`);
  console.log(`│  Network:   Base Sepolia (testnet)                   │`);
  console.log(`│  Protocol:  x402 (HTTP 402 Payment Required)         │`);
  console.log(`├─────────────────────────────────────────────────────┤`);
  console.log(`│  FREE:                                               │`);
  console.log(`│    GET /health                                       │`);
  console.log(`│    GET /                                             │`);
  console.log(`│  PAID (x402):                                        │`);
  console.log(`│    GET /premium/weather         → $0.001 USDC        │`);
  console.log(`│    GET /premium/news            → $0.001 USDC        │`);
  console.log(`│    GET /premium/stock/:symbol   → $0.002 USDC        │`);
  console.log(`└─────────────────────────────────────────────────────┘\n`);
});
