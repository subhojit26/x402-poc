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

// ─── Shared public client + balance helper ─────────────────────────────────

const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });

async function fetchUsdcBalance(address: `0x${string}`): Promise<string> {
  const raw = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: [{ name: "balanceOf", type: "function", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
    functionName: "balanceOf",
    args: [address],
  }) as bigint;
  return formatUnits(raw, 6);
}

/**
 * Poll until balance differs from `before`, or give up after `maxAttempts` tries.
 * Total polling duration: up to ~15 seconds (initial 500ms + up to 14 x 1000ms)
 */
async function pollBalanceChange(
  address: `0x${string}`,
  before: string,
  onUpdate: (b: string) => void,
  maxAttempts = 15,
  intervalMs = 1000,
) {
  for (let i = 0; i < maxAttempts; i++) {
    // First check is faster (500ms), subsequent checks wait full interval
    const delay = i === 0 ? 500 : intervalMs;
    await new Promise((r) => setTimeout(r, delay));
    const next = await fetchUsdcBalance(address);
    onUpdate(next);
    if (next !== before) return;
  }
}

// ─── Wallet hook ────────────────────────────────────────────────────────────

interface WalletState {
  address?: `0x${string}`;
  usdcBalance?: string;
  loading: boolean;
  error?: string;
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

  // ── Pay & Fetch ────────────────────────────────────────────────────────────
  const payAndFetch = useCallback(async (endpoint: Endpoint) => {
    if (!wallet.address) return;

    const eth = (window as unknown as { ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown>}; }).ethereum;
    if (!eth) return;

    // Fetch current balance before payment to detect changes later
    const currentAddress = wallet.address;
    const balanceBeforePayment = await fetchUsdcBalance(currentAddress);

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
      const newBalance = await fetchUsdcBalance(currentAddress);
      setWallet((w) => ({ ...w, usdcBalance: newBalance }));
      
      // If balance hasn't changed yet (blockchain confirmation pending), poll for changes
      if (newBalance === balanceBeforePayment) {
        pollBalanceChange(currentAddress, balanceBeforePayment, (b) =>
          setWallet((w) => ({ ...w, usdcBalance: b }))
        );
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
              <span style={styles.balance}>💰 {Number(wallet.usdcBalance).toFixed(4)} USDC</span>
            </div>
          )}
        </div>
        {wallet.error && <p style={styles.errorBanner}>{wallet.error}</p>}
      </header>

      {/* Cards */}
      <main style={styles.main}>
        {!isConnected && (
          <div style={styles.callout}>
            Connect your MetaMask wallet (on Base Sepolia) with testnet USDC to try live x402 payments.
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
              <span style={styles.receiptLabel}>🧾 Transaction</span>
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
  balance: { fontSize: 12, color: "#94a3b8" },
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
