/**
 * Conventional Payment Client  (Stripe-like simulation)
 *
 * This client demonstrates the FULL complexity of a conventional payment flow.
 *
 * Summary of steps required before you can call a single API endpoint:
 *   1. Register an account
 *   2. Submit KYC (wait 1-3 business days in production)
 *   3. Add a payment method (credit card with PCI-DSS compliance)
 *   4. Create a payment intent
 *   5. Confirm the payment (may be declined)
 *   6. Extract session token
 *   7. FINALLY make the actual API request
 */

const SERVER_URL = "http://localhost:4022";

// ─────────────────────────────────────────────────────────────────────────────
// Helper utilities
// ─────────────────────────────────────────────────────────────────────────────

function separator(label: string, note?: string) {
  console.log(`\n${"─".repeat(55)}`);
  console.log(`  ${label}`);
  if (note) console.log(`  ${note}`);
  console.log("─".repeat(55));
}

function timer() {
  const start = Date.now();
  return () => Date.now() - start;
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<T>;
}

async function get<T>(path: string, headers?: Record<string, string>): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, { headers });
  return res.json() as Promise<T>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main demo
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`
┌─────────────────────────────────────────────────────┐
│       Conventional Payment Client Demo               │
├─────────────────────────────────────────────────────┤
│  Protocol: Stripe-like (simulated)                   │
│  Server:   ${SERVER_URL.padEnd(40)} │
└─────────────────────────────────────────────────────┘`);

  const overallTimer = timer();

  // ── Step 1: Register ────────────────────────────────────────────────────
  separator(
    "STEP 1 / 5 — Register Account",
    "⚠️  Real flow: email confirmation required, business details, country, etc."
  );

  let userId: string;
  let apiKey: string;

  try {
    const result = await post<{ userId: string; apiKey: string; warnings: string[] }>(
      "/auth/register",
      { email: `test_${Date.now()}@example.com`, password: "Demo1234!" }
    );
    userId = result.userId;
    apiKey = result.apiKey;
    console.log(`\n  ✅  Registered successfully`);
    console.log(`  📋  User ID : ${userId}`);
    console.log(`  🔑  API Key : ${apiKey}`);
    result.warnings.forEach((w) => console.log(`\n  ${w}`));
  } catch (err) {
    handleConnectionError(err);
    return;
  }

  // ── Step 2: KYC ─────────────────────────────────────────────────────────
  separator(
    "STEP 2 / 5 — KYC Identity Verification",
    "⚠️  Real flow: upload government ID, address proof, wait 1-3 business days"
  );

  const kycResult = await post<{ status: string; simulationNote: string }>(
    "/auth/verify-kyc",
    { userId, documentType: "passport", documentNumber: "AB123456" }
  );
  console.log(`\n  ✅  KYC status: ${kycResult.status} (SIMULATED)`);
  console.log(`  ℹ️   ${kycResult.simulationNote}`);

  // ── Step 3: Add Payment Method ───────────────────────────────────────────
  separator(
    "STEP 3 / 5 — Add Payment Method",
    "⚠️  Real flow: Stripe.js tokenization, 3DS challenge, PCI-DSS compliance"
  );

  const pmResult = await post<{ paymentMethodId: string; maskedCard: string; warnings: string[] }>(
    "/payments/add-method",
    {
      apiKey,
      cardNumber: "4242424242424242", // Stripe test card
      expiryMonth: "12",
      expiryYear: "2027",
      cvv: "123",
    }
  );
  console.log(`\n  ✅  Payment method added`);
  console.log(`  💳  Card: ${pmResult.maskedCard}  [ID: ${pmResult.paymentMethodId}]`);
  pmResult.warnings.forEach((w) => console.log(`\n  ${w}`));

  // ── Step 4: Create Payment Intent ────────────────────────────────────────
  separator(
    "STEP 4 / 5 — Create Payment Intent",
    "⚠️  Real flow: Stripe minimum $0.50 — micropayments impossible"
  );

  // Note: We intentionally use $1.00 here because conventional systems have a
  // $0.50 minimum. x402 can handle $0.001 (or even smaller).
  const intentResult = await post<{
    intentId: string;
    amount: number;
    warnings: string[];
    status: string;
  }>("/payments/create-intent", {
    apiKey,
    amountUSD: 1.0, // $1.00 (minimum viable amount — $0.001 would be rejected!)
    endpoint: "/premium/weather",
  });

  console.log(`\n  ✅  Payment intent created: ${intentResult.intentId}`);
  console.log(`  💰  Amount: $${(intentResult.amount / 100).toFixed(2)} USD`);
  intentResult.warnings.forEach((w) => console.log(`\n  ${w}`));

  // ── Step 5: Confirm Payment ───────────────────────────────────────────────
  separator(
    "STEP 5 / 5 — Confirm & Charge",
    "⚠️  Real flow: card may be declined, 3DS required, fraud checks, chargebacks"
  );

  const confirmResult = await post<{
    status: string;
    sessionToken?: string;
    expiresAt?: string;
    settlement?: {
      charged: string;
      platformFee: string;
      youReceive: string;
      payoutDelay: string;
    };
    error?: string;
  }>(`/payments/confirm/${intentResult.intentId}`, {
    apiKey,
    paymentMethodId: pmResult.paymentMethodId,
  });

  if (!confirmResult.sessionToken) {
    console.log(`\n  ❌  Payment failed: ${confirmResult.error}`);
    console.log("  👉  This happens ~5% of the time even in this simulation.");
    console.log("      In real life: card declines, fraud flags, 3DS failures...");
    return;
  }

  const setupElapsed = overallTimer();
  console.log(`\n  ✅  Payment confirmed!`);
  console.log(`  🎟️   Session token obtained (valid until ${confirmResult.expiresAt})`);
  if (confirmResult.settlement) {
    const s = confirmResult.settlement;
    console.log(`\n  💸  Settlement breakdown:`);
    console.log(`       Charged:     ${s.charged}`);
    console.log(`       Platform fee: ${s.platformFee}  ← you lose this every time`);
    console.log(`       You receive: ${s.youReceive}`);
    console.log(`       Payout:      ${s.payoutDelay}  ← not instant`);
  }
  console.log(`\n  ⏱️   Total setup time: ${setupElapsed}ms (${(setupElapsed / 1000).toFixed(1)}s)`);
  console.log(`       (In production this is measured in DAYS, not milliseconds)`);

  const sessionToken = confirmResult.sessionToken;

  // ── Step 6: Finally use the API ──────────────────────────────────────────
  separator("NOW MAKING API REQUESTS  (5 steps later...)");

  const t1 = timer();
  const weatherData = await get<{ data: unknown }>(
    "/premium/weather",
    { "X-Session-Token": sessionToken }
  );
  const ms1 = t1();

  console.log(`\n  ✅  Weather data received in ${ms1}ms`);
  console.log(`  📊  Data:\n`);
  console.log(JSON.stringify(weatherData.data, null, 4));

  const t2 = timer();
  const newsData = await get<{
    data: { headlines: { title: string; source: string }[] };
  }>(
    "/premium/news",
    { "X-Session-Token": sessionToken }
  );
  const ms2 = t2();

  console.log(`\n  ✅  News data received in ${ms2}ms`);
  console.log(`  📰  Headlines:`);
  newsData.data.headlines.forEach((h) => {
    console.log(`       • [${h.source}] ${h.title}`);
  });

  // ── Final Summary ────────────────────────────────────────────────────────
  const totalElapsed = overallTimer();

  separator("CONVENTIONAL PAYMENT SUMMARY");
  console.log(`
  📋  Steps completed:   5 (register → KYC → add card → create intent → confirm)
  ⏱️   Setup time:       ${setupElapsed}ms (simulated — production = days)
  ⏱️   Data fetch time:  ${ms1}ms + ${ms2}ms
  ⏱️   Total:            ${totalElapsed}ms

  ⚠️  Key limitations observed:
     - 5 separate API calls BEFORE the first useful request
     - KYC adds 1-3 business days in production
     - Minimum transaction: $0.50 (can't do $0.001 micropayments)
     - Platform fee: 2.9% + $0.30 on every transaction
     - Payout delay: 2-7 business days
     - Session tokens expire (need re-authentication)
     - AI agents cannot use this flow (no wallet, no autonomous payment)
     - Chargeback risk falls on the merchant
     - Card data requires PCI-DSS compliance
  `);
}

// ─────────────────────────────────────────────────────────────────────────────
// Error handling
// ─────────────────────────────────────────────────────────────────────────────

function handleConnectionError(err: unknown) {
  const error = err as Error;
  if (error.message?.includes("ECONNREFUSED")) {
    console.error(`\n  ❌  Cannot connect to server at ${SERVER_URL}`);
    console.log("\n  👉  Start the conventional server first:");
    console.log("      cd conventional-server && npm start\n");
  } else {
    console.error(`  ❌  Error: ${error.message}`);
  }
}

main().catch((err) => {
  handleConnectionError(err);
  process.exit(1);
});
