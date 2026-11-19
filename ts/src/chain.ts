/** Robinhood Chain (4663) as a viem chain — the chain every Polypad action runs on. */
import { defineChain, type Chain } from 'viem';
import { DEFAULT_RPC_URL } from './client.js';

export const robinhoodChain: Chain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [DEFAULT_RPC_URL] },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' },
  },
});
