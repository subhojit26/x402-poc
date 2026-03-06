import { useState, useCallback } from "react";
import { createWalletClient, custom, createPublicClient, http, formatUnits } from "viem";
import { baseSepolia } from "viem/chains";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";

// ─── Config ────────────────────────────────────────────────────────────────

// In production set VITE_SERVER_URL in your Vercel environment variables to
// the deployed Railway server URL (e.g. https://your-server.up.railway.app).
// Locally the Vite dev-server proxy forwards /premium and /health to port 4021.
const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? "";

if (import.meta.env.PROD && !import.meta.env.VITE_SERVER_URL) {
  console.warn(
    "[x402] VITE_SERVER_URL is not configured. " +
    "Set it in your Vercel environment variables to the Railway server URL " +
    "and redeploy, otherwise API requests will fail."
  );
}
const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Base Sepolia USDC

// ─── Types ──────────────────────────────────────────────────────────────────

interface Endpoint {
  id: string;
  method: string;
  path: string;
  label: string;
  icon: string;
  price: string;
  description: string;
}

interface RequestState {
  status: "idle" | "connecting" | "signing" | "fetching" | "done" | "error";
  data: unknown;
  txHash?: string;
  payer?: string;
  ms?: number;
  error?: string;
}

// ─── Endpoints to demo ──────────────────────────────────────────────────────

const ENDPOINTS: Endpoint[] = [
  {
    id: "weather",
    method: "GET",
    path: "/premium/weather",
    label: "Weather Data",
    icon: "🌤️",
    price: "$0.001 USDC",
    description: "Real-time weather for San Francisco",
  },
  {
    id: "news",
    method: "GET",
    path: "/premium/news",
    label: "News Headlines",
    icon: "📰",
    price: "$0.001 USDC",
    description: "Latest news headlines feed",
  },
  {
    id: "stock",
    method: "GET",
    path: "/premium/stock/AAPL",
    label: "Stock Quote · AAPL",
    icon: "📈",
    price: "$0.002 USDC",
    description: "Live stock price for Apple (AAPL)",
  },
  {
    id: "music",
    method: "GET",
    path: "/premium/music",
    label: "Buy Music",
    icon: "🎵",
    price: "$0.003 USDC",
    description: "Premium music track purchase",
  },
  {
    id: "video",
    method: "GET",
    path: "/premium/video",
    label: "Buy Video",
    icon: "🎬",
    price: "$0.005 USDC",
    description: "Premium video content purchase",
  },
];

// ─── RPC Configuration for reliable balance fetching ────────────────────────
// Multiple RPC endpoints for redundancy - try them in order if one fails
const RPC_ENDPOINTS = [
  "https://sepolia.base.org",
  "https://base-sepolia-rpc.publicnode.com",
];

// Keep track of which RPC endpoint is working best
let currentRpcIndex = 0;

/**
 * Create a fresh public client for each balance fetch to avoid stale cache.
 * Using `batch: false` and no caching ensures we always get fresh on-chain data.
 */
function createFreshPublicClient(rpcUrl?: string) {
  const url = rpcUrl || RPC_ENDPOINTS[currentRpcIndex];
  return createPublicClient({
    chain: baseSepolia,
    transport: http(url, {
      batch: false,
      retryCount: 2,
      timeout: 10_000,
      fetchOptions: {
        cache: "no-store",
      },
    }),
    batch: {
      multicall: false,
    },
    cacheTime: 0,
  });
}

/**
 * Fetch USDC balance using a direct JSON-RPC `eth_call` via `fetch`.
 *
 * This completely bypasses viem's transport and caching layers to ensure
 * we always read the latest on-chain state. Each call includes a cache-bust
 * query parameter and the `cache: "no-store"` fetch option so neither the
 * browser nor any intermediate CDN can serve a stale response.
 *
 * Falls back across multiple RPC endpoints when one is unreachable.
 */
async function fetchUsdcBalance(address: `0x${string}`): Promise<string> {
  // balanceOf(address) selector = keccak256("balanceOf(address)")[0:4]
  const selector = "0x70a08231";
  const paddedAddress = address.slice(2).toLowerCase().padStart(64, "0");
  const callData = `${selector}${paddedAddress}`;

  let lastError: Error | undefined;

  for (let i = 0; i < RPC_ENDPOINTS.length; i++) {
    const rpcUrl = RPC_ENDPOINTS[(currentRpcIndex + i) % RPC_ENDPOINTS.length];
    try {
      // Append a cache-bust parameter so proxies / CDNs never serve stale data
      const url = `${rpcUrl}?_cb=${Date.now()}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: "eth_call",
          params: [{ to: USDC_ADDRESS, data: callData }, "latest"],
        }),
      });

      const json = (await res.json()) as { result?: string; error?: { message: string } };
      if (json.error) throw new Error(json.error.message);
      if (!json.result || json.result === "0x") throw new Error("Empty RPC result");

      const raw = BigInt(json.result);
      const formatted = formatUnits(raw, 6);

      // Remember a working endpoint
      if (i > 0) {
        currentRpcIndex = (currentRpcIndex + i) % RPC_ENDPOINTS.length;
      }

      console.log(`[x402] Balance (direct RPC ${rpcUrl}): raw=${raw} formatted=${formatted} USDC`);
      return formatted;
    } catch (err) {
      lastError = err as Error;
      console.warn(`[x402] Direct RPC ${rpcUrl} failed:`, lastError.message);
    }
  }

  throw lastError ?? new Error("All RPC endpoints failed");
}

/**
 * Compare two balance strings numerically instead of by string equality.
 * This avoids false-negatives when formatting differs (e.g. "1.993" vs "1.993000").
 */
function balanceChanged(a: string, b: string): boolean {
  const parsedA = parseFloat(a);
  const parsedB = parseFloat(b);
  // If either value is NaN (invalid input), treat as unchanged to avoid false positives
  if (isNaN(parsedA) || isNaN(parsedB)) return false;
  const diff = Math.abs(parsedA - parsedB);
  // Treat any difference > 0.0000001 (well below 1 USDC decimal) as a change
  return diff > 1e-7;
}

/**
 * Poll until balance differs from `before`, or give up after `maxAttempts` tries.
 *
 * Uses the direct JSON-RPC `fetchUsdcBalance` for every poll to bypass caching.
 * Alternates between RPC endpoints on each attempt for maximum freshness.
 * Returns true if balance changed, false if timeout.
 */
async function pollBalanceChange(
  address: `0x${string}`,
  before: string,
  onUpdate: (b: string) => void,
  maxAttempts = 60,
  intervalMs = 2000,
): Promise<boolean> {
  console.log(`[x402] Starting balance polling. Before: ${before} USDC`);

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, i === 0 ? 1000 : intervalMs));

    try {
      // Rotate the preferred RPC so each poll hits a different node
      currentRpcIndex = (currentRpcIndex + 1) % RPC_ENDPOINTS.length;
      const next = await fetchUsdcBalance(address);
      onUpdate(next);

      if (balanceChanged(next, before)) {
        console.log(`[x402] ✅ Balance changed! ${before} → ${next} USDC (attempt ${i + 1})`);
        return true;
      }

      if ((i + 1) % 10 === 0) {
        console.log(`[x402] Polling… ${i + 1}/${maxAttempts}, current: ${next} USDC`);
      }
    } catch (err) {
      console.warn(`[x402] Poll attempt ${i + 1} failed:`, (err as Error).message);
    }
  }

  console.log(`[x402] ❌ Balance polling timed out after ${maxAttempts} attempts`);
  return false;
}

/**
 * Wait for a transaction to confirm on-chain, then refresh the balance.
 *
 * Strategy 1 (txHash available): use `waitForTransactionReceipt` for fast
 *   confirmation, then read the updated balance via direct RPC.
 * Strategy 2 (no txHash): fall back to direct-RPC balance polling.
 */
async function waitForTxAndRefreshBalance(
  address: `0x${string}`,
  balanceBefore: string,
  txHash: string | undefined,
  onUpdate: (b: string) => void,
): Promise<boolean> {
  // ── Strategy 1: wait for tx receipt ────────────────────────────────────────
  if (txHash) {
    try {
      console.log(`[x402] 🔍 Waiting for tx confirmation: ${txHash}`);
      const client = createFreshPublicClient();
      await client.waitForTransactionReceipt({
        hash: txHash as `0x${string}`,
        confirmations: 1,
        timeout: 60_000,
      });
      console.log(`[x402] ✅ Transaction confirmed: ${txHash}`);

      // Give RPC nodes a moment to index the new state
      await new Promise((r) => setTimeout(r, 2_000));

      const newBalance = await fetchUsdcBalance(address);
      onUpdate(newBalance);
      if (balanceChanged(newBalance, balanceBefore)) {
        console.log(`[x402] ✅ Balance updated: ${balanceBefore} → ${newBalance} USDC`);
        return true;
      }
      // Still same – fall through to polling
      console.log("[x402] ⚠️ Balance unchanged after tx confirmation, falling back to polling…");
    } catch (err) {
      console.warn("[x402] waitForTransactionReceipt failed:", (err as Error).message);
    }
  } else {
    console.log("[x402] ⚠️ No txHash — falling back to balance polling.");
  }

  // ── Strategy 2: poll balance via direct RPC ────────────────────────────────
  return pollBalanceChange(address, balanceBefore, onUpdate, 60, 2000);
}

// ─── Wallet hook ────────────────────────────────────────────────────────────

interface WalletState {
  address?: `0x${string}`;
  usdcBalance?: string;
  loading: boolean;
  error?: string;
  balanceUpdating?: boolean; // True when polling for balance update
}

// ─── App ────────────────────────────────────────────────────────────────────

export default function App() {
  const [wallet, setWallet] = useState<WalletState>({ loading: false });
  const [requests, setRequests] = useState<Record<string, RequestState>>({});

  // ── Connect Wallet ─────────────────────────────────────────────────────────
  const connectWallet = useCallback(async () => {
    const eth = (window as unknown as { ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum;
    if (!eth) {
      setWallet({ loading: false, error: "MetaMask not found. Please install it." });
      return;
    }

    setWallet({ loading: true });

    try {
      const walletClient = createWalletClient({
        chain: baseSepolia,
        transport: custom(eth),
      });

      const [address] = await walletClient.requestAddresses();

      // Switch to Base Sepolia if needed
      try {
        await eth.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0x14A34" }], // 84532 in hex
        });
      } catch (switchErr: unknown) {
        // Chain not added yet — add it
        const err = switchErr as { code?: number };
        if (err.code === 4902) {
          await eth.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: "0x14A34",
                chainName: "Base Sepolia",
                nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
                rpcUrls: ["https://sepolia.base.org"],
                blockExplorerUrls: ["https://sepolia.basescan.org"],
              },
            ],
          });
        }
      }

      // Read USDC balance
      const usdcBalance = await fetchUsdcBalance(address);

      setWallet({
        loading: false,
        address,
        usdcBalance,
      });
    } catch (err: unknown) {
      const e = err as Error;
      setWallet({ loading: false, error: e.message });
    }
  }, []);

  // ── Refresh Balance ────────────────────────────────────────────────────────
  const refreshBalance = useCallback(async () => {
    if (!wallet.address) return;
    
    setWallet((w) => ({ ...w, balanceUpdating: true }));
    try {
      // Force refresh to get latest on-chain data
      const newBalance = await fetchUsdcBalance(wallet.address);
      setWallet((w) => ({ ...w, usdcBalance: newBalance, balanceUpdating: false }));
    } catch {
      setWallet((w) => ({ ...w, balanceUpdating: false }));
    }
  }, [wallet.address]);

  // ── Pay & Fetch ────────────────────────────────────────────────────────────
  const payAndFetch = useCallback(async (endpoint: Endpoint) => {
    if (!wallet.address) return;

    const eth = (window as unknown as { ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown>}; }).ethereum;
    if (!eth) return;

    // Fetch current balance before payment to detect changes later
    // Force refresh to get accurate baseline
    const currentAddress = wallet.address;
    const balanceBeforePayment = await fetchUsdcBalance(currentAddress);

    setRequests((r) => ({ ...r, [endpoint.id]: { status: "signing", data: null } }));

    try {
      const walletClient = createWalletClient({
        chain: baseSepolia,
        transport: custom(eth),
      });

      // Build a signer that x402 ExactEvmScheme can use.
      // toClientEvmSigner composes signTypedData (from wallet) with readContract
      // (from publicClient) which is required for Permit2 allowance checks.
      const signer = toClientEvmSigner(
        {
          address: wallet.address,
          signTypedData: (msg: {
            domain: Record<string, unknown>;
            types: Record<string, unknown>;
            primaryType: string;
            message: Record<string, unknown>;
          }) =>
            walletClient.signTypedData({
              ...msg,
              account: wallet.address!,
            } as Parameters<typeof walletClient.signTypedData>[0]),
        },
        createFreshPublicClient(),
      );

      const client = new x402Client();
      client.register("eip155:*", new ExactEvmScheme(signer));

      const fetchWithPayment = wrapFetchWithPayment(fetch, client);

      setRequests((r) => ({ ...r, [endpoint.id]: { status: "fetching", data: null } }));
      const start = Date.now();
      const response = await fetchWithPayment(`${SERVER_URL}${endpoint.path}`);
      const ms = Date.now() - start;

      if (!response.ok) {
        const text = await response.text();
        setRequests((r) => ({
          ...r,
          [endpoint.id]: { status: "error", data: null, error: `HTTP ${response.status}: ${text.slice(0, 200)}` },
        }));
        return;
      }

      const json = (await response.json()) as { data: unknown; _paymentReceipt?: string };

      // Payment receipt from response header
      // The x402 middleware sets the header as "PAYMENT-RESPONSE" (primary)
      // Also check "X-PAYMENT-RESPONSE" as a fallback for compatibility
      // Finally, check the response body for _paymentReceipt (server-side fallback
      // for when proxies/CDNs strip custom response headers)
      const receiptHeader =
        response.headers.get("PAYMENT-RESPONSE") ||
        response.headers.get("X-PAYMENT-RESPONSE") ||
        json._paymentReceipt ||
        undefined;
      let txHash: string | undefined;
      let payer: string | undefined;
      
      // Log all response headers for debugging
      console.log("[x402] 📋 Response headers:");
      response.headers.forEach((value, key) => {
        console.log(`[x402]   ${key}: ${value.slice(0, 100)}${value.length > 100 ? "…" : ""}`);
      });
      
      if (receiptHeader) {
        try {
          // Use the x402 library's decoder for proper base64 handling
          const receipt = decodePaymentResponseHeader(receiptHeader) as {
            transaction?: string;
            payer?: string;
            success?: boolean;
            network?: string;
          };
          txHash = receipt.transaction;
          payer = receipt.payer;
          console.log(`[x402] 🧾 Payment receipt decoded:`, JSON.stringify(receipt, null, 2));
          console.log(`[x402]   txHash: ${txHash || "(empty)"}`);
          console.log(`[x402]   payer: ${payer || "(empty)"}`);
          console.log(`[x402]   success: ${receipt.success}`);
          console.log(`[x402]   network: ${receipt.network}`);
        } catch (decodeErr) {
          console.warn("[x402] ⚠️ Failed to decode payment response header:", (decodeErr as Error).message);
          console.warn("[x402]   Raw header value:", receiptHeader.slice(0, 200));
          // Fallback: try manual atob parsing
          try {
            const fallbackReceipt = JSON.parse(atob(receiptHeader)) as { transaction?: string; payer?: string };
            txHash = fallbackReceipt.transaction;
            payer = fallbackReceipt.payer;
            console.log("[x402]   Fallback atob decode succeeded. txHash:", txHash);
          } catch {
            console.warn("[x402]   Fallback atob decode also failed");
          }
        }
      } else {
        console.warn("[x402] ⚠️ No payment receipt found in response header or body");
        console.warn("[x402]   Available headers:", [...response.headers.keys()].join(", "));
      }

      setRequests((r) => ({
        ...r,
        [endpoint.id]: { status: "done", data: json.data, txHash, payer, ms },
      }));

      console.log(`[x402] 💳 Payment complete. Endpoint: ${endpoint.path}, Time: ${ms}ms, txHash: ${txHash || "(none)"}`);
      console.log(`[x402] Balance before payment: ${balanceBeforePayment} USDC`);

      // Update balance immediately and poll for changes
      // The payment has been sent, so the balance should reduce once confirmed on-chain
      // Force refresh to get latest on-chain data after payment
      const newBalance = await fetchUsdcBalance(currentAddress);
      setWallet((w) => ({ ...w, usdcBalance: newBalance }));
      console.log(`[x402] Immediate post-payment balance: ${newBalance} USDC`);
      
      // If balance hasn't changed yet (blockchain confirmation pending), wait for tx confirmation
      if (!balanceChanged(newBalance, balanceBeforePayment)) {
        console.log(`[x402] ⏳ Balance unchanged (${newBalance} === ${balanceBeforePayment}). Starting tx confirmation wait...`);
        // Mark that we're waiting for balance update
        setWallet((w) => ({ ...w, balanceUpdating: true }));
        
        // Use transaction receipt waiting (more reliable) with balance polling as fallback
        const didChange = await waitForTxAndRefreshBalance(
          currentAddress,
          balanceBeforePayment,
          txHash,
          (b) => setWallet((w) => ({ ...w, usdcBalance: b })),
        );
        
        // Mark polling complete
        setWallet((w) => ({ ...w, balanceUpdating: false }));
        
        // If balance still hasn't changed after waiting, log it
        if (!didChange) {
          console.log(
            "[x402] ❌ Balance update timed out. Transaction may still be processing on-chain. " +
            "Refresh the page or check the transaction on BaseScan to verify." +
            (txHash ? ` TX: https://sepolia.basescan.org/tx/${txHash}` : "")
          );
        }
      } else {
        console.log(`[x402] ✅ Balance updated immediately! Before: ${balanceBeforePayment} → After: ${newBalance} USDC`);
      }
    } catch (err: unknown) {
      const e = err as Error;
      setRequests((r) => ({
        ...r,
        [endpoint.id]: { status: "error", data: null, error: e.message },
      }));
    }
  }, [wallet.address]);

  // ── Render ─────────────────────────────────────────────────────────────────
  const isConnected = !!wallet.address;

  return (
    <div style={styles.root}>
      {/* Header */}
      <header style={styles.header}>
        <div style={styles.headerInner}>
          <div>
            <h1 style={styles.title}>⚡ x402 Payment Demo</h1>
            <p style={styles.subtitle}>
              Pay per API request with USDC · no accounts · no API keys · Base Sepolia testnet
            </p>
          </div>

          {!isConnected ? (
            <button
              style={{ ...styles.btn, ...styles.btnPrimary }}
              onClick={connectWallet}
              disabled={wallet.loading}
            >
              {wallet.loading ? "Connecting…" : "🦊 Connect MetaMask"}
            </button>
          ) : (
            <div style={styles.walletBadge}>
              <div style={styles.walletRow}>
                <span style={styles.dot} />
                <span style={styles.walletAddr}>
                  {wallet.address!.slice(0, 6)}…{wallet.address!.slice(-4)}
                </span>
              </div>
              <div style={styles.balanceRow}>
                <span style={styles.balance}>
                  💰 {Number(wallet.usdcBalance).toFixed(4)} USDC
                  {wallet.balanceUpdating && (
                    <span style={styles.balanceUpdating}> (updating...)</span>
                  )}
                </span>
                <button 
                  style={styles.refreshBtn}
                  onClick={refreshBalance}
                  disabled={wallet.balanceUpdating}
                  title="Refresh balance from blockchain"
                >
                  🔄
                </button>
              </div>
            </div>
          )}
        </div>
        {wallet.error && <p style={styles.errorBanner}>{wallet.error}</p>}
      </header>

      {/* Cards */}
      <main style={styles.main}>
        {!isConnected && (
          <div style={styles.callout}>
            <strong>🧪 Testnet Demo:</strong> This uses Base Sepolia testnet with free testnet USDC.
            <br />
            Transactions are <strong>real blockchain transactions</strong>, but on a test network (no real money).
            <br />
            Connect your MetaMask wallet to try live x402 payments.
            <br />
            <a
              href="https://portal.cdp.coinbase.com/products/faucet"
              target="_blank"
              rel="noreferrer"
              style={styles.link}
            >
              Get testnet USDC →
            </a>
          </div>
        )}

        <div style={styles.grid}>
          {ENDPOINTS.map((ep) => {
            const req = requests[ep.id] ?? { status: "idle", data: null };
            return (
              <EndpointCard
                key={ep.id}
                endpoint={ep}
                req={req}
                disabled={!isConnected}
                onPay={() => payAndFetch(ep)}
              />
            );
          })}
        </div>
      </main>

      {/* Footer */}
      <footer style={styles.footer}>
        x402 Protocol · Base Sepolia Testnet ·{" "}
        <a href="https://x402.org" target="_blank" rel="noreferrer" style={styles.link}>
          x402.org
        </a>{" "}
        ·{" "}
        <a href={`https://github.com/subhojit26/x402-poc`} target="_blank" rel="noreferrer" style={styles.link}>
          GitHub
        </a>
      </footer>
    </div>
  );
}

// ─── Card Component ──────────────────────────────────────────────────────────

function EndpointCard({
  endpoint,
  req,
  disabled,
  onPay,
}: {
  endpoint: Endpoint;
  req: RequestState;
  disabled: boolean;
  onPay: () => void;
}) {
  const busy = req.status === "signing" || req.status === "fetching";

  const statusLabel: Record<RequestState["status"], string> = {
    idle: "",
    connecting: "Connecting…",
    signing: "⏳ Waiting for wallet signature…",
    fetching: "🔄 Sending payment & fetching…",
    done: "",
    error: "",
  };

  return (
    <div style={{ ...styles.card, ...(req.status === "done" ? styles.cardDone : {}) }}>
      <div style={styles.cardHeader}>
        <span style={styles.cardIcon}>{endpoint.icon}</span>
        <div>
          <div style={styles.cardLabel}>{endpoint.label}</div>
          <div style={styles.cardDesc}>{endpoint.description}</div>
        </div>
        <span style={styles.priceBadge}>{endpoint.price}</span>
      </div>

      <button
        style={{
          ...styles.btn,
          ...(disabled || busy ? styles.btnDisabled : styles.btnPrimary),
          width: "100%",
          marginTop: 12,
        }}
        onClick={onPay}
        disabled={disabled || busy}
      >
        {busy ? statusLabel[req.status] : req.status === "done" ? "✅ Pay & Fetch Again" : "⚡ Pay & Fetch"}
      </button>

      {req.status === "signing" || req.status === "fetching" ? (
        <p style={styles.statusText}>{statusLabel[req.status]}</p>
      ) : null}

      {req.status === "error" && (
        <div style={styles.errorBox}>
          <strong>Error:</strong> {req.error}
        </div>
      )}

      {req.status === "done" && (
        <div style={styles.resultBox}>
          {req.txHash && (
            <div style={styles.receipt}>
              <span style={styles.receiptLabel}>🧾 Testnet TX</span>
              <a
                href={`https://sepolia.basescan.org/tx/${req.txHash}`}
                target="_blank"
                rel="noreferrer"
                style={styles.txLink}
              >
                {req.txHash.slice(0, 12)}…{req.txHash.slice(-8)}
              </a>
              <span style={styles.receiptMs}>{req.ms}ms</span>
            </div>
          )}
          {req.txHash && (
            <p style={styles.testnetNote}>
              ✅ Real transaction on Base Sepolia testnet. Balance updates after blockchain confirmation (~5-30s).
            </p>
          )}
          <pre style={styles.pre}>{JSON.stringify(req.data, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  root: {
    minHeight: "100vh",
    background: "linear-gradient(135deg, #0f0f23 0%, #1a1a3e 50%, #0f0f23 100%)",
    color: "#e2e8f0",
    fontFamily: "'Inter', system-ui, sans-serif",
    display: "flex",
    flexDirection: "column",
  },
  header: {
    borderBottom: "1px solid rgba(255,255,255,0.08)",
    padding: "20px 32px",
    background: "rgba(0,0,0,0.3)",
    backdropFilter: "blur(12px)",
  },
  headerInner: {
    maxWidth: 960,
    margin: "0 auto",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 24,
    flexWrap: "wrap",
  },
  title: {
    margin: 0,
    fontSize: 26,
    fontWeight: 700,
    background: "linear-gradient(90deg, #818cf8, #38bdf8)",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
  },
  subtitle: {
    margin: "4px 0 0",
    fontSize: 13,
    color: "#94a3b8",
  },
  walletBadge: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: 4,
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 10,
    padding: "8px 14px",
  },
  walletRow: { display: "flex", alignItems: "center", gap: 6 },
  dot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: "#22c55e",
    boxShadow: "0 0 6px #22c55e",
  },
  walletAddr: { fontSize: 14, fontWeight: 600, fontFamily: "monospace" },
  balanceRow: { display: "flex", alignItems: "center", gap: 6 },
  balance: { fontSize: 12, color: "#94a3b8" },
  balanceUpdating: { 
    fontSize: 11, 
    color: "#fbbf24", 
    fontStyle: "italic",
    animation: "pulse 1.5s ease-in-out infinite",
  },
  refreshBtn: {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    fontSize: 12,
    padding: 2,
    opacity: 0.7,
    transition: "opacity 0.2s",
  },
  errorBanner: {
    marginTop: 10,
    color: "#fca5a5",
    fontSize: 13,
    textAlign: "center",
    maxWidth: 960,
    marginLeft: "auto",
    marginRight: "auto",
  },
  main: {
    flex: 1,
    padding: "32px",
    maxWidth: 960,
    margin: "0 auto",
    width: "100%",
    boxSizing: "border-box",
  },
  callout: {
    background: "rgba(99,102,241,0.1)",
    border: "1px solid rgba(99,102,241,0.3)",
    borderRadius: 10,
    padding: "16px 20px",
    marginBottom: 28,
    fontSize: 14,
    lineHeight: 1.6,
    color: "#c7d2fe",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
    gap: 20,
  },
  card: {
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 14,
    padding: 20,
    transition: "border-color 0.2s",
  },
  cardDone: {
    border: "1px solid rgba(34,197,94,0.35)",
  },
  cardHeader: {
    display: "flex",
    alignItems: "flex-start",
    gap: 12,
  },
  cardIcon: { fontSize: 28, lineHeight: 1 },
  cardLabel: { fontWeight: 600, fontSize: 15 },
  cardDesc: { fontSize: 12, color: "#94a3b8", marginTop: 2 },
  priceBadge: {
    marginLeft: "auto",
    background: "rgba(99,102,241,0.2)",
    border: "1px solid rgba(99,102,241,0.4)",
    borderRadius: 6,
    padding: "2px 8px",
    fontSize: 12,
    fontWeight: 600,
    color: "#a5b4fc",
    whiteSpace: "nowrap",
  },
  btn: {
    padding: "10px 18px",
    borderRadius: 8,
    border: "none",
    fontWeight: 600,
    fontSize: 14,
    cursor: "pointer",
    transition: "opacity 0.15s",
  },
  btnPrimary: {
    background: "linear-gradient(90deg, #6366f1, #8b5cf6)",
    color: "#fff",
  },
  btnDisabled: {
    background: "rgba(255,255,255,0.08)",
    color: "#64748b",
    cursor: "not-allowed",
  },
  statusText: {
    marginTop: 10,
    fontSize: 12,
    color: "#94a3b8",
    textAlign: "center",
    animation: "pulse 1.5s ease-in-out infinite",
  },
  errorBox: {
    marginTop: 12,
    background: "rgba(239,68,68,0.1)",
    border: "1px solid rgba(239,68,68,0.3)",
    borderRadius: 8,
    padding: "10px 12px",
    fontSize: 12,
    color: "#fca5a5",
    wordBreak: "break-word",
  },
  resultBox: {
    marginTop: 12,
  },
  receipt: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
    background: "rgba(34,197,94,0.08)",
    border: "1px solid rgba(34,197,94,0.2)",
    borderRadius: 8,
    padding: "7px 10px",
    fontSize: 12,
    flexWrap: "wrap",
  },
  receiptLabel: { color: "#86efac", fontWeight: 600 },
  txLink: {
    color: "#38bdf8",
    fontFamily: "monospace",
    fontSize: 11,
    textDecoration: "none",
    borderBottom: "1px dashed #38bdf8",
  },
  receiptMs: { marginLeft: "auto", color: "#64748b", fontSize: 11 },
  testnetNote: {
    fontSize: 11,
    color: "#86efac",
    margin: "8px 0",
    padding: "6px 10px",
    background: "rgba(34,197,94,0.08)",
    borderRadius: 6,
    lineHeight: 1.4,
  },
  pre: {
    background: "rgba(0,0,0,0.35)",
    borderRadius: 8,
    padding: 12,
    fontSize: 11,
    overflowX: "auto",
    maxHeight: 240,
    overflowY: "auto",
    color: "#e2e8f0",
    margin: 0,
    lineHeight: 1.5,
  },
  footer: {
    textAlign: "center",
    padding: "20px",
    fontSize: 12,
    color: "#475569",
    borderTop: "1px solid rgba(255,255,255,0.06)",
  },
  link: { color: "#818cf8" },
};
