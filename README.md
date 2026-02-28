# RWA Gold Price Oracle — CRE Hackathon Project

> **Chainlink Convergence Hackathon** · Track: `#defi-tokenization`

A Chainlink Runtime Environment (CRE) workflow that fetches the live spot price
of **PAXG (PAX Gold)** — a tokenized real-world gold asset — using Byzantine
fault-tolerant consensus aggregation across CRE nodes, then publishes the
verified price on-chain to Ethereum Sepolia.

## Problem

Tokenized Real-World Asset (RWA) protocols — stablecoins, tokenized commodities,
RWA lending platforms — require reliable, tamper-proof on-chain price feeds for
their underlying assets. A single-node price oracle is a fragile, exploitable
attack surface. CRE's decentralised Oracle Network (DON) with built-in consensus
solves this: multiple nodes independently fetch prices, then reach Byzantine
fault-tolerant agreement before any on-chain write occurs.

## Architecture

```
                 ┌─────────────────────┐
  Cron trigger   │    CRE Workflow     │
  (every 30s)───▶│    (TypeScript)     │
                 └────────┬────────────┘
                          │
            ┌─────────────┼──────────────┐
            ▼             ▼              ▼
         Node 1        Node 2         Node N
           │              │               │
           ▼              ▼               ▼
     CoinGecko API    CoinGecko API   CoinGecko API
     (PAXG/USD)       (PAXG/USD)      (PAXG/USD)
            │              │               │
            └──────────────┼───────────────┘
                           ▼
                 Consensus Median Aggregation
                 (Byzantine Fault Tolerant)
                           │
                 ┌─────────▼──────────┐
                 │  Read Storage.get()│  ← previous price on-chain
                 │  (Sepolia)         │
                 └─────────┬──────────┘
                           │
                 ┌─────────▼──────────┐
                 │  runtime.report()  │  ← DON-signed report
                 │  evmClient.write() │  ← Forwarder → Consumer
                 └─────────┬──────────┘
                           │
              ┌────────────▼───────────────┐
              │  CalculatorConsumer        │
              │  (Sepolia: 0x95e10B…)      │
              │  latestResult.offchainValue│  = current price (cents)
              │  latestResult.onchainValue │  = Δ price (bps, signed)
              │  latestResult.finalResult  │  = current price (cents)
              └────────────────────────────┘
```

### How CRE is used

| CRE Feature | Role |
|---|---|
| `CronCapability` | Triggers price publication every 30 seconds |
| `runInNodeMode` + `consensusMedianAggregation` | Per-node CoinGecko fetch → BFT median price |
| `EVMClient.callContract` | Reads previous stored price from Storage contract |
| `runtime.report()` | Generates a DON-signed cryptographic report |
| `EVMClient.writeReport()` | Submits signed report through Forwarder to consumer |

## On-chain Interaction

**Network:** Ethereum Sepolia testnet (`ethereum-testnet-sepolia`)

**Consumer contract:** [`0x95e10BaC2B89aB4D8508ccEC3f08494FcB3D23cb`](https://sepolia.etherscan.io/address/0x95e10BaC2B89aB4D8508ccEC3f08494FcB3D23cb#code)

**Data written (CalculatorResult struct):**
| Field | Value |
|---|---|
| `offchainValue` | Current PAXG price in USD cents (e.g. $2867.45 → `286745`) |
| `onchainValue` | Signed price change in basis points vs last published price |
| `finalResult` | Current PAXG price in USD cents (canonical oracle value) |

## Prerequisites

- **CRE CLI** (v1.0.0+): Install via `curl -sSL https://cre.chain.link/install.sh | sh`
- **Bun** runtime (v1.2.21+): Install via `curl -fsSL https://bun.sh/install | bash`
- **Funded Sepolia wallet**: Get testnet ETH at [faucets.chain.link](https://faucets.chain.link/)

## Setup

### 1. Clone the repository

```bash
git clone https://github.com/YOUR_USERNAME/rwa-gold-price-oracle.git
cd rwa-gold-price-oracle
```

### 2. Install workflow dependencies

```bash
bun install --cwd ./rwa-oracle-workflow
```

### 3. Set your private key

Copy `.env.example` to `.env` and set your funded Sepolia private key:

```bash
cp .env.example .env
# Edit .env — set CRE_ETH_PRIVATE_KEY to your funded Sepolia testnet private key
```

> ⚠️ **Testnet only.** Never use a mainnet wallet or real funds.

### 4. Verify CRE CLI is installed

```bash
cre --version
```

## Simulation Commands

Run from the project root directory (`rwa-gold-price-oracle/`):

**Dry run** (no transaction broadcast — safe to test):
```bash
cre workflow simulate rwa-oracle-workflow --target staging-settings
```

**Broadcast** (actual Sepolia on-chain write, requires funded wallet):
```bash
cre workflow simulate rwa-oracle-workflow --target staging-settings --broadcast
```

The simulation selects the cron trigger automatically. Successful output includes:

```
[1/4] Fetching PAXG price from CoinGecko across CRE nodes…
[1/4] ✔ Consensus PAXG price: $2867.45 USD
[2/4] Reading previous price from on-chain Storage contract…
[2/4] ✔ Previous on-chain price: $0.00 USD
[3/4] Computing price change…
[3/4] ✔ Price change: 0 bps (0%)
[4/4] Writing verified oracle price update on-chain…
On-chain write succeeded! txHash: 0x...
Etherscan: https://sepolia.etherscan.io/tx/0x...

Workflow Simulation Result:
 {
  "currentPriceCents": "286745",
  "previousPriceCents": "0",
  "priceChangeBps": "0",
  "txHash": "0x...",
  "network": "ethereum-testnet-sepolia"
}
```

## Project Structure

```
rwa-gold-price-oracle/
├── project.yaml                     # CRE project config (RPC endpoints, targets)
├── secrets.yaml                     # Secret declarations (none needed for this project)
├── .env                             # Local private key (not committed)
├── .gitignore
├── README.md
└── rwa-oracle-workflow/
    ├── workflow.yaml                # Workflow config (name, artifact paths)
    ├── package.json                 # Bun/TypeScript dependencies
    ├── config.staging.json          # Runtime config (schedule, API URL, contracts)
    └── main.ts                      # CRE TypeScript workflow logic
```

## Security Notes

- Private keys are loaded from `.env` — never committed to the repository
- This project targets **Sepolia testnet only** — no real funds are involved
- The `.gitignore` explicitly excludes `.env` and key files
- CoinGecko free tier API is used — no API key required or stored

## License

MIT
