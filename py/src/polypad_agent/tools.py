"""The 21 ``polypad_*`` tools.

Arguments are plain dicts whose keys match the server exactly — including
``templateId`` (the site calls it a Strategy id) and ``from`` (always a
wallet *address*, never a private key). Amounts in wei are decimal strings;
amounts in ETH are plain decimals like "0.01". On prepare calls ``from`` is
optional when a wallet token is bound — the client passes ``walletToken``
instead and the server resolves the wallet.

Per-tool arguments (required fields marked *):

- what_can_i_do: {}
- intent: {"text"*, "from", "ref"}
- list_tokens: {"sort" (trending/new/graduating/volume/graduated), "q", "phase", "agentLaunched", "limit"}
- get_token: {"token"*}
- token_protections: {"token"*}
- quote_trade: {"token"*, "side"* (buy/sell), "amount", "amountEth", "slippageBps"}
- prepare_buy: {"token"*, "from"*, "amountEth", "amountWei", "slippageBps", "confirmLarge", "ref"}
- prepare_sell: {"token"*, "from"*, "amount", "percentOfBalance", "slippageBps", "ref"}
- list_nfts: {"q", "status", "sort", "limit"}
- list_nft_listings: {"collection", "maxPriceEth", "maxPriceWei", "limit"}
- prepare_nft_buy: {"from"*, "listingId", "collection", "collectionName", "quantity", "confirmLarge", "ref"}
- list_fund_templates: {}
- list_funds: {"open", "status", "templateId", "asset", "manager", "factory", "q", "sort", "limit"}
- get_fund: {"fund"*}
- prepare_fund_create: {"from"*, "name"*, "symbol"*, "templateId", "assets", "mintPriceEth",
  "mintPriceWei", "raiseCapEth", "raiseCapWei", "entryFeeBps", "raiseDurationDays",
  "minSkinBps", "imageUri", "factory", "ref"}
- prepare_fund_mint: {"from"*, "fund"*, "quantity", "confirmLarge", "ref"}
- prepare_fund_redeem: {"from"*, "fund"*, "quantity", "ids", "ref"}
- prepare_token_launch: {"from"*, "name"*, "symbol"*, "creatorFeeBps"* (0–500),
  "imageUri", "description", "socialLinks", "devBuyEth", "launchDelay", "agentMark", "repository", "ref"}
- portfolio: {"address"*}
- get_tx_status: {"hash"*}
- stats: {}
"""

TOOL_NAMES = [
    "polypad_what_can_i_do",
    "polypad_intent",
    "polypad_list_tokens",
    "polypad_get_token",
    "polypad_token_protections",
    "polypad_quote_trade",
    "polypad_prepare_buy",
    "polypad_prepare_sell",
    "polypad_list_nfts",
    "polypad_list_nft_listings",
    "polypad_prepare_nft_buy",
    "polypad_list_fund_templates",
    "polypad_list_funds",
    "polypad_get_fund",
    "polypad_prepare_fund_create",
    "polypad_prepare_fund_mint",
    "polypad_prepare_fund_redeem",
    "polypad_prepare_token_launch",
    "polypad_portfolio",
    "polypad_get_tx_status",
    "polypad_stats",
]

PREPARE_TOOLS = [
    "polypad_prepare_buy",
    "polypad_prepare_sell",
    "polypad_prepare_nft_buy",
    "polypad_prepare_fund_create",
    "polypad_prepare_fund_mint",
    "polypad_prepare_fund_redeem",
    "polypad_prepare_token_launch",
]


def is_prepare_tool(name):
    return name in PREPARE_TOOLS
