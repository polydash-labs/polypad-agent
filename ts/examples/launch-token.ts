/**
 * Recipe 1 — launch a token from a script (the Forge path).
 *
 * Forge launches one token a day this way: prepare the launch through the agent API, sign it with
 * the launcher wallet's own key, broadcast it, and confirm it. The wallet is bound by the token
 * (POLYPAD_WALLET_TOKEN) — no per-call `from`. The staking pool step calls the factory directly:
 * there is no MCP tool for staking pools yet.
 *
 * Run:  POLYPAD_WALLET_TOKEN=... LAUNCHER_PRIVATE_KEY=0x... npx tsx examples/launch-token.ts
 *
 * Dry run (prepare only, needs no key — prints the summary and signing link, signs nothing):
 *   POLYPAD_WALLET_TOKEN=... npx tsx examples/launch-token.ts --dry-run
 *
 * The launcher key must be the bound wallet's key — and never the Polypad deployer wallet.
 */
import { createPublicClient, createWalletClient, http, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PolypadClient } from '../src/index.js';

const RPC_URL = 'https://robinhood.drpc.org';
const STAKING_FACTORY_V2 = '0x4C87aff7009DE1c58E052FEe202349a10b28Be9c' as const;
const ROBINHOOD_CHAIN = {
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
} as const;

const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]);
const stakingFactoryAbi = parseAbi([
  'function createPool(address,address,uint256,uint256,uint256,uint256,uint256,string,string) returns (address)',
  'event PoolCreated(address indexed pool, address indexed creator, address indexed stakeToken, address rewardToken, uint256 rewardAmount)',
]);

async function main() {
  const DRY_RUN = process.argv.includes('--dry-run');
  const token = process.env.POLYPAD_WALLET_TOKEN;
  const key = process.env.LAUNCHER_PRIVATE_KEY as Hex | undefined;
  if (!token) throw new Error('Set POLYPAD_WALLET_TOKEN first.');
  if (!DRY_RUN && !key) throw new Error('Set LAUNCHER_PRIVATE_KEY first (or add --dry-run to prepare only).');

  const client = new PolypadClient({ walletToken: token });
  console.log('Bound wallet:', client.walletAddress());

  const launchArgs = {
    name: 'Agent Swarm',
    symbol: 'SWARM',
    imageUri: 'ipfs://bafybeihk6cgm5ndcrmy6cucrqz44xzqxa3sz3vkqmasj6ubfnpai7rwrkm',
    description: 'Launched by an AI agent on Polypad.',
    creatorFeeBps: 100,
    devBuyEth: '1000000000000000', // 0.001 ETH
    launchDelay: '0',
  };

  // Dry run: prepare the launch, print the summary and signing link, stop before signing.
  if (DRY_RUN) {
    const prepared = await client.prepareTokenLaunch(launchArgs);
    console.log('\n' + prepared.summary.headline);
    for (const line of prepared.summary.lines) console.log('  ' + line);
    console.log('\nSign here (a person, in their own wallet):', prepared.signing.url);
    console.log('Dry run done — nothing was signed or sent.');
    return;
  }

  // 1. Prepare + sign + broadcast the launch. The 0.001 ETH dev buy funds the staking reward.
  const launched = await client.prepareSignBroadcast({
    tool: 'polypad_prepare_token_launch',
    arguments: launchArgs,
    privateKey: key as Hex,
  });
  console.log('Launch:', launched.status, launched.txHash, '—', launched.result);
  const tokenAddress = launched.txStatus.newToken as string | undefined;
  if (!tokenAddress) throw new Error('Launch confirmed but no token address came back in the status.');
  console.log('Token:', tokenAddress);

  // 2. The dev buy's tokens are now in the launcher wallet. Stake all of them: 90 days, 1% fee.
  const account = privateKeyToAccount(key as Hex);
  const publicClient = createPublicClient({ chain: ROBINHOOD_CHAIN, transport: http(RPC_URL) });
  const walletClient = createWalletClient({ account, chain: ROBINHOOD_CHAIN, transport: http(RPC_URL) });
  const rewardAmount = await publicClient.readContract({
    address: tokenAddress as Hex,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  });
  console.log('Reward tokens:', rewardAmount.toString());

  const approveHash = await walletClient.writeContract({
    account,
    address: tokenAddress as Hex,
    abi: erc20Abi,
    functionName: 'approve',
    args: [STAKING_FACTORY_V2, rewardAmount],
    chain: ROBINHOOD_CHAIN,
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });
  console.log('Approved factory:', approveHash);

  const poolHash = await walletClient.writeContract({
    account,
    address: STAKING_FACTORY_V2,
    abi: stakingFactoryAbi,
    functionName: 'createPool',
    args: [
      tokenAddress as Hex,
      tokenAddress as Hex,
      rewardAmount,
      0n, // start now
      BigInt(90 * 24 * 3600), // 90 days
      0n, // no stake cap
      100n, // 1% claim fee (the minimum)
      'SWARM Staking',
      'Stake SWARM to earn SWARM. Launched by an AI agent on Polypad.',
    ],
    chain: ROBINHOOD_CHAIN,
  });
  const poolReceipt = await publicClient.waitForTransactionReceipt({ hash: poolHash });
  console.log('Staking pool:', poolReceipt.status, poolHash);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
