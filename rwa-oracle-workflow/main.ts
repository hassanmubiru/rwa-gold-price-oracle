/**
 * RWA Gold Price Oracle — CRE Workflow (TypeScript)
 * ====================================================
 * Track:   #defi-tokenization
 * Target:  Ethereum Sepolia testnet
 *
 * What this workflow does on each execution:
 *  1. Fetches the live PAXG (PAX Gold – tokenized gold) price from CoinGecko
 *     independently on every CRE node, then applies Byzantine-fault-tolerant
 *     consensus median aggregation to produce a single agreed-upon price.
 *  2. Reads the previously stored price from the on-chain Storage contract.
 *  3. Computes the price change in basis points (1 bps = 0.01 %).
 *  4. Publishes the verified price update to the CalculatorConsumer contract
 *     on Sepolia via a signed CRE report — the core primitive required by
 *     tokenized-RWA protocols that need reliable on-chain asset price feeds.
 */

import {
  CronCapability,
  HTTPClient,
  EVMClient,
  handler,
  consensusMedianAggregation,
  Runner,
  type NodeRuntime,
  type Runtime,
  getNetwork,
  LAST_FINALIZED_BLOCK_NUMBER,
  encodeCallMsg,
  bytesToHex,
  hexToBase64,
} from "@chainlink/cre-sdk"
import {
  encodeAbiParameters,
  parseAbiParameters,
  encodeFunctionData,
  decodeFunctionResult,
  zeroAddress,
} from "viem"

// ─── Minimal ABI for the CRE-tutorial Storage contract on Sepolia ────────────
// Deployed at: 0xa17CF997C28FF154eDBae1422e6a50BeF23927F4
// Provides a simple uint256 get/set — we use get() to read the last price.
const StorageABI = [
  {
    name: "get",
    type: "function",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const

// ─── Configuration types ──────────────────────────────────────────────────────

type EvmConfig = {
  /** Human-readable CRE chain selector name, e.g. "ethereum-testnet-sepolia" */
  chainName: string
  /** Storage contract address — used to read the previously published price */
  storageAddress: string
  /** CalculatorConsumer contract address — receives the signed oracle report */
  priceConsumerAddress: string
  /** Gas limit for on-chain write transactions */
  gasLimit: string
}

type Config = {
  /** Cron expression controlling how often the oracle publishes, e.g. every 30 seconds */
  schedule: string
  /** CoinGecko price endpoint for PAXG */
  apiUrl: string
  evms: EvmConfig[]
}

type OracleResult = {
  /** Current PAXG price in USD, scaled to integer cents (e.g. $2867.45 → 286745) */
  currentPriceCents: string
  /** Previous price in cents from the on-chain Storage contract (0 on first run) */
  previousPriceCents: string
  /** Signed price change in basis points; negative = price fell */
  priceChangeBps: string
  /** Transaction hash of the on-chain write operation */
  txHash: string
  /** CRE chain selector name used for the write */
  network: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflow bootstrap — register the cron-triggered handler
// ─────────────────────────────────────────────────────────────────────────────

const initWorkflow = (config: Config) => {
  const cron = new CronCapability()
  return [handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)]
}

// ─────────────────────────────────────────────────────────────────────────────
// Main callback: fetch → read → compute → write
// ─────────────────────────────────────────────────────────────────────────────

const onCronTrigger = (runtime: Runtime<Config>): OracleResult => {
  const evmConfig = runtime.config.evms[0]

  // Resolve the chain selector for Sepolia
  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: evmConfig.chainName,
    isTestnet: true,
  })
  if (!network) {
    throw new Error(`Unknown CRE chain name: ${evmConfig.chainName}`)
  }

  // ── Step 1: Consensus price fetch ──────────────────────────────────────────
  // runInNodeMode runs fetchPaxgPriceCents on every individual CRE node
  // (non-deterministic, network I/O allowed), then the DON applies
  // consensusMedianAggregation to agree on a single canonical price.
  runtime.log("[1/4] Fetching PAXG price from CoinGecko across CRE nodes…")

  const currentPriceCents: bigint = runtime
    .runInNodeMode(fetchPaxgPriceCents, consensusMedianAggregation())()
    .result()

  runtime.log(
    `[1/4] ✔ Consensus PAXG price: $${(Number(currentPriceCents) / 100).toFixed(2)} USD`,
  )

  // ── Step 2: Read last published price from the on-chain Storage contract ───
  runtime.log("[2/4] Reading previous price from on-chain Storage contract…")

  const evmClient = new EVMClient(network.chainSelector.selector)
  const callData = encodeFunctionData({ abi: StorageABI, functionName: "get" })

  const contractResult = evmClient
    .callContract(runtime, {
      call: encodeCallMsg({
        from: zeroAddress,
        to: evmConfig.storageAddress as `0x${string}`,
        data: callData,
      }),
      blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
    })
    .result()

  const previousPriceCents = decodeFunctionResult({
    abi: StorageABI,
    functionName: "get",
    data: bytesToHex(contractResult.data),
  }) as bigint

  runtime.log(
    `[2/4] ✔ Previous on-chain price: $${(Number(previousPriceCents) / 100).toFixed(2)} USD`,
  )

  // ── Step 3: Compute price change in basis points ───────────────────────────
  // priceChangeBps > 0 → price rose; < 0 → price fell; = 0 → first run
  runtime.log("[3/4] Computing price change…")

  let priceChangeBps = 0n
  if (previousPriceCents > 0n) {
    priceChangeBps =
      ((currentPriceCents - previousPriceCents) * 10000n) / previousPriceCents
  }

  runtime.log(
    `[3/4] ✔ Price change: ${priceChangeBps} bps (${Number(priceChangeBps) / 100}%)`,
  )

  // ── Step 4: Publish the verified price update on-chain ─────────────────────
  // The CalculatorConsumer struct CalculatorResult is re-used here:
  //   offchainValue  = current PAXG price in integer cents  (uint256)
  //   onchainValue   = signed bps change from last price    (int256)
  //   finalResult    = current PAXG price in integer cents  (uint256, canonical)
  runtime.log("[4/4] Writing verified oracle price update on-chain…")

  const txHash = publishOracleUpdate(
    runtime,
    network.chainSelector.selector,
    evmConfig,
    currentPriceCents, // offchainValue
    priceChangeBps, // onchainValue (signed)
    currentPriceCents, // finalResult (canonical price)
  )

  const result: OracleResult = {
    currentPriceCents: currentPriceCents.toString(),
    previousPriceCents: previousPriceCents.toString(),
    priceChangeBps: priceChangeBps.toString(),
    txHash,
    network: evmConfig.chainName,
  }

  runtime.log(
    `[4/4] ✔ Oracle update published — PAXG: $${(Number(currentPriceCents) / 100).toFixed(2)} | Δ: ${priceChangeBps} bps | tx: ${txHash}`,
  )

  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// Node-mode helper — runs independently on each CRE node (non-deterministic)
// Returns the PAXG spot price as integer cents (USD × 100).
// ─────────────────────────────────────────────────────────────────────────────

const fetchPaxgPriceCents = (nodeRuntime: NodeRuntime<Config>): bigint => {
  const httpClient = new HTTPClient()

  const resp = httpClient
    .sendRequest(nodeRuntime, {
      url: nodeRuntime.config.apiUrl,
      method: "GET" as const,
    })
    .result()

  if (resp.statusCode !== 200) {
    throw new Error(`CoinGecko API returned HTTP ${resp.statusCode}`)
  }

  // CoinGecko response: {"pax-gold":{"usd":2867.45}}
  const bodyText = new TextDecoder().decode(resp.body)
  const data = JSON.parse(bodyText) as { "pax-gold": { usd: number } }
  const priceUsd: number = data["pax-gold"]["usd"]

  if (typeof priceUsd !== "number" || priceUsd <= 0) {
    throw new Error(`Invalid PAXG price from CoinGecko: ${JSON.stringify(data)}`)
  }

  // Convert to integer cents to eliminate floating-point precision risk.
  const priceCents = BigInt(Math.round(priceUsd * 100))
  nodeRuntime.log(`Node PAXG price: $${priceUsd} USD → ${priceCents} cents`)

  return priceCents
}

// ─────────────────────────────────────────────────────────────────────────────
// On-chain write — encode report payload, generate signed report, submit
// ─────────────────────────────────────────────────────────────────────────────

function publishOracleUpdate(
  runtime: Runtime<Config>,
  chainSelector: bigint,
  evmConfig: EvmConfig,
  offchainValue: bigint,
  onchainValue: bigint, // int256 — signed bps change
  finalResult: bigint,
): string {
  const evmClient = new EVMClient(chainSelector)

  // ABI-encode fields matching CalculatorConsumer.CalculatorResult:
  //   struct CalculatorResult { uint256 offchainValue; int256 onchainValue; uint256 finalResult; }
  const reportData = encodeAbiParameters(
    parseAbiParameters(
      "uint256 offchainValue, int256 onchainValue, uint256 finalResult",
    ),
    [offchainValue, onchainValue, finalResult],
  )

  // Generate a DON-signed, cryptographically verified report
  const reportResponse = runtime
    .report({
      encodedPayload: hexToBase64(reportData),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result()

  // Submit the signed report through the CRE Forwarder to the consumer contract
  const writeResult = evmClient
    .writeReport(runtime, {
      receiver: evmConfig.priceConsumerAddress,
      report: reportResponse,
      gasConfig: {
        gasLimit: evmConfig.gasLimit,
      },
    })
    .result()

  const txHash = bytesToHex(writeResult.txHash || new Uint8Array(32))

  runtime.log(`On-chain write succeeded! txHash: ${txHash}`)
  runtime.log(`Etherscan: https://sepolia.etherscan.io/tx/${txHash}`)

  return txHash
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function main() {
  const runner = await Runner.newRunner<Config>()
  await runner.run(initWorkflow)
}

main()
