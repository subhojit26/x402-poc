/**
 * Integration tests for the x402 Payment Server.
 *
 * Coverage:
 *   1. Free endpoints       — GET /  and  GET /health  (always run)
 *   2. CORS headers         — OPTIONS preflight + exposed header list (always run)
 *   3. Premium unauth       — all 5 endpoints return 402 without a payment header (always run)
 *   4. Pay & fetch + balance — full end-to-end payment flow that verifies:
 *        a) The server returns 200 with the correct JSON shape
 *        b) An on-chain USDC Transfer event is emitted (via eth_getLogs)
 *        c) The wallet balance decreases by exactly the endpoint price
 *      Skipped when EVM_PRIVATE_KEY is not set.
 *
 * Usage:
 *   npm test                          # runs groups 1-3
 *   EVM_PRIVATE_KEY=0x… npm test      # runs all groups including pay & fetch
 *
 * Pay & fetch tests require:
 *   - A Base Sepolia wallet private key in EVM_PRIVATE_KEY
 *   - At least $0.012 USDC in that wallet (covers all 5 premium endpoints)
 *   - Network access to the x402 facilitator (https://x402.org/facilitator)
 *   - Network access to Base Sepolia RPC (https://sepolia.base.org)
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { app, middlewareReady } from "./server.js"; // .js extension required for NodeNext

// ─── Constants ───────────────────────────────────────────────────────────────

const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Base Sepolia USDC
const BASE_SEPOLIA_RPC = "https://sepolia.base.org";
const USDC_DECIMALS = 6;
const MIDDLEWARE_TIMEOUT_MS = 30_000;
const BALANCE_POLL_TIMEOUT_MS = 90_000; // testnet confirmations can take up to ~90s
const BALANCE_POLL_INTERVAL_MS = 2_000;
// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// ─── RPC Helpers (no viem required) ─────────────────────────────────────────

/** Generic JSON-RPC call to Base Sepolia. */
async function rpcCall<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(BASE_SEPOLIA_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
  const json = (await res.json()) as { result: T; error?: { message: string } };
  if (json.error) throw new Error(`RPC ${method} error: ${json.error.message}`);
  return json.result;
}

/** USDC balanceOf via raw eth_call. Returns raw BigInt (6 decimals). */
async function getUsdcBalance(address: string): Promise<bigint> {
  const selector = "0x70a08231"; // balanceOf(address)
  const paddedAddr = "0".repeat(24) + address.slice(2).toLowerCase();
  const result = await rpcCall<string>("eth_call", [
    { to: USDC_ADDRESS, data: selector + paddedAddr },
    "latest",
  ]);
  // eth_call returns "0x" for zero balance on some RPCs; normalise
  return result === "0x" ? 0n : BigInt(result);
}

/** Current block number. */
async function getBlockNumber(): Promise<bigint> {
  const result = await rpcCall<string>("eth_blockNumber", []);
  return BigInt(result);
}

/**
 * Poll eth_getLogs for a USDC Transfer FROM `address` starting at `fromBlock`.
 * Returns true as soon as the transfer event is found.
 */
async function waitForTransferFrom(
  address: string,
  fromBlock: bigint,
  timeoutMs: number = BALANCE_POLL_TIMEOUT_MS,
): Promise<boolean> {
  const paddedAddr = "0x" + "0".repeat(24) + address.slice(2).toLowerCase();
  const fromBlockHex = "0x" + fromBlock.toString(16);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, BALANCE_POLL_INTERVAL_MS));
    const logs = await rpcCall<unknown[]>("eth_getLogs", [{
      fromBlock: fromBlockHex,
      toBlock: "latest",
      address: USDC_ADDRESS,
      topics: [TRANSFER_TOPIC, paddedAddr],
    }]).catch(() => [] as unknown[]);
    if (Array.isArray(logs) && logs.length > 0) return true;
  }
  return false;
}

/** Human-readable USDC amount string for assertion messages. */
function formatUsdc(raw: bigint): string {
  return (Number(raw) / 10 ** USDC_DECIMALS).toFixed(6) + " USDC";
}

// ─── Test-server lifecycle ───────────────────────────────────────────────────

let server: http.Server;
let baseUrl: string;
let middlewareInitialized: boolean;

before(async () => {
  // Start the Express app on a random free port
  server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://localhost:${port}`;

  // Wait for the x402 payment middleware to contact the facilitator.
  // If the facilitator is unreachable (e.g. sandbox without internet) we still
  // run all other tests; the 402 assertions accept 503 as an alternative.
  middlewareInitialized = await Promise.race<boolean>([
    middlewareReady,
    new Promise<boolean>((r) => setTimeout(() => r(false), MIDDLEWARE_TIMEOUT_MS)),
  ]);

  const status = middlewareInitialized ? "ready" : "NOT ready (no network?)";
  console.log(`[test] Server on port ${port} — x402 middleware: ${status}`);
});

after(() => {
  server.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Free endpoints
// ─────────────────────────────────────────────────────────────────────────────

describe("Free endpoints", () => {
  test("GET / — returns server info with all endpoint listings", async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    assert.equal(res.headers.get("Content-Type")?.split(";")[0], "application/json");

    const body = await res.json() as {
      name: string;
      paidEndpoints: Record<string, string>;
      freeEndpoints: string[];
      testnet: boolean;
    };

    assert.equal(typeof body.name, "string", "missing name");
    assert.ok(body.paidEndpoints["GET /premium/weather"],    "missing weather endpoint");
    assert.ok(body.paidEndpoints["GET /premium/news"],       "missing news endpoint");
    assert.ok(body.paidEndpoints["GET /premium/stock/:symbol"], "missing stock endpoint");
    assert.ok(body.paidEndpoints["GET /premium/music"],      "missing music endpoint");
    assert.ok(body.paidEndpoints["GET /premium/video"],      "missing video endpoint");
    assert.equal(body.testnet, true, "must be marked as testnet");
  });

  test("GET /health — returns ok with network and route info", async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);

    const body = await res.json() as {
      status: string;
      protocol: string;
      network: string;
      routes: Record<string, string>;
    };

    assert.equal(body.status, "ok");
    assert.equal(body.protocol, "x402");
    assert.equal(body.network, "eip155:84532", "must target Base Sepolia");
    assert.ok(body.routes["GET /premium/weather"],       "health must list weather route");
    assert.ok(body.routes["GET /premium/news"],          "health must list news route");
    assert.ok(body.routes["GET /premium/stock/:symbol"], "health must list stock route");
    assert.ok(body.routes["GET /premium/music"],         "health must list music route");
    assert.ok(body.routes["GET /premium/video"],         "health must list video route");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. CORS headers
// ─────────────────────────────────────────────────────────────────────────────

describe("CORS headers", () => {
  test("OPTIONS /premium/weather — 204 with x402 payment headers allowed", async () => {
    const res = await fetch(`${baseUrl}/premium/weather`, { method: "OPTIONS" });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");

    const allowed = (res.headers.get("Access-Control-Allow-Headers") ?? "").toLowerCase();
    assert.ok(allowed.includes("payment-signature"), "must allow PAYMENT-SIGNATURE");
    assert.ok(allowed.includes("x-payment"),         "must allow X-Payment");
  });

  test("GET / — Access-Control-Expose-Headers includes x402 response headers", async () => {
    const res = await fetch(`${baseUrl}/`);
    const exposed = res.headers.get("Access-Control-Expose-Headers") ?? "";
    assert.ok(exposed.includes("PAYMENT-RESPONSE"), "must expose PAYMENT-RESPONSE");
    assert.ok(exposed.includes("PAYMENT-REQUIRED"), "must expose PAYMENT-REQUIRED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Premium endpoints — unauthenticated (expect HTTP 402)
// ─────────────────────────────────────────────────────────────────────────────

describe("Premium endpoints — unauthenticated (expect 402)", () => {
  const PREMIUM_ENDPOINTS = [
    { path: "/premium/weather",       price: "$0.001 USDC" },
    { path: "/premium/news",          price: "$0.001 USDC" },
    { path: "/premium/stock/AAPL",    price: "$0.002 USDC" },
    { path: "/premium/music",         price: "$0.003 USDC" },
    { path: "/premium/video",         price: "$0.005 USDC" },
  ];

  for (const { path, price } of PREMIUM_ENDPOINTS) {
    test(`GET ${path} — blocked without payment, requires ${price}`, async () => {
      const res = await fetch(`${baseUrl}${path}`);

      // 402 when middleware is ready; 503 when the facilitator is unreachable
      // (common in sandboxed CI environments without outbound internet).
      assert.ok(
        res.status === 402 || res.status === 503,
        `expected 402 or 503, got ${res.status}`,
      );

      if (res.status === 402) {
        // x402 protocol: 402 responses MUST carry a WWW-Authenticate header
        // with the payment details so the client knows how to pay.
        const wwwAuth =
          res.headers.get("WWW-Authenticate") ??
          res.headers.get("www-authenticate");
        assert.ok(wwwAuth, "402 must include a WWW-Authenticate header");

        // The body should be a JSON object (not a raw string or HTML page)
        const body = await res.json().catch(() => null);
        assert.ok(body !== null, "402 body should be valid JSON");
      }
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3b. Middleware route matching — verify x402 middleware properly intercepts
//     all premium routes (not bypassed due to Express path stripping)
// ─────────────────────────────────────────────────────────────────────────────

describe("Middleware route matching", () => {
  // These tests ensure the x402 middleware receives the full req.path including
  // the /premium prefix. If the middleware were mounted at app.use("/premium"),
  // Express would strip the prefix and route matching would silently fail,
  // causing premium endpoints to return 200 without payment.

  test("Premium endpoints never return 200 without payment", async () => {
    const paths = [
      "/premium/weather",
      "/premium/news",
      "/premium/stock/AAPL",
      "/premium/music",
      "/premium/video",
    ];
    for (const path of paths) {
      const res = await fetch(`${baseUrl}${path}`);
      // Should be 402 (payment required) or 503 (middleware unavailable).
      // Must NEVER be 200 — that would mean payment was bypassed.
      assert.ok(
        res.status === 402 || res.status === 503,
        `${path}: expected 402 or 503 (payment gating), got ${res.status} — ` +
        "payment middleware may not be intercepting this route",
      );
    }
  });

  test("Free endpoints still return 200", async () => {
    for (const path of ["/", "/health"]) {
      const res = await fetch(`${baseUrl}${path}`);
      assert.equal(res.status, 200, `${path}: expected 200, got ${res.status}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Pay & fetch — full payment flow with on-chain balance verification
//    Skipped when EVM_PRIVATE_KEY is not configured.
// ─────────────────────────────────────────────────────────────────────────────

const PRIVATE_KEY = process.env.EVM_PRIVATE_KEY as `0x${string}` | undefined;
const SKIP_REASON =
  !PRIVATE_KEY || PRIVATE_KEY === "0xYOUR_PRIVATE_KEY_HERE"
    ? "EVM_PRIVATE_KEY not set — skipping pay & fetch tests"
    : false;

// Payment options applied to every pay-and-fetch test.
// Timeout is generous because testnet block confirmations can be slow.
const PAY_TEST_OPTS = SKIP_REASON
  ? ({ skip: SKIP_REASON } as const)
  : ({ timeout: 120_000 } as const);

describe("Pay & fetch — full payment flow with balance verification", () => {
  // fetchWithPayment and signerAddress are initialised inside the before() hook
  // so that heavy imports (viem, @x402/fetch) are only loaded when the tests
  // will actually run.
  let fetchWithPayment: (input: string, init?: RequestInit) => Promise<Response>;
  let signerAddress: string;

  before(async () => {
    if (SKIP_REASON) return;

    // Dynamic imports keep startup fast when the suite is skipped.
    // Import x402Client and wrapFetchWithPayment from the SAME package
    // (@x402/fetch) to avoid private-property type conflicts caused by
    // @x402/fetch bundling its own copy of @x402/core.
    const { wrapFetchWithPayment, x402Client } = await import("@x402/fetch");
    const { ExactEvmScheme }                   = await import("@x402/evm/exact/client");
    const { toClientEvmSigner }                = await import("@x402/evm");
    const { createPublicClient, http }         = await import("viem");
    const { baseSepolia }                      = await import("viem/chains");
    const { privateKeyToAccount }              = await import("viem/accounts");

    const account = privateKeyToAccount(PRIVATE_KEY!);
    signerAddress = account.address;

    // toClientEvmSigner composes the wallet's signTypedData with the public
    // client's readContract — this satisfies the ClientEvmSigner interface
    // required by ExactEvmScheme.
    const pubClient = createPublicClient({
      chain: baseSepolia,
      transport: http("https://sepolia.base.org"),
    });
    const evmSigner = toClientEvmSigner(account, pubClient);

    const client = new x402Client();
    client.register("eip155:*", new ExactEvmScheme(evmSigner));
    fetchWithPayment = wrapFetchWithPayment(fetch, client) as typeof fetchWithPayment;

    const balance = await getUsdcBalance(signerAddress);
    const TOTAL_REQUIRED = 12_000n; // $0.012 USDC covers all 5 tests
    console.log(
      `[test] Wallet: ${signerAddress}\n` +
      `[test] USDC balance: ${formatUsdc(balance)}` +
      (balance < TOTAL_REQUIRED
        ? `\n[test] ⚠️  Need at least ${formatUsdc(TOTAL_REQUIRED)} for all payment tests`
        : ""),
    );
  });

  // ── Helper ─────────────────────────────────────────────────────────────────

  /**
   * Core pay-and-fetch assertion used by every endpoint test.
   *
   * Steps:
   *   1. Snapshot USDC balance + current block before the payment.
   *   2. Call fetchWithPayment — this triggers the x402 flow (402 → sign → retry).
   *   3. Assert the response is 200 with correct JSON structure.
   *   4. Optionally assert a specific response body field.
   *   5. Poll eth_getLogs for the on-chain USDC Transfer event (max 90 s).
   *   6. Assert the balance decreased by exactly the expected amount.
   */
  async function assertPayAndFetch(opts: {
    path: string;
    expectedDecrease: bigint; // raw USDC units (6 decimals)
    assertBody: (body: Record<string, unknown>) => void;
  }): Promise<void> {
    const { path, expectedDecrease, assertBody } = opts;

    // 1. Pre-payment snapshot
    const balanceBefore = await getUsdcBalance(signerAddress);
    const startBlock = await getBlockNumber();
    console.log(
      `[test] ${path}: balance before = ${formatUsdc(balanceBefore)}, startBlock = ${startBlock}`,
    );

    // 2. Pay & fetch
    const t = Date.now();
    const res = await fetchWithPayment(`${baseUrl}${path}`);
    console.log(`[test] ${path}: HTTP ${res.status} in ${Date.now() - t}ms`);

    // 3. Assert HTTP 200 with correct content type
    assert.equal(res.status, 200, `payment failed: HTTP ${res.status}`);
    assert.ok(
      res.headers.get("Content-Type")?.includes("application/json"),
      "response must be JSON",
    );

    // 4. Assert response body structure
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.success, true, "response must have success: true");
    assert.equal(body.protocol, "x402",  "response must declare x402 protocol");
    assert.ok(body.data && typeof body.data === "object", "response must include data object");
    assertBody(body);

    // 5. Wait for the on-chain Transfer event
    console.log(`[test] ${path}: waiting for on-chain USDC Transfer event…`);
    const transferFound = await waitForTransferFrom(signerAddress, startBlock);
    assert.ok(
      transferFound,
      `On-chain USDC Transfer event not found within ${BALANCE_POLL_TIMEOUT_MS / 1000}s. ` +
      "The x402 facilitator may not have executed the payment on-chain. " +
      "Check https://sepolia.basescan.org for recent transactions from " + signerAddress,
    );

    // 6. Assert exact balance decrease
    const balanceAfter = await getUsdcBalance(signerAddress);
    const decrease = balanceBefore - balanceAfter;
    console.log(
      `[test] ${path}: balance after = ${formatUsdc(balanceAfter)} ` +
      `(decreased by ${formatUsdc(decrease)})`,
    );
    assert.equal(
      decrease,
      expectedDecrease,
      `expected balance to decrease by ${formatUsdc(expectedDecrease)}, ` +
      `got ${formatUsdc(decrease)} (${formatUsdc(balanceBefore)} → ${formatUsdc(balanceAfter)})`,
    );
  }

  // ── Endpoint tests ─────────────────────────────────────────────────────────

  test("GET /premium/weather — pays $0.001 USDC, returns weather data, balance decreases",
    PAY_TEST_OPTS,
    async () => {
      await assertPayAndFetch({
        path: "/premium/weather",
        expectedDecrease: 1_000n, // $0.001 USDC
        assertBody: (body) => {
          const data = body.data as Record<string, unknown>;
          assert.equal(typeof data.city, "string",       "data.city must be a string");
          assert.equal(typeof data.temperature, "number", "data.temperature must be a number");
          assert.equal(typeof data.condition, "string",  "data.condition must be a string");
          assert.ok(Array.isArray(data.forecast),        "data.forecast must be an array");
        },
      });
    },
  );

  test("GET /premium/news — pays $0.001 USDC, returns headlines, balance decreases",
    PAY_TEST_OPTS,
    async () => {
      await assertPayAndFetch({
        path: "/premium/news",
        expectedDecrease: 1_000n, // $0.001 USDC
        assertBody: (body) => {
          const data = body.data as Record<string, unknown>;
          assert.ok(Array.isArray(data.headlines), "data.headlines must be an array");
          const headlines = data.headlines as Array<Record<string, unknown>>;
          assert.ok(headlines.length > 0, "headlines must not be empty");
          assert.equal(typeof headlines[0].title,  "string", "headline must have title");
          assert.equal(typeof headlines[0].source, "string", "headline must have source");
        },
      });
    },
  );

  test("GET /premium/stock/AAPL — pays $0.002 USDC, returns stock quote, balance decreases",
    PAY_TEST_OPTS,
    async () => {
      await assertPayAndFetch({
        path: "/premium/stock/AAPL",
        expectedDecrease: 2_000n, // $0.002 USDC
        assertBody: (body) => {
          const data = body.data as Record<string, unknown>;
          assert.equal(data.symbol, "AAPL",              "data.symbol must be AAPL");
          assert.equal(typeof data.price, "string",       "data.price must be a string");
          assert.equal(typeof data.change, "string",      "data.change must be a string");
          assert.equal(typeof data.volume, "number",      "data.volume must be a number");
        },
      });
    },
  );

  test("GET /premium/music — pays $0.003 USDC, returns music track, balance decreases",
    PAY_TEST_OPTS,
    async () => {
      await assertPayAndFetch({
        path: "/premium/music",
        expectedDecrease: 3_000n, // $0.003 USDC
        assertBody: (body) => {
          const data = body.data as Record<string, unknown>;
          assert.equal(typeof data.title,    "string", "data.title must be a string");
          assert.equal(typeof data.artist,   "string", "data.artist must be a string");
          assert.equal(typeof data.duration, "string", "data.duration must be a string");
          assert.equal(typeof data.quality,  "string", "data.quality must be a string");
        },
      });
    },
  );

  test("GET /premium/video — pays $0.005 USDC, returns video info, balance decreases",
    PAY_TEST_OPTS,
    async () => {
      await assertPayAndFetch({
        path: "/premium/video",
        expectedDecrease: 5_000n, // $0.005 USDC
        assertBody: (body) => {
          const data = body.data as Record<string, unknown>;
          assert.equal(typeof data.title,      "string", "data.title must be a string");
          assert.equal(typeof data.resolution, "string", "data.resolution must be a string");
          assert.equal(typeof data.duration,   "string", "data.duration must be a string");
          assert.ok(Array.isArray(data.chapters),        "data.chapters must be an array");
        },
      });
    },
  );
});
