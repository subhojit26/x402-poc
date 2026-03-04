/**
 * Conventional Payment Server  (Stripe-like simulation)
 *
 * This server simulates the typical B2B/B2C API payment flow you find
 * with providers like Stripe, PayPal, Braintree, etc.
 *
 * The full user journey has 5+ steps before they can call a paid endpoint:
 *   1. Register an account      (POST /auth/register)
 *   2. Verify KYC identity      (POST /auth/verify-kyc)
 *   3. Add a payment method     (POST /payments/add-method)
 *   4. Create a payment intent  (POST /payments/create-intent)
 *   5. Confirm the payment      (POST /payments/confirm/:intentId)
 *   6. Receive a session token  (returned from step 5)
 *   7. FINALLY make the API call with the session token
 *
 * In real life: Steps 2-3 involve KYC (1-3 business days), PCI-DSS
 * compliant card data, chargeback risk, 2.9%+$0.30 per transaction fees,
 * and $3-5 minimum transaction floor.
 */

import express, { type Request, type Response } from "express";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";

const app = express();
app.use(express.json());

const PORT = 4022;

// ─────────────────────────────────────────────────────────────────────────────
// In-memory data stores (simulating a database + Stripe objects)
// ─────────────────────────────────────────────────────────────────────────────

interface UserRecord {
  email: string;
  apiKey: string;
  kycStatus: "pending" | "approved" | "rejected";
  paymentMethods: string[];
  createdAt: Date;
}

interface PaymentIntent {
  id: string;
  userId: string;
  amount: number; // cents
  currency: string;
  status: "requires_payment_method" | "requires_confirmation" | "succeeded" | "failed";
  endpoint: string;
  createdAt: Date;
}

interface Session {
  userId: string;
  sessionToken: string;
  paidEndpoints: string[];
  expiresAt: Date;
  createdAt: Date;
}

const users = new Map<string, UserRecord>();      // userId → user
const apiKeyIndex = new Map<string, string>();    // apiKey → userId
const paymentIntents = new Map<string, PaymentIntent>();
const sessions = new Map<string, Session>();

// ─────────────────────────────────────────────────────────────────────────────
// Auth & Onboarding Endpoints
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Step 1: Register
 * In real Stripe: This creates your Stripe account — requires email,
 * business details, country, etc. Then you wait for email confirmation.
 */
app.post("/auth/register", (req: Request, res: Response) => {
  const { email, password } = req.body;

  if (!email) {
    res.status(400).json({ error: "email is required" });
    return;
  }

  const userId = `user_${uuidv4().slice(0, 8)}`;
  const apiKey = `sk_test_${crypto.randomBytes(20).toString("hex")}`;

  users.set(userId, {
    email,
    apiKey,
    kycStatus: "pending",
    paymentMethods: [],
    createdAt: new Date(),
  });
  apiKeyIndex.set(apiKey, userId);

  res.status(201).json({
    userId,
    apiKey,
    message: "Account created successfully.",
    warnings: [
      "⚠️  KYC verification required before you can make payments (typically 1-3 business days)",
      "⚠️  You must add a payment method before creating payment intents",
      "⚠️  Minimum transaction amount: $0.50 USD",
    ],
    nextStep: "POST /auth/verify-kyc",
  });
});

/**
 * Step 2: KYC Verification
 * In real Stripe: Requires government ID, address proof, sometimes video selfie.
 * Can take 1–3 business days and may be declined.
 */
app.post("/auth/verify-kyc", (req: Request, res: Response) => {
  const { userId, documentType, documentNumber } = req.body;

  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }

  const user = users.get(userId);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  // Simulate KYC processing (instantly approved for demo; in reality 1-3 days)
  user.kycStatus = "approved";

  res.json({
    status: "approved",
    userId,
    message: "KYC verified (SIMULATED — real KYC takes 1–3 business days).",
    simulationNote:
      "In production: requires government ID upload, address verification, may be rejected entirely.",
    nextStep: "POST /payments/add-method",
  });
});

/**
 * Step 3: Add a Payment Method
 * In real Stripe: Requires PCI-DSS compliant tokenization (Stripe.js / Elements),
 * card validation, 3DS authentication, potential declines.
 */
app.post("/payments/add-method", (req: Request, res: Response) => {
  const { apiKey, cardNumber, expiryMonth, expiryYear, cvv } = req.body;

  const userId = apiKeyIndex.get(apiKey);
  if (!userId) {
    res.status(401).json({ error: "Invalid API key" });
    return;
  }

  const user = users.get(userId)!;
  if (user.kycStatus !== "approved") {
    res.status(403).json({
      error: "KYC verification required before adding payment methods",
      kycStatus: user.kycStatus,
    });
    return;
  }

  if (!cardNumber || !expiryMonth || !expiryYear || !cvv) {
    res.status(400).json({ error: "All card fields are required" });
    return;
  }

  // Simulate card tokenization (in real life, this goes through Stripe's servers)
  const paymentMethodId = `pm_${crypto.randomBytes(12).toString("hex")}`;
  const maskedCard = `**** **** **** ${String(cardNumber).slice(-4)}`;

  user.paymentMethods.push(paymentMethodId);

  res.json({
    paymentMethodId,
    maskedCard,
    brand: "visa",
    message: "Payment method added.",
    warnings: [
      "⚠️  Your payment data is stored on a PCI-DSS compliant vault (Stripe handles this)",
      "⚠️  This card can be declined, disputed, or charged back at any time",
    ],
    nextStep: "POST /payments/create-intent",
  });
});

/**
 * Step 4: Create a Payment Intent
 * In real Stripe: Creates a PaymentIntent object with an amount in cents.
 * Has a minimum amount ($0.50 in USD). Involves creating Stripe objects with specific params.
 */
app.post("/payments/create-intent", (req: Request, res: Response) => {
  const { apiKey, amountUSD, endpoint } = req.body;

  const userId = apiKeyIndex.get(apiKey);
  if (!userId) {
    res.status(401).json({ error: "Invalid API key" });
    return;
  }

  const user = users.get(userId)!;
  if (user.paymentMethods.length === 0) {
    res.status(400).json({
      error: "No payment methods on file. Add one first.",
      nextStep: "POST /payments/add-method",
    });
    return;
  }

  const amountCents = Math.round((amountUSD ?? 0.001) * 100);

  // Real Stripe minimum is $0.50 ($50 cents)
  if (amountCents < 50) {
    res.status(400).json({
      error: `Amount too small. Minimum is $0.50 USD. Requested: $${(amountCents / 100).toFixed(3)}`,
      note: "⚠️  x402 has no minimum — you can charge fractions of a cent.",
    });
    return;
  }

  const intentId = `pi_${crypto.randomBytes(16).toString("hex")}`;
  paymentIntents.set(intentId, {
    id: intentId,
    userId,
    amount: amountCents,
    currency: "usd",
    status: "requires_confirmation",
    endpoint: endpoint ?? "all",
    createdAt: new Date(),
  });

  res.json({
    intentId,
    amount: amountCents,
    currency: "usd",
    status: "requires_confirmation",
    description: `Access to ${endpoint ?? "all endpoints"}`,
    warnings: [
      "⚠️  Platform fee: 2.9% + $0.30 per transaction",
      "⚠️  Cross-border transactions: additional 1.5% fee",
      "⚠️  Chargeback risk: you bear the liability",
    ],
    nextStep: `POST /payments/confirm/${intentId}`,
  });
});

/**
 * Step 5: Confirm Payment
 * In real Stripe: This actually charges the card. Risk of declines, 3DS challenges,
 * fraud flags. The money moves through Stripe → your merchant account (2-7 day payout).
 */
app.post("/payments/confirm/:intentId", (req: Request, res: Response) => {
  const { intentId } = req.params;
  const { apiKey, paymentMethodId } = req.body;

  const userId = apiKeyIndex.get(apiKey);
  if (!userId) {
    res.status(401).json({ error: "Invalid API key" });
    return;
  }

  const intent = paymentIntents.get(intentId);
  if (!intent) {
    res.status(404).json({ error: "Payment intent not found" });
    return;
  }

  if (intent.userId !== userId) {
    res.status(403).json({ error: "This payment intent does not belong to you" });
    return;
  }

  // Simulate payment processing (sometimes fails, chargebacks, etc.)
  const shouldFail = Math.random() < 0.05; // 5% simulated failure rate
  if (shouldFail) {
    intent.status = "failed";
    res.status(402).json({
      error: "Card declined",
      code: "card_declined",
      message: "Your card was declined. Please use a different payment method.",
    });
    return;
  }

  intent.status = "succeeded";

  const sessionToken = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

  sessions.set(sessionToken, {
    userId,
    sessionToken,
    paidEndpoints: [intent.endpoint],
    expiresAt,
    createdAt: new Date(),
  });

  const fee = (intent.amount * 0.029 + 30).toFixed(0); // Stripe 2.9% + $0.30

  res.json({
    status: "succeeded",
    intentId,
    sessionToken,
    expiresAt: expiresAt.toISOString(),
    settlement: {
      charged: `$${(intent.amount / 100).toFixed(2)} USD`,
      platformFee: `$${(parseInt(fee) / 100).toFixed(2)} USD`,
      youReceive: `$${((intent.amount - parseInt(fee)) / 100).toFixed(2)} USD`,
      payoutDelay: "2-7 business days to your bank account",
    },
    instructions: "Include sessionToken in X-Session-Token header for API access",
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Middleware: Validate session token
// ─────────────────────────────────────────────────────────────────────────────

function requireSession(req: Request, res: Response, next: () => void) {
  const sessionToken = req.headers["x-session-token"] as string | undefined;

  if (!sessionToken) {
    res.status(401).json({
      error: "Authentication required",
      message: "No X-Session-Token header found",
      howToGetAccess: [
        "1. POST /auth/register            → get userId + apiKey",
        "2. POST /auth/verify-kyc          → wait for approval (1-3 days)",
        "3. POST /payments/add-method      → add a payment method",
        "4. POST /payments/create-intent   → create a payment intent",
        "5. POST /payments/confirm/:id     → confirm payment → get sessionToken",
        "6. Include sessionToken in X-Session-Token header",
      ],
    });
    return;
  }

  const session = sessions.get(sessionToken);
  if (!session) {
    res.status(401).json({ error: "Invalid session token" });
    return;
  }

  if (session.expiresAt < new Date()) {
    sessions.delete(sessionToken);
    res.status(401).json({
      error: "Session expired",
      message: "Your session has expired. Please create a new payment intent.",
    });
    return;
  }

  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// Protected API Endpoints (same data as x402 server)
// ─────────────────────────────────────────────────────────────────────────────

app.get("/premium/weather", requireSession, (_req: Request, res: Response) => {
  res.json({
    success: true,
    protocol: "conventional",
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

app.get("/premium/news", requireSession, (_req: Request, res: Response) => {
  res.json({
    success: true,
    protocol: "conventional",
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

app.get("/premium/stock/:symbol", requireSession, (req: Request, res: Response) => {
  const { symbol } = req.params;
  res.json({
    success: true,
    protocol: "conventional",
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
    protocol: "conventional",
    port: PORT,
    stats: {
      users: users.size,
      activeSessions: [...sessions.values()].filter((s) => s.expiresAt > new Date()).length,
      paymentIntents: paymentIntents.size,
    },
  });
});

app.get("/", (_req: Request, res: Response) => {
  res.json({
    name: "Conventional Payment Demo Server",
    description: "Simulates Stripe-like payment flow. 5 steps before accessing any paid endpoint.",
    freeEndpoints: ["GET /health"],
    paidEndpoints: {
      "GET /premium/weather": "Requires session token",
      "GET /premium/news": "Requires session token",
      "GET /premium/stock/:symbol": "Requires session token",
    },
    requiredFlow: [
      "POST /auth/register",
      "POST /auth/verify-kyc",
      "POST /payments/add-method",
      "POST /payments/create-intent",
      "POST /payments/confirm/:id",
      "→ Then use sessionToken in X-Session-Token header",
    ],
    limitations: [
      "Minimum transaction: $0.50 USD",
      "Platform fee: 2.9% + $0.30 per transaction",
      "KYC: 1-3 business days in production",
      "Payout: 2-7 business days to your bank",
      "Chargebacks: you bear the risk",
      "Not suitable for micropayments (e.g., $0.001)",
      "Not usable by AI agents (no wallet concept)",
    ],
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n┌─────────────────────────────────────────────────────┐`);
  console.log(`│       💳 Conventional Payment Server                  │`);
  console.log(`├─────────────────────────────────────────────────────┤`);
  console.log(`│  URL:       http://localhost:${PORT}                   │`);
  console.log(`│  Protocol:  Stripe-like (simulated)                  │`);
  console.log(`├─────────────────────────────────────────────────────┤`);
  console.log(`│  FLOW (5 steps required before first API call):      │`);
  console.log(`│    1. POST /auth/register                            │`);
  console.log(`│    2. POST /auth/verify-kyc                          │`);
  console.log(`│    3. POST /payments/add-method                      │`);
  console.log(`│    4. POST /payments/create-intent                   │`);
  console.log(`│    5. POST /payments/confirm/:id                     │`);
  console.log(`│    6. GET  /premium/*  (with X-Session-Token)        │`);
  console.log(`└─────────────────────────────────────────────────────┘\n`);
});
