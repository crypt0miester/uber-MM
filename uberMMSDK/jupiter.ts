// @ts-nocheck
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fetch from "isomorphic-fetch";
import JSBI from "jsbi";
import { Jupiter, RouteInfo, TOKEN_LIST_URL } from "@jup-ag/core";
import Decimal from "decimal.js";
import { KNOWN_TOKENS, Token } from "./consts";
import { UberMmSDK } from "./uberMmSDK";

export const getRoutes = async ({
  jupiter,
  inputToken,
  outputToken,
  inputAmount,
  slippageBps,
}: {
  jupiter: Jupiter;
  inputToken?: Token;
  outputToken?: Token;
  inputAmount: number;
  slippageBps: number;
}) => {
  try {
    if (!inputToken || !outputToken) {
      return null;
    }

    console.log(
      `Getting routes for ${inputAmount} ${inputToken.symbol} -> ${outputToken.symbol}...`
    );
    const inputAmountInSmallestUnits = inputToken
      ? Math.round(inputAmount * 10 ** inputToken.decimals)
      : 0;

    const routes =
      inputToken && outputToken
        ? await jupiter.computeRoutes({
            inputMint: new PublicKey(inputToken.address),
            outputMint: new PublicKey(outputToken.address),
            amount: JSBI.BigInt(inputAmountInSmallestUnits), // raw input amount of tokens
            slippageBps,
            forceFetch: false,
          })
        : null;
    // console.log(routes)
    if (routes && routes.routesInfos) {
      // console.log("Possible number of routes:", routes.routesInfos.length);
      // console.log(
      //   "Best quote: ",
      //   new Decimal(routes.routesInfos[0].outAmount.toString())
      //     .div(10 ** outputToken.decimals)
      //     .toString(),
      //   `(${outputToken.symbol})`
      // );
      // console.log(routes.routesInfos[0])
      return routes;
    } else {
      return null;
    }
  } catch (error) {
    throw error;
  }
};

export const executeSwap = async ({
  jupiter,
  routes,
  expectedHigherThan,
  uberMM,
}: {
  jupiter: Jupiter;
  routes: {
    routesInfos: RouteInfo[];
    cached: boolean;
  };
  expectedHigherThan: number;
  uberMM: UberMmSDK;
}) => {
  try {
    // sanitize to make sure that we get a good amount:
    let jupiterOutAmount = routes!.routesInfos[0].outAmount[0];
    console.log("jupiterOutAmount", jupiterOutAmount);
    if (expectedHigherThan > jupiterOutAmount) {
      console.log("phoenix yields higher out. running phoenix instead. by:");
      console.log(expectedHigherThan - jupiterOutAmount);
      return false;
    }

    // Prepare execute exchange
    const { execute } = await jupiter.exchange({
      routeInfo: routes!.routesInfos[0],
    });

    const swapResult: any = await execute(); // Force any to ignore TS misidentifying SwapResult type

    if (swapResult.error) {
      console.log(swapResult.error);
      // retry on failure
      // this particular route will always fail so we try another one.
      const routes = await getRoutes({
        jupiter,
        inputToken,
        outputToken,
        inputAmount: amount, // 1 unit in UI
        slippageBps: 100, // 1% slippage
      });
      // reload phoenix Higher than
      expectedHigherThan = await uberMM.getPhoenixOutAmountLamports();
      await executeSwap({ jupiter, routes, expectedHigherThan });
    } else {
      console.log(`https://solscan.io/tx/${swapResult.txid}`);

      console.log(
        `inputAmount=${swapResult.inputAmount} outputAmount=${swapResult.outputAmount}`
      );
    }
    return true;
  } catch (error) {
    throw error;
  }
};
export const getJupiterClient = async (
  connection: Connection,
  user: Keypair
) => {
  //  Load Jupiter
  const jupiter = await Jupiter.load({
    connection,
    cluster: "mainnet-beta",
    user,
    wrapUnwrapSOL: false,
    ammsToExclude: {
      Mercurial: true,
      Meteora: true,
      Marinade: true,
      "Saber (Decimals)": true,
      // Saber: true,
      "Lifinity V2": true,
      Lifinity: true,
      Invariant: true,
      "Raydium CLMM": true,
      Raydium: true,
    },
  });
  return jupiter;
};

export const getUnknownTokenData = async (
  inputMint: PublicKey,
  outputMint: PublicKey
) => {
  const tokens: Token[] = await (
    await fetch(TOKEN_LIST_URL["mainnet-beta"])
  ).json(); // Fetch token list from Jupiter API

  const inputToken = tokens.find((t) => t.address == inputMint.toString());
  const outputToken = tokens.find((t) => t.address == outputMint.toString());
  // console.log(inputToken)
  // console.log(outputToken)

  return [inputToken, outputToken];

  //  Get routeMap, which maps each tokenMint and their respective tokenMints that are swappable
  // const routeMap = jupiter.getRouteMap();

  // // Alternatively, find all possible outputToken based on your inputToken
  // const possiblePairsTokenInfo = await getPossiblePairsTokenInfo({
  //   tokens,
  //   routeMap,
  //   inputToken,
  // });
};
export const rebalanceJupOk = async ({
  connection,
  user,
  inputMint,
  outputMint,
  amount,
  expectedHigherThan,
  uberMM,
  onlyPrint = true,
}: {
  connection: Connection;
  user: Keypair;
  inputMint: PublicKey;
  outputMint: PublicKey;
  amount: number;
  expectedHigherThan: number;
  uberMM: UberMmSDK;
}) => {
  try {
    const inputToken = KNOWN_TOKENS.find(
      (t) => t.address == inputMint.toString()
    );
    const outputToken = KNOWN_TOKENS.find(
      (t) => t.address == outputMint.toString()
    );
    if (!inputToken || !outputToken) {
      [inputToken, outputToken] = await getUnknownTokenData(
        inputMint,
        outputMint
      );
    }
    const jupiter = await getJupiterClient(connection, user);
    const routes = await getRoutes({
      jupiter,
      inputToken,
      outputToken,
      inputAmount: amount, // 1 unit in UI
      slippageBps: 100, // 1% slippage
    });
    console.log(
      "routeInfoAMM",
      routes!.routesInfos[0].marketInfos[0].amm.label
    );
    if (uberMM.balanceCheck) {
      let jupiterOutAmount = routes!.routesInfos[0].outAmount[0];
      // console.log("routeInfo", routes!.routesInfos[0]);
      console.log("routeOutAmount", jupiterOutAmount);
      if (expectedHigherThan > jupiterOutAmount) {
        console.log("phoenix yields higher out. running phoenix instead. by:");
        console.log(expectedHigherThan - jupiterOutAmount);
        return false;
      }
      return true;
    } else {
      // // Routes are sorted based on outputAmount, so ideally the first route is the best.
      return await executeSwap({
        jupiter,
        routes,
        expectedHigherThan,
        uberMM,
      });
    }
    // console.log('ok')
  } catch (error) {
    console.log({ error });
  }
};

// export const getPossiblePairsTokenInfo = ({
//   tokens,
//   routeMap,
//   inputToken,
// }: {
//   tokens: Token[];
//   routeMap: Map<string, string[]>;
//   inputToken?: Token;
// }) => {
//   try {
//     if (!inputToken) {
//       return {};
//     }

//     const possiblePairs = inputToken
//       ? routeMap.get(inputToken.address) || []
//       : []; // return an array of token mints that can be swapped with SOL
//     const possiblePairsTokenInfo: { [key: string]: Token | undefined } = {};
//     possiblePairs.forEach((address) => {
//       possiblePairsTokenInfo[address] = tokens.find((t) => {
//         return t.address == address;
//       });
//     });
//     // Perform your conditionals here to use other outputToken
//     // const alternativeOutputToken = possiblePairsTokenInfo[USDT_MINT_ADDRESS]
//     return possiblePairsTokenInfo;
//   } catch (error) {
//     throw error;
//   }
// };
