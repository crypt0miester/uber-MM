import { TokenConfig } from "@ellipsis-labs/phoenix-sdk";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";

// Interface
export interface Token {
  chainId: number; // 101,
  address: string; // '8f9s1sUmzUbVZMoMh6bufMueYH1u4BJSM57RCEvuVmFp',
  symbol: string; // 'TRUE',
  name: string; // 'TrueSight',
  decimals: number; // 9,
  logoURI: string; // 'https://i.ibb.co/pKTWrwP/true.jpg',
  tags: string[]; // [ 'utility-token', 'capital-token' ]
}

export const KNOWN_TOKENS = [
  {
    address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    chainId: 101,
    decimals: 6,
    name: "USD Coin",
    symbol: "USDC",
    logoURI:
      "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png",
    tags: ["old-registry"],
    extensions: { coingeckoId: "usd-coin" },
  },
  {
    address: "So11111111111111111111111111111111111111112",
    chainId: 101,
    decimals: 9,
    name: "Wrapped SOL",
    symbol: "SOL",
    logoURI:
      "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png",
    tags: ["old-registry"],
    extensions: { coingeckoId: "wrapped-solana" },
  },
];

export const UBER_MM_PROGRAM_ID = new PublicKey(
  "Exz7z8HpBjS7trD6ZbdWABdQyhK5ZvGkuV4UYoUiSTQQ"
);
export const PHOENIX_PROGRAM_ID = new PublicKey(
  "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY"
);

export const tokenConfig: Map<string, TokenConfig> = new Map([
  [
    "USDC",
    {
      name: "USD Coin",
      symbol: "USDC",
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      logoUri:
        "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png",
    },
  ],
  [
    "SOL",
    {
      name: "Wrapped SOL",
      symbol: "SOL",
      mint: "So11111111111111111111111111111111111111112",
      logoUri:
        "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png",
    },
  ],
]);

export interface Wallet {
  signTransaction(tx: Transaction): Promise<Transaction>;
  signAllTransactions(txs: Transaction[]): Promise<Transaction[]>;
  publicKey: PublicKey;
}
