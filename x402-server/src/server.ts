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
import { fileURLToPath } from "node:url";

// True only when this file is the entry point (not when imported by tests)
const isMain = process.argv[1] === fileURLToPath(import.meta.url);

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
// Can be updated at runtime via POST /config/receiver
let PAYMENT_RECEIVER: string =
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

// NOTE: Route keys must NOT include the "/premium" mount prefix.
// Express strips the mount path from req.path when app.use("/premium", fn) is
// called, so the middleware sees "/weather" not "/premium/weather".
function buildPremiumRoutes(receiver: string) {
  return {
  "GET /weather": {
    accepts: {
      scheme: "exact",
      price: "$0.001", // $0.001 USDC per request (~fraction of a cent)
      network: NETWORK,
      payTo: receiver,
      maxTimeoutSeconds: 60,
    },
    description: "Real-time weather data (testnet demo)",
    mimeType: "application/json",
  },
  "GET /news": {
    accepts: {
      scheme: "exact",
      price: "$0.001",
      network: NETWORK,
      payTo: receiver,
      maxTimeoutSeconds: 60,
    },
    description: "Latest news headlines (testnet demo)",
    mimeType: "application/json",
  },
  // x402 route regex uses * as wildcard; Express :param syntax is NOT supported.
  "GET /stock/*": {
    accepts: {
      scheme: "exact",
      price: "$0.002", // More expensive — more valuable data
      network: NETWORK,
      payTo: receiver,
      maxTimeoutSeconds: 60,
    },
    description: "Stock quote data (testnet demo)",
    mimeType: "application/json",
  },
  "GET /music": {
    accepts: {
      scheme: "exact",
      price: "$0.003", // Music content - higher value
      network: NETWORK,
      payTo: receiver,
      maxTimeoutSeconds: 60,
    },
    description: "Premium music track purchase (testnet demo)",
    mimeType: "application/json",
  },
  "GET /video": {
    accepts: {
      scheme: "exact",
      price: "$0.005", // Video content - highest value
      network: NETWORK,
      payTo: receiver,
      maxTimeoutSeconds: 60,
    },
    description: "Premium video content purchase (testnet demo)",
    mimeType: "application/json",
  },
  } satisfies Parameters<typeof paymentMiddleware>[0];
}

let paymentMiddlewareInitialized = false;
let premiumPaymentMiddleware: RequestHandler | undefined;

/**
 * Resolves to true when the x402 payment middleware is ready, false on failure.
 * Exported so tests can await middleware readiness before making 402 assertions.
 */
export const middlewareReady: Promise<boolean> = (async () => {
  try {
    await resourceServer.initialize();
    premiumPaymentMiddleware = paymentMiddleware(buildPremiumRoutes(PAYMENT_RECEIVER), resourceServer);
    paymentMiddlewareInitialized = true;
    return true;
  } catch (error) {
    console.error(
      "x402 payment middleware unavailable; premium routes disabled. Check facilitator reachability and outbound network access.",
      {
        facilitators: FACILITATOR_URLS,
        error,
      }
    );
    return false;
  }
})();

// Settlement receipt injection middleware.
// The x402 payment middleware sets a PAYMENT-RESPONSE header with the settlement
// receipt (txHash, payer, etc.). However, cross-origin requests through proxies
// and CDNs (Vercel, Railway) may strip custom response headers even when
// Access-Control-Expose-Headers is configured. As a robust fallback, this
// middleware intercepts res.setHeader() to capture the receipt the instant x402
// sets it, then intercepts res.end() to inject it into the JSON body so the
// client can always access the receipt even when headers are stripped.
app.use("/premium", (_req, res, next) => {
  let capturedReceipt: string | null = null;
  let injected = false;

  // Capture the receipt value the moment x402 sets PAYMENT-RESPONSE.
  // This is more reliable than calling res.getHeader() during res.end() replay,
  // because by that point headers may already be marked as sent.
  const origSetHeader = res.setHeader.bind(res);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (res as any).setHeader = function (name: string, value: unknown) {
    if (typeof name === "string" && name.toLowerCase() === "payment-response" && !capturedReceipt) {
      capturedReceipt = String(value);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return origSetHeader(name as any, value as any);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const originalEnd = res.end.bind(res) as (...args: any[]) => any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (res as any).end = function (...endArgs: any[]) {
    const chunk = endArgs[0] as unknown;
    if (!injected && capturedReceipt && res.statusCode < 400 && chunk) {
      injected = true;
      try {
        const bodyStr = Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : typeof chunk === "string"
          ? chunk
          : null;
        if (bodyStr) {
          const json = JSON.parse(bodyStr) as Record<string, unknown>;
          json._paymentReceipt = capturedReceipt;
          const newBody = Buffer.from(JSON.stringify(json), "utf8");
          try { origSetHeader("Content-Length", newBody.length); } catch { /* headers already sent */ }
          endArgs[0] = newBody;
        }
      } catch {
        // Not valid JSON — send as-is
      }
    }
    return originalEnd(...endArgs);
  };

  next();
});

app.use("/premium", (req, res, next) => {
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
// Config Endpoints
// ─────────────────────────────────────────────────────────────────────────────

// Update the payment receiver address at runtime (no restart needed)
app.post("/config/receiver", async (req: Request, res: Response) => {
  const { address } = req.body as { address?: string };
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return res.status(400).json({ success: false, error: "Invalid EVM address" });
  }
  PAYMENT_RECEIVER = address;
  try {
    premiumPaymentMiddleware = paymentMiddleware(buildPremiumRoutes(PAYMENT_RECEIVER), resourceServer);
    paymentMiddlewareInitialized = true;
    console.log(`[x402] Payment receiver updated to: ${PAYMENT_RECEIVER}`);
    return res.json({ success: true, receiver: PAYMENT_RECEIVER });
  } catch (err) {
    return res.status(500).json({ success: false, error: (err as Error).message });
  }
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
    receiverAddress: PAYMENT_RECEIVER,
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

// Export app for use in integration tests (tests import this module and start
// their own listener on a random port — the listener below only fires when
// running the server as the direct entry point).
export { app };

if (isMain) {
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
}
