/**
 * Recipe 2 — run a tokenized fund from an agent.
 *
 * The manager's agent creates the fund, then mints the manager's own skin shares — both through
 * the agent API, signed with the manager wallet's own key, confirmed through the API. The wallet
 * is bound by the token (POLYPAD_WALLET_TOKEN) — no per-call `from`. After this, investors mint
 * through the same prepare → sign → confirm loop (see the chat-agent helper), and the manager
 * invests under the strategy's limits.
 *
 * Run:  POLYPAD_WALLET_TOKEN=... MANAGER_PRIVATE_KEY=0x... npx tsx examples/run-fund.ts
 *
 * The manager key must be the bound wallet's key — and never the Polypad deployer wallet.
 * Strategy #6 is the LP-Dividend strategy: the Tokenized Fund buys POLYDASH, adds POLYDASH/WETH liquidity,
 * and pays the fees back to share holders. No guaranteed returns.
 */
import type { Hex } from 'viem';
import { PolypadClient } from '../src/index.js';

async function main() {
  const token = process.env.POLYPAD_WALLET_TOKEN;
  const key = process.env.MANAGER_PRIVATE_KEY as Hex | undefined;
  if (!token || !key) throw new Error('Set POLYPAD_WALLET_TOKEN and MANAGER_PRIVATE_KEY first.');

  const client = new PolypadClient({ walletToken: token });
  console.log('Bound wallet (manager):', client.walletAddress());

  // 0. List the published Strategies first, so the choice is explicit — Strategy #6 below
  // is the LP-Dividend strategy the Tokenized Fund is created from.
  const strategies = await client.listFundTemplates();
  console.log('Strategies:', JSON.stringify(strategies).slice(0, 1200));

  // 1. Create the fund: Strategy #6, 0.01 ETH a share, 2 ETH raise cap, 7-day raise.
  const created = await client.prepareSignBroadcast({
    tool: 'polypad_prepare_fund_create',
    arguments: {
      templateId: 6,
      name: 'Polydash Growth Fund',
      symbol: 'PDGFUND',
      mintPriceEth: '0.01',
      raiseCapEth: '2',
      raiseDurationDays: 7,
    },
    privateKey: key,
  });
  console.log('Fund created:', created.status, created.txHash, '—', created.result);
  const fund = created.txStatus.newFund as string | undefined;
  if (!fund) throw new Error('Tokenized Fund created but no fund address came back in the status.');
  console.log('Fund:', fund);

  // 2. Mint the manager's skin shares (Strategy #6 needs 5% before anyone else can mint).
  const skin = created.prepared.extra as { managerSkin?: { shares?: string } } | undefined;
  const shares = Number(skin?.managerSkin?.shares ?? 10);
  const minted = await client.prepareSignBroadcast({
    tool: 'polypad_prepare_fund_mint',
    arguments: { fund, quantity: shares },
    privateKey: key,
  });
  console.log(`Skin minted (${shares} shares):`, minted.status, minted.txHash, '—', minted.result);
  console.log('Raise is open. Investors mint with polypad_prepare_fund_mint; the manager invests after it closes.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
