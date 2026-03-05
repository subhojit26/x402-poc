import { useState, useCallback } from "react";
import { createWalletClient, custom, createPublicClient, http, formatUnits } from "viem";
import { baseSepolia } from "viem/chains";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";

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
  "https://base-sepolia.blockpi.network/v1/rpc/public",
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
      batch: false, // Disable batching to ensure immediate fresh reads
      retryCount: 2,
      timeout: 10_000,
      fetchOptions: {
        cache: "no-store", // Bypass browser HTTP cache for fresh on-chain data
      },
    }),
    batch: {
      multicall: false, // Disable multicall batching
    },
    cacheTime: 0, // Disable response caching
  });
}

// Shared client for initial reads (cached is fine for non-critical reads)
const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });

/**
 * Fetch USDC balance with retry across multiple RPC endpoints.
 * Creates a fresh client for each read to avoid cached/stale data.
 * @param address - Wallet address to check
 * @param forceRefresh - If true, creates a fresh client to bypass any caching
 */
async function fetchUsdcBalance(address: `0x${string}`, forceRefresh = false): Promise<string> {
  const client = forceRefresh ? createFreshPublicClient() : publicClient;
  
  // Try current RPC, then fallback to others if it fails
  const maxRetries = RPC_ENDPOINTS.length;
  let lastError: Error | undefined;
  
  for (let retry = 0; retry < maxRetries; retry++) {
    try {
      const rpcUrl = RPC_ENDPOINTS[(currentRpcIndex + retry) % RPC_ENDPOINTS.length];
      const retryClient = forceRefresh || retry > 0 ? createFreshPublicClient(rpcUrl) : client;
      
      const raw = await retryClient.readContract({
        address: USDC_ADDRESS,
        abi: [{ name: "balanceOf", type: "function", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
        functionName: "balanceOf",
        args: [address],
        blockTag: "latest", // Explicitly request latest block
      }) as bigint;
      
      // If we had to use a fallback RPC, remember it for future calls
      if (retry > 0) {
        currentRpcIndex = (currentRpcIndex + retry) % RPC_ENDPOINTS.length;
        console.log(`[x402] Switched to RPC endpoint: ${RPC_ENDPOINTS[currentRpcIndex]}`);
      }
      
      return formatUnits(raw, 6);
    } catch (err) {
      lastError = err as Error;
      console.warn(`[x402] RPC ${RPC_ENDPOINTS[(currentRpcIndex + retry) % RPC_ENDPOINTS.length]} failed, trying next...`);
    }
  }
  
  throw lastError || new Error("All RPC endpoints failed");
}

/**
 * Poll until balance differs from `before`, or give up after `maxAttempts` tries.
 * Total polling duration: up to ~60 seconds (increased for testnet delays)
 * Uses fresh RPC reads on each poll to ensure we see on-chain updates.
 * Returns true if balance changed, false if timeout
 */
async function pollBalanceChange(
  address: `0x${string}`,
  before: string,
  onUpdate: (b: string) => void,
  maxAttempts = 60,  // Increased from 30 to 60 for testnet delays
  intervalMs = 1000,
): Promise<boolean> {
  console.log(`[x402] Starting balance polling. Before: ${before} USDC`);
  
  for (let i = 0; i < maxAttempts; i++) {
    // First check is faster (500ms), subsequent checks wait full interval
    const delay = i === 0 ? 500 : intervalMs;
    await new Promise((r) => setTimeout(r, delay));
    
    try {
      // Always force refresh to get latest on-chain data
      const next = await fetchUsdcBalance(address, true);
      onUpdate(next);
      
      if (next !== before) {
        console.log(`[x402] Balance updated! New: ${next} USDC (took ${i + 1} attempts)`);
        return true;
      }
      
      // Log progress every 10 attempts
      if ((i + 1) % 10 === 0) {
        console.log(`[x402] Still polling for balance change... (${i + 1}/${maxAttempts} attempts)`);
      }
    } catch (err) {
      console.warn(`[x402] Balance fetch failed on attempt ${i + 1}:`, err);
      // Continue polling even if one fetch fails
    }
  }
  
  console.log(`[x402] Balance polling completed after ${maxAttempts} attempts without detecting change`);
  return false;
}

/**
 * Wait for a transaction to be confirmed on-chain, then refresh the balance.
 * This is more reliable than balance polling because it uses the actual txHash
 * to wait for blockchain confirmation, avoiding RPC caching issues.
 * Falls back to balance polling if txHash is unavailable or receipt wait fails.
 */
async function waitForTxAndRefreshBalance(
  address: `0x${string}`,
  balanceBefore: string,
  txHash: string | undefined,
  onUpdate: (b: string) => void,
): Promise<boolean> {
  if (txHash) {
    try {
      console.log(`[x402] Waiting for transaction confirmation: ${txHash}`);
      const client = createFreshPublicClient();
      await client.waitForTransactionReceipt({
        hash: txHash as `0x${string}`,
        confirmations: 1,
        timeout: 60_000, // 60 second timeout
      });
      console.log(`[x402] Transaction confirmed on-chain: ${txHash}`);

      // Transaction confirmed — fetch updated balance
      const newBalance = await fetchUsdcBalance(address, true);
      onUpdate(newBalance);

      if (newBalance !== balanceBefore) {
        console.log(`[x402] Balance updated after tx confirmation! New: ${newBalance} USDC`);
        return true;
      }

      // Balance still same right after confirmation; give RPC a moment to catch up
      await new Promise((r) => setTimeout(r, 2000));
      const retryBalance = await fetchUsdcBalance(address, true);
      onUpdate(retryBalance);
      if (retryBalance !== balanceBefore) {
        console.log(`[x402] Balance updated after short delay! New: ${retryBalance} USDC`);
        return true;
      }
    } catch (err) {
      console.warn("[x402] waitForTransactionReceipt failed, falling back to balance polling:", err);
    }
  }

  // Fallback: poll balance directly (used when txHash is unavailable or receipt wait fails)
  return pollBalanceChange(address, balanceBefore, onUpdate);
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
      const newBalance = await fetchUsdcBalance(wallet.address, true);
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
    const balanceBeforePayment = await fetchUsdcBalance(currentAddress, true);

    setRequests((r) => ({ ...r, [endpoint.id]: { status: "signing", data: null } }));

    try {
      const walletClient = createWalletClient({
        chain: baseSepolia,
        transport: custom(eth),
      });

      // Build a signer that x402 ExactEvmScheme can use
      const signer = {
        address: wallet.address,
        signTypedData: (params: Parameters<typeof walletClient.signTypedData>[0]) =>
          walletClient.signTypedData({ ...params, account: wallet.address! }),
      };

      const client = new x402Client();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client.register("eip155:*", new ExactEvmScheme(signer as any));

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

      const json = (await response.json()) as { data: unknown };

      // Payment receipt from response header
      const receiptHeader = response.headers.get("X-PAYMENT-RESPONSE");
      let txHash: string | undefined;
      let payer: string | undefined;
      if (receiptHeader) {
        try {
          const receipt = JSON.parse(atob(receiptHeader)) as { transaction?: string; payer?: string };
          txHash = receipt.transaction;
          payer = receipt.payer;
        } catch {
          // ignore parse errors
        }
      }

      setRequests((r) => ({
        ...r,
        [endpoint.id]: { status: "done", data: json.data, txHash, payer, ms },
      }));

      // Update balance immediately and poll for changes
      // The payment has been sent, so the balance should reduce once confirmed on-chain
      // Force refresh to get latest on-chain data after payment
      const newBalance = await fetchUsdcBalance(currentAddress, true);
      setWallet((w) => ({ ...w, usdcBalance: newBalance }));
      
      // If balance hasn't changed yet (blockchain confirmation pending), wait for tx confirmation
      if (newBalance === balanceBeforePayment) {
        // Mark that we're waiting for balance update
        setWallet((w) => ({ ...w, balanceUpdating: true }));
        
        // Use transaction receipt waiting (more reliable) with balance polling as fallback
        const balanceChanged = await waitForTxAndRefreshBalance(
          currentAddress,
          balanceBeforePayment,
          txHash,
          (b) => setWallet((w) => ({ ...w, usdcBalance: b })),
        );
        
        // Mark polling complete
        setWallet((w) => ({ ...w, balanceUpdating: false }));
        
        // If balance still hasn't changed after waiting, log it
        if (!balanceChanged) {
          console.log(
            "[x402] Balance update timed out. Transaction may still be processing on-chain. " +
            "Refresh the page or check the transaction on BaseScan to verify."
          );
        }
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
