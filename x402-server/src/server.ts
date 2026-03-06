/**
 * x402 Payment Server
 *
 * This server demonstrates the x402 payment protocol.
 * It is 100% "serverless" in terms of payment setup — no accounts, no API keys,
 * no KYC. Clients just pay per request with USDC on Base Sepolia (testnet).
 *
 * The magic:  Adding paymentMiddleware() is the ONLY change needed to monetize an API.
 */

import express, { type Request, type Response, type RequestHandler } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

const app = express();
app.use(express.json());

// CORS — allow all origins for maximum compatibility
app.use((req, res, next) => {
  // Allow all origins
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  // Include all x402 protocol headers: X-Payment, PAYMENT-SIGNATURE, sign-in-with-x,
  // and Access-Control-Expose-Headers (sent as a request header by @x402/fetch)
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Payment, X-PAYMENT, PAYMENT-SIGNATURE, payment-signature, sign-in-with-x, Access-Control-Expose-Headers"
  );
  // Expose all x402 response headers to the client
  res.header(
    "Access-Control-Expose-Headers",
    "X-Payment, X-PAYMENT, X-PAYMENT-RESPONSE, PAYMENT-REQUIRED, PAYMENT-RESPONSE, WWW-Authenticate"
  );
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

// The address that will RECEIVE payments (your wallet address on Base Sepolia)
// Replace with your own testnet wallet address, or keep this for demo purposes
const PAYMENT_RECEIVER =
  process.env.PAYMENT_RECEIVER ||
  "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";

const PORT = process.env.PORT ? Number(process.env.PORT) : 4021;
const NETWORK = "eip155:84532"; // Base Sepolia (testnet) — change to eip155:8453 for mainnet

// ─────────────────────────────────────────────────────────────────────────────
// x402 Setup — this is ALL the payment infrastructure you need
// ─────────────────────────────────────────────────────────────────────────────

const FACILITATOR_URLS = [
  // Public testnet facilitator hosted by x402.org
  "https://x402.org/facilitator",
  // Fallback facilitator endpoint
  "https://api.cdp.coinbase.com/platform/v2/x402",
];

const facilitatorClients = FACILITATOR_URLS.map(
  (url) =>
    new HTTPFacilitatorClient({
      url,
    })
);

const resourceServer = new x402ResourceServer(facilitatorClients).register(
  NETWORK,
  new ExactEvmScheme()
);

// ─────────────────────────────────────────────────────────────────────────────
// Payment Middleware — single call protects ALL configured routes
// ─────────────────────────────────────────────────────────────────────────────

const premiumRoutes = {
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
  "GET /premium/stock/[symbol]": {
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
  "GET /premium/music": {
    accepts: {
      scheme: "exact",
      price: "$0.003", // Music content - higher value
      network: NETWORK,
      payTo: PAYMENT_RECEIVER,
      maxTimeoutSeconds: 60,
    },
    description: "Premium music track purchase (testnet demo)",
    mimeType: "application/json",
  },
  "GET /premium/video": {
    accepts: {
      scheme: "exact",
      price: "$0.005", // Video content - highest value
      network: NETWORK,
      payTo: PAYMENT_RECEIVER,
      maxTimeoutSeconds: 60,
    },
    description: "Premium video content purchase (testnet demo)",
    mimeType: "application/json",
  },
} satisfies Parameters<typeof paymentMiddleware>[0];

let paymentMiddlewareInitialized = false;
let premiumPaymentMiddleware: RequestHandler | undefined;

void (async () => {
  try {
    await resourceServer.initialize();
    premiumPaymentMiddleware = paymentMiddleware(premiumRoutes, resourceServer);
    paymentMiddlewareInitialized = true;
  } catch (error) {
    console.error(
      "x402 payment middleware unavailable; premium routes disabled. Check facilitator reachability and outbound network access.",
      {
        facilitators: FACILITATOR_URLS,
        error,
      }
    );
  }
})();

// Settlement receipt injection middleware.
// The x402 payment middleware sets a PAYMENT-RESPONSE header with the settlement
// receipt (txHash, payer, etc.). However, cross-origin requests through proxies
// and CDNs (Vercel, Railway) may strip custom response headers even when
// Access-Control-Expose-Headers is configured. As a robust fallback, this
// middleware intercepts res.end() *before* the x402 middleware wraps it. When
// x402 replays the buffered response after settlement, our wrapper injects the
// settlement receipt into the JSON body so the client can always access it.
//
// NOTE: Mounted at root (not at "/premium") so req.path retains its full value.
// If mounted at "/premium", Express strips that prefix from req.path, which
// would cause the x402 middleware's route matching to fail.
app.use((req, res, next) => {
  if (!req.path.startsWith("/premium")) return next();

  const originalEnd = res.end.bind(res) as typeof res.end;
  let injected = false;

  (res as { end: typeof res.end }).end = function (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...endArgs: any[]
  ) {
    const paymentHeader =
      res.getHeader("PAYMENT-RESPONSE") ??
      res.getHeader("X-PAYMENT-RESPONSE");

    const chunk = endArgs[0] as unknown;
    if (!injected && paymentHeader && res.statusCode < 400 && chunk && !res.headersSent) {
      injected = true;
      try {
        const bodyStr =
          typeof chunk === "string" ? chunk : (chunk as Buffer).toString();
        const json = JSON.parse(bodyStr) as Record<string, unknown>;
        json._paymentReceipt = String(paymentHeader);
        const newBody = JSON.stringify(json);
        res.setHeader("Content-Length", Buffer.byteLength(newBody));
        endArgs[0] = newBody;
      } catch {
        // Not valid JSON — send as-is
      }
    }

    return originalEnd(...endArgs);
  } as typeof res.end;

  next();
});

app.use((req, res, next) => {
  if (!req.path.startsWith("/premium")) return next();
  if (!paymentMiddlewareInitialized || !premiumPaymentMiddleware) {
    return res.status(503).json({
      success: false,
      error: "Premium payment service is temporarily unavailable. Please try again shortly.",
    });
  }
  return premiumPaymentMiddleware(req, res, next);
});

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

app.get("/premium/music", (_req: Request, res: Response) => {
  res.json({
    success: true,
    protocol: "x402",
    data: {
      title: "Summer Vibes",
      artist: "Digital Dreams",
      album: "Crypto Beats Vol. 1",
      duration: "3:45",
      genre: "Electronic",
      quality: "320kbps",
      downloadUrl: "https://example.com/music/summer-vibes.mp3",
      license: "Personal use only",
      timestamp: new Date().toISOString(),
    },
  });
});

app.get("/premium/video", (_req: Request, res: Response) => {
  res.json({
    success: true,
    protocol: "x402",
    data: {
      title: "Introduction to Web3 Payments",
      creator: "Blockchain Academy",
      duration: "12:30",
      resolution: "1080p",
      format: "MP4",
      description: "Learn how x402 protocol enables seamless pay-per-request APIs",
      streamUrl: "https://example.com/video/web3-payments-intro.mp4",
      chapters: [
        { time: "0:00", title: "Introduction" },
        { time: "2:15", title: "x402 Protocol Overview" },
        { time: "5:30", title: "Setting Up Payment Middleware" },
        { time: "9:00", title: "Client Integration" },
      ],
      license: "Educational use",
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
    premiumRoutesEnabled: paymentMiddlewareInitialized,
    payTo: PAYMENT_RECEIVER,
    routes: {
      "GET /premium/weather": "$0.001 USDC",
      "GET /premium/news": "$0.001 USDC",
      "GET /premium/stock/:symbol": "$0.002 USDC",
      "GET /premium/music": "$0.003 USDC",
      "GET /premium/video": "$0.005 USDC",
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
      "GET /premium/music": "$0.003 USDC per request",
      "GET /premium/video": "$0.005 USDC per request",
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
  const portStr = String(PORT);
  console.log(`│  URL:       http://localhost:${portStr}${" ".repeat(Math.max(0, 19 - portStr.length))}│`);
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
  console.log(`│    GET /premium/music           → $0.003 USDC        │`);
  console.log(`│    GET /premium/video           → $0.005 USDC        │`);
  console.log(`└─────────────────────────────────────────────────────┘\n`);
});
