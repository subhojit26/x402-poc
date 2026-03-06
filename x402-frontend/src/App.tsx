import { useState, useCallback } from "react";
import { createWalletClient, custom, createPublicClient, http, formatUnits, encodeFunctionData } from "viem";
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

// Module-level reference to the MetaMask provider, set when user connects wallet.
// Using MetaMask's own provider for balance reads ensures the website always
// displays the same balance as MetaMask (avoids public-RPC staleness/divergence).
let metaMaskProvider: {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
} | null = null;

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
 * Read USDC balance using MetaMask's own provider (eth_call).
 * This ensures the displayed balance matches exactly what MetaMask shows,
 * avoiding staleness or divergence from public RPC nodes.
 * Returns null if the provider is unavailable or the call fails.
 */
async function fetchUsdcBalanceViaProvider(address: `0x${string}`): Promise<string | null> {
  if (!metaMaskProvider) return null;
  try {
    // Use viem's encodeFunctionData for safe ABI encoding (handles checksums, validation)
    const callData = encodeFunctionData({
      abi: [{ name: "balanceOf", type: "function", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
      functionName: "balanceOf",
      args: [address],
    });
    const result = await metaMaskProvider.request({
      method: "eth_call",
      params: [{ to: USDC_ADDRESS, data: callData }, "latest"],
    });
    // eth_call returns a hex string; validate before converting
    if (typeof result !== "string" || !result.startsWith("0x")) {
      console.warn("[x402] MetaMask eth_call returned unexpected result:", result);
      return null;
    }
    const raw = BigInt(result);
    const formatted = formatUnits(raw, 6);
    console.log(`[x402] Balance via MetaMask provider: raw=${raw.toString()} formatted=${formatted} USDC`);
    return formatted;
  } catch (err) {
    console.warn("[x402] MetaMask eth_call failed:", (err as Error).message);
    return null;
  }
}

/**
 * Fetch USDC balance with retry across multiple RPC endpoints.
 * Tries MetaMask's own provider first (most reliable, matches MetaMask display).
 * Falls back to public RPC endpoints when the provider is unavailable.
 * @param address - Wallet address to check
 * @param forceRefresh - If true, creates a fresh client to bypass any caching
 */
async function fetchUsdcBalance(address: `0x${string}`, forceRefresh = false): Promise<string> {
  console.log(`[x402] fetchUsdcBalance called for ${address.slice(0, 8)}… forceRefresh=${forceRefresh} currentRpcIndex=${currentRpcIndex}`);

  // Prefer MetaMask's provider — it reflects the same data the user sees in their wallet
  const providerBalance = await fetchUsdcBalanceViaProvider(address);
  if (providerBalance !== null) return providerBalance;

  const client = forceRefresh ? createFreshPublicClient() : publicClient;
  
  // Try current RPC, then fallback to others if it fails
  const maxRetries = RPC_ENDPOINTS.length;
  let lastError: Error | undefined;
  
  for (let retry = 0; retry < maxRetries; retry++) {
    try {
      const rpcUrl = RPC_ENDPOINTS[(currentRpcIndex + retry) % RPC_ENDPOINTS.length];
      const retryClient = forceRefresh || retry > 0 ? createFreshPublicClient(rpcUrl) : client;
      
      console.log(`[x402] Querying balance via RPC: ${rpcUrl} (attempt ${retry + 1}/${maxRetries})`);
      
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
      
      const formatted = formatUnits(raw, 6);
      console.log(`[x402] Balance fetched: raw=${raw.toString()} formatted=${formatted} USDC`);
      return formatted;
    } catch (err) {
      lastError = err as Error;
      console.warn(`[x402] RPC ${RPC_ENDPOINTS[(currentRpcIndex + retry) % RPC_ENDPOINTS.length]} failed:`, (err as Error).message);
    }
  }
  
  throw lastError || new Error("All RPC endpoints failed");
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
 * Total polling duration: up to ~60 seconds (increased for testnet delays)
 * Prefers MetaMask's own provider for reads (matches what the user sees in MetaMask).
 * Cycles through public RPC endpoints as fallback on each poll attempt.
 * Returns true if balance changed, false if timeout
 */
async function pollBalanceChange(
  address: `0x${string}`,
  before: string,
  onUpdate: (b: string) => void,
  maxAttempts = 60,  // Increased from 30 to 60 for testnet delays
  intervalMs = 1000,
): Promise<boolean> {
  console.log(`[x402] Starting balance polling. Before: ${before} USDC (parsed: ${parseFloat(before)})`);
  
  for (let i = 0; i < maxAttempts; i++) {
    // First check is faster (500ms), subsequent checks wait full interval
    const delay = i === 0 ? 500 : intervalMs;
    await new Promise((r) => setTimeout(r, delay));
    
    try {
      let next: string | null = null;

      // Prefer MetaMask provider — same data source the user sees in their wallet
      next = await fetchUsdcBalanceViaProvider(address);

      // Fall back to public RPC if provider is unavailable
      if (next === null) {
        const rpcIndex = (currentRpcIndex + i) % RPC_ENDPOINTS.length;
        const rpcUrl = RPC_ENDPOINTS[rpcIndex];
        const freshClient = createFreshPublicClient(rpcUrl);
        const raw = await freshClient.readContract({
          address: USDC_ADDRESS,
          abi: [{ name: "balanceOf", type: "function", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
          functionName: "balanceOf",
          args: [address],
          blockTag: "latest",
        }) as bigint;
        next = formatUnits(raw, 6);
        // Log which RPC is being used (only every 10 attempts to reduce noise)
        if ((i + 1) % 10 === 0) {
          console.log(`[x402] Still polling for balance change... (${i + 1}/${maxAttempts} attempts, current: ${next} USDC, RPC: ${rpcUrl})`);
        }
      }

      onUpdate(next);
      
      if (balanceChanged(next, before)) {
        console.log(`[x402] ✅ Balance updated! Before: ${before} → After: ${next} USDC (took ${i + 1} attempts)`);
        return true;
      }
      
      // Log progress every 10 attempts when using MetaMask provider
      if (metaMaskProvider && (i + 1) % 10 === 0) {
        console.log(`[x402] Still polling for balance change... (${i + 1}/${maxAttempts} attempts, current: ${next} USDC, via MetaMask provider)`);
      }
    } catch (err) {
      console.warn(`[x402] Balance fetch failed on attempt ${i + 1}:`, (err as Error).message);
      // Continue polling even if one fetch fails
    }
  }
  
  console.log(`[x402] ❌ Balance polling completed after ${maxAttempts} attempts without detecting change`);
  return false;
}

/**
 * Get the current chain block number via MetaMask provider (most accurate),
 * falling back to a fresh public RPC client.
 */
async function getLatestBlockNumber(): Promise<bigint> {
  if (metaMaskProvider) {
    try {
      const result = await metaMaskProvider.request({ method: "eth_blockNumber", params: [] });
      if (typeof result === "string" && result.startsWith("0x")) {
        return BigInt(result);
      }
    } catch { /* fall through to public RPC */ }
  }
  return createFreshPublicClient().getBlockNumber();
}

/**
 * Check for USDC Transfer events FROM `fromAddress` starting at `fromBlock`.
 *
 * Uses eth_getLogs (plain HTTP) rather than WebSocket subscriptions because:
 *  1. Works on every public RPC — no eth_subscribe support needed.
 *  2. Queries historical blocks, so it catches transfers that were mined BEFORE
 *     the watcher started (which watchContractEvent cannot do).
 */
async function hasUsdcTransferFrom(
  fromAddress: `0x${string}`,
  fromBlock: bigint,
): Promise<boolean> {
  // keccak256("Transfer(address,address,uint256)")
  const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  // EVM log topics are 32 bytes; address is left-padded with 12 zero bytes
  const paddedAddr = `0x000000000000000000000000${fromAddress.slice(2).toLowerCase()}`;
  const fromBlockHex = `0x${fromBlock.toString(16)}`;

  // Prefer MetaMask provider — queries the same RPC the wallet trusts
  if (metaMaskProvider) {
    try {
      const result = await metaMaskProvider.request({
        method: "eth_getLogs",
        params: [{
          fromBlock: fromBlockHex,
          toBlock: "latest",
          address: USDC_ADDRESS,
          topics: [TRANSFER_TOPIC, paddedAddr],
        }],
      });
      if (Array.isArray(result)) {
        if (result.length > 0) {
          console.log(`[x402] 🔍 Found ${result.length} USDC Transfer(s) from ${fromAddress.slice(0, 8)}… via eth_getLogs`);
        }
        return result.length > 0;
      }
    } catch (err) {
      console.warn("[x402] eth_getLogs (MetaMask) failed:", (err as Error).message);
    }
  }

  // Fallback: public RPC getLogs
  try {
    const logs = await createFreshPublicClient().getLogs({
      address: USDC_ADDRESS,
      event: {
        type: "event",
        name: "Transfer",
        inputs: [
          { type: "address", indexed: true, name: "from" },
          { type: "address", indexed: true, name: "to" },
          { type: "uint256", indexed: false, name: "value" },
        ],
      },
      args: { from: fromAddress },
      fromBlock,
      toBlock: "latest",
    });
    if (logs.length > 0) {
      console.log(`[x402] 🔍 Found ${logs.length} USDC Transfer(s) from ${fromAddress.slice(0, 8)}… via public RPC getLogs`);
    }
    return logs.length > 0;
  } catch (err) {
    console.warn("[x402] getLogs (public RPC) failed:", (err as Error).message);
    return false;
  }
}

/**
 * Wait for a transaction to be confirmed on-chain, then refresh the balance.
 *
 * When txHash IS available: wait for on-chain receipt via waitForTransactionReceipt,
 * then refresh the balance.
 * When txHash is NOT available: poll for USDC Transfer events via eth_getLogs
 * (HTTP, no WebSocket needed) starting from `paymentStartBlock`, with a direct
 * balance check on every iteration as a parallel signal.
 */
async function waitForTxAndRefreshBalance(
  address: `0x${string}`,
  balanceBefore: string,
  txHash: string | undefined,
  paymentStartBlock: bigint,
  onUpdate: (b: string) => void,
): Promise<boolean> {
  if (txHash) {
    try {
      console.log(`[x402] 🔍 Waiting for transaction confirmation: ${txHash}`);
      console.log(`[x402] Using RPC: ${RPC_ENDPOINTS[currentRpcIndex]}`);
      const client = createFreshPublicClient();
      const receipt = await client.waitForTransactionReceipt({
        hash: txHash as `0x${string}`,
        confirmations: 1,
        timeout: 60_000, // 60 second timeout
      });
      console.log(`[x402] ✅ Transaction confirmed on-chain: ${txHash}`);
      console.log(`[x402] Transaction receipt - status: ${receipt.status}, blockNumber: ${receipt.blockNumber}, gasUsed: ${receipt.gasUsed}`);

      // Transaction confirmed — fetch updated balance
      // Prefer MetaMask provider, then try multiple RPCs as fallback
      const providerBalance = await fetchUsdcBalanceViaProvider(address);
      if (providerBalance !== null) {
        onUpdate(providerBalance);
        if (balanceChanged(providerBalance, balanceBefore)) {
          console.log(`[x402] ✅ Balance updated after tx confirmation (MetaMask provider)! Before: ${balanceBefore} → After: ${providerBalance} USDC`);
          return true;
        }
      }

      for (let rpcAttempt = 0; rpcAttempt < RPC_ENDPOINTS.length; rpcAttempt++) {
        const rpcUrl = RPC_ENDPOINTS[(currentRpcIndex + rpcAttempt) % RPC_ENDPOINTS.length];
        try {
          const freshClient = createFreshPublicClient(rpcUrl);
          const raw = await freshClient.readContract({
            address: USDC_ADDRESS,
            abi: [{ name: "balanceOf", type: "function", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
            functionName: "balanceOf",
            args: [address],
            blockTag: "latest",
          }) as bigint;
          const newBalance = formatUnits(raw, 6);
          console.log(`[x402] Post-tx balance from ${rpcUrl}: ${newBalance} USDC (before: ${balanceBefore})`);
          onUpdate(newBalance);

          if (balanceChanged(newBalance, balanceBefore)) {
            console.log(`[x402] ✅ Balance updated after tx confirmation! Before: ${balanceBefore} → After: ${newBalance} USDC`);
            return true;
          }
        } catch (err) {
          console.warn(`[x402] Post-tx balance fetch failed from ${rpcUrl}:`, (err as Error).message);
        }
      }

      // Balance still same right after confirmation; give RPC a moment to catch up
      console.log(`[x402] Balance unchanged immediately after confirmation. Waiting 3s for RPC to catch up...`);
      await new Promise((r) => setTimeout(r, 3000));
      
      // Try MetaMask provider again, then all RPCs after delay
      const providerBalance2 = await fetchUsdcBalanceViaProvider(address);
      if (providerBalance2 !== null) {
        onUpdate(providerBalance2);
        if (balanceChanged(providerBalance2, balanceBefore)) {
          console.log(`[x402] ✅ Balance updated after short delay (MetaMask provider)! Before: ${balanceBefore} → After: ${providerBalance2} USDC`);
          return true;
        }
      }

      for (let rpcAttempt = 0; rpcAttempt < RPC_ENDPOINTS.length; rpcAttempt++) {
        const rpcUrl = RPC_ENDPOINTS[(currentRpcIndex + rpcAttempt) % RPC_ENDPOINTS.length];
        try {
          const freshClient = createFreshPublicClient(rpcUrl);
          const raw = await freshClient.readContract({
            address: USDC_ADDRESS,
            abi: [{ name: "balanceOf", type: "function", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
            functionName: "balanceOf",
            args: [address],
            blockTag: "latest",
          }) as bigint;
          const retryBalance = formatUnits(raw, 6);
          console.log(`[x402] Retry balance from ${rpcUrl}: ${retryBalance} USDC (before: ${balanceBefore})`);
          onUpdate(retryBalance);
          
          if (balanceChanged(retryBalance, balanceBefore)) {
            console.log(`[x402] ✅ Balance updated after short delay! Before: ${balanceBefore} → After: ${retryBalance} USDC`);
            return true;
          }
        } catch (err) {
          console.warn(`[x402] Retry balance fetch failed from ${rpcUrl}:`, (err as Error).message);
        }
      }
      
      console.log(`[x402] ⚠️ Balance still unchanged after tx confirmation + retry. Falling back to extended polling.`);
    } catch (err) {
      console.warn("[x402] ⚠️ waitForTransactionReceipt failed, falling back to balance polling:", (err as Error).message);
    }
  } else {
    // No txHash — poll for USDC Transfer events using eth_getLogs + balance check.
    // eth_getLogs is HTTP-based (no WebSocket needed) and catches transfers that
    // were already mined before this function was called, which watchContractEvent
    // cannot do.
    console.log(`[x402] ⚠️ No txHash — polling for USDC Transfer events from block ${paymentStartBlock}…`);

    const POLL_INTERVAL_MS = 2_000;
    const MAX_WAIT_MS = 60_000;
    const RPC_SYNC_DELAY_MS = 500; // brief delay after detecting event for RPC state to propagate
    const startTime = Date.now();
    let attempt = 0;

    while (Date.now() - startTime < MAX_WAIT_MS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      attempt++;
      const elapsed = Math.round((Date.now() - startTime) / 1000);

      try {
        // Primary signal: on-chain Transfer event — definitive proof payment executed
        const transferFound = await hasUsdcTransferFrom(address, paymentStartBlock);
        if (transferFound) {
          await new Promise((r) => setTimeout(r, RPC_SYNC_DELAY_MS));
          const newBalance = await fetchUsdcBalance(address, true);
          onUpdate(newBalance);
          console.log(`[x402] ✅ USDC Transfer confirmed on-chain! Balance: ${newBalance} USDC (before: ${balanceBefore})`);
          return true;
        }

        // Secondary signal: direct balance change (catches cases where getLogs is unavailable)
        const newBalance = await fetchUsdcBalance(address, true);
        onUpdate(newBalance);
        if (balanceChanged(newBalance, balanceBefore)) {
          console.log(`[x402] ✅ Balance updated! Before: ${balanceBefore} → After: ${newBalance} USDC`);
          return true;
        }

        if (attempt % 5 === 0) {
          console.log(
            `[x402] Waiting for on-chain confirmation… ` +
            `(attempt ${attempt}, ${elapsed}s elapsed, balance: ${newBalance} USDC)`
          );
        }
      } catch (err) {
        console.warn(`[x402] Poll error on attempt ${attempt}:`, (err as Error).message);
      }
    }

    console.log(
      `[x402] ❌ No USDC Transfer event or balance change detected after ` +
      `${Math.round(MAX_WAIT_MS / 1000)}s. ` +
      "The facilitator may not have executed the payment on-chain yet."
    );
    return false;
  }

  // Fallback: poll balance directly (used when event watching fails or receipt wait fails)
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

      // Store the provider reference so balance reads use the same RPC as MetaMask
      metaMaskProvider = eth;

      // Read USDC balance (will use MetaMask provider now that it's set)
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

    // Always keep the module-level provider reference fresh so that balance reads
    // via MetaMask's own eth_call stay accurate throughout the payment flow.
    metaMaskProvider = eth;

    // Capture block number NOW — before the payment is sent — so that the
    // eth_getLogs query in waitForTxAndRefreshBalance doesn't miss the Transfer
    // event that is mined while fetchWithPayment is executing.
    // On failure, use a safe recent-block fallback (current block minus 10) to
    // avoid scanning the entire chain history.
    let paymentStartBlock: bigint;
    try {
      paymentStartBlock = await getLatestBlockNumber();
    } catch {
      // Safe fallback: best-effort estimate of a recent block. We use a small
      // negative offset so that even if the block lookup fails we never query
      // from block 0 (which would scan the entire chain history).
      const roughBlock = Math.floor(Date.now() / 2000); // ~2-second block time on Base Sepolia
      paymentStartBlock = BigInt(Math.max(0, roughBlock - 10));
      console.warn(`[x402] Failed to get block number; using estimated fallback: ${paymentStartBlock}`);
    }

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
      const newBalance = await fetchUsdcBalance(currentAddress, true);
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
          paymentStartBlock,
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
