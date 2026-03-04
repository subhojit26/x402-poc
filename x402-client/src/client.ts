/**
 * x402 Payment Client
 *
 * This client demonstrates how SIMPLE it is to pay with x402:
 *
 *   1. Load your wallet private key (one time, from env)
 *   2. Wrap `fetch` with x402 payment handling (three lines)
 *   3. Make requests normally — payment happens automatically
 *
 * Total integration complexity: ~10 lines of setup code.
 * No accounts. No KYC. No API keys. No sessions. Just pay and get data.
 */

import "dotenv/config";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const SERVER_URL = process.env.X402_SERVER_URL ?? "http://localhost:4021";

// ─────────────────────────────────────────────────────────────────────────────
// Helper: pretty print timing info
// ─────────────────────────────────────────────────────────────────────────────

function timer() {
  const start = Date.now();
  return () => Date.now() - start;
}

function separator(label: string) {
  console.log(`\n${"─".repeat(55)}`);
  console.log(`  ${label}`);
  console.log("─".repeat(55));
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 0: Validate environment
// ─────────────────────────────────────────────────────────────────────────────

function validateEnv() {
  const privateKey = process.env.EVM_PRIVATE_KEY;

  if (!privateKey || privateKey === "0xYOUR_PRIVATE_KEY_HERE") {
    console.error("\n❌  EVM_PRIVATE_KEY not configured.");
    console.log("\n  To set up:");
    console.log("  1. Copy .env.example to .env");
    console.log("  2. Generate a testnet wallet:");
    console.log("       npx cast w new");
    console.log("  3. Fund it with USDC on Base Sepolia:");
    console.log("       https://portal.cdp.coinbase.com/products/faucet");
    console.log("  4. Put the private key (with 0x prefix) in .env\n");
    console.log(
      "  💡 Tip: You can still run the server and hit it with curl to"
    );
    console.log(
      "          see the 402 response — no wallet needed for that part.\n"
    );
    process.exit(1);
  }

  return privateKey as `0x${string}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main demo
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`
┌─────────────────────────────────────────────────────┐
│              x402 Payment Client Demo                │
├─────────────────────────────────────────────────────┤
│  Protocol: x402 (HTTP 402 Payment Required)          │
│  Network:  Base Sepolia (testnet USDC)               │
│  Server:   ${SERVER_URL.padEnd(40)} │
└─────────────────────────────────────────────────────┘`);

  // ── Setup (only done once per session) ──────────────────────────────────
  separator("SETUP  (done once, ~5 lines of code)");

  const privateKey = validateEnv();
  const elapsed = timer();

  // 1. Create a wallet signer from private key
  const signer = privateKeyToAccount(privateKey);
  console.log(`  ✅  Wallet address : ${signer.address}`);

  // 2. Create x402 client and register the EVM payment scheme
  const client = new x402Client();
  client.register("eip155:*", new ExactEvmScheme(signer));

  // 3. Wrap the native fetch API — that's it!
  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  console.log(`  ✅  x402 client ready (${elapsed()}ms)`);
  console.log(`  ✅  Scheme registered: exact / eip155:* (EVM)`);

  // ── Request 1: Weather ───────────────────────────────────────────────────
  separator("REQUEST 1 — Weather Data  ($0.001 USDC)");
  console.log("  🔄  Sending request...");
  console.log("      Payment is handled automatically if a 402 is received.\n");

  const t1 = timer();
  try {
    const response = await fetchWithPayment(`${SERVER_URL}/premium/weather`);
    const ms = t1();

    if (response.ok) {
      const data = (await response.json()) as { success: boolean; data: unknown };
      console.log(`  ✅  Response received in ${ms}ms`);
      console.log(`  📊  Weather data:\n`);
      console.log(JSON.stringify(data.data, null, 4));

      // Extract payment receipt from response header
      const httpClient = new x402HTTPClient(client);
      const receipt = httpClient.getPaymentSettleResponse(
        (name) => response.headers.get(name)
      );
      if (receipt) {
        console.log(`\n  🧾  Payment settled:`);
        console.log(JSON.stringify(receipt, null, 4));
      }
    } else {
      console.log(`  ⚠️  Response status: ${response.status}`);
      const body = await response.text();
      console.log(`  Body: ${body.slice(0, 200)}`);
    }
  } catch (err: unknown) {
    const error = err as Error;
    console.error(`  ❌  Error: ${error.message}`);
    if (error.message.includes("ECONNREFUSED")) {
      console.log(
        "\n  👉  Start the x402 server first:  cd x402-server && npm start"
      );
    }
  }

  // ── Request 2: News ───────────────────────────────────────────────────────
  separator("REQUEST 2 — News Headlines  ($0.001 USDC)");
  console.log("  🔄  Sending request...\n");

  const t2 = timer();
  try {
    const response = await fetchWithPayment(`${SERVER_URL}/premium/news`);
    const ms = t2();

    if (response.ok) {
      const data = (await response.json()) as {
        data: { headlines: { title: string; source: string }[] };
      };
      console.log(`  ✅  Response received in ${ms}ms`);
      console.log(`  📰  Headlines:`);
      data.data.headlines.forEach((h) => {
        console.log(`       • [${h.source}] ${h.title}`);
      });
    } else {
      console.log(`  ⚠️  Response status: ${response.status}`);
    }
  } catch (err: unknown) {
    const error = err as Error;
    console.error(`  ❌  Error: ${error.message}`);
  }

  // ── Request 3: Stock ─────────────────────────────────────────────────────
  separator("REQUEST 3 — Stock Quote: AAPL  ($0.002 USDC)");
  console.log("  🔄  Sending request...\n");

  const t3 = timer();
  try {
    const response = await fetchWithPayment(`${SERVER_URL}/premium/stock/AAPL`);
    const ms = t3();

    if (response.ok) {
      const data = (await response.json()) as { data: unknown };
      console.log(`  ✅  Response received in ${ms}ms`);
      console.log(`  📈  Stock data:\n`);
      console.log(JSON.stringify(data.data, null, 4));
    } else {
      console.log(`  ⚠️  Response status: ${response.status}`);
    }
  } catch (err: unknown) {
    const error = err as Error;
    console.error(`  ❌  Error: ${error.message}`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  separator("x402 SUMMARY");
  console.log(`
  ✅  3 paid API requests completed
  💡  Total developer setup:
        - 1 npm install
        - 3 lines to configure the client
        - 0 account registrations
        - 0 API keys needed
        - 0 KYC or approvals
        - Payment handled transparently in HTTP layer
  `);
}

main().catch(console.error);
