// @ts-nocheck

const DEX_API = "https://api.dexscreener.com";

const SOLANA_RPCS = [
  "https://rpc.magicblock.app/mainnet",
  "https://solana-rpc.publicnode.com",
  "https://api.mainnet.solana.com",
  "https://solana.leorpc.com/?api_key=FREE",
];

const ROBINHOOD_RPCS = [
  "https://robinhood-rpc.publicnode.com",
  "https://robinhood.drpc.org",
  "https://rpc.bloxroute.com/robinhood",
  "https://rpc.mainnet.chain.robinhood.com/",
];

const CHAINS = {
  solana: {
    name: "Solana",
    kind: "solana",
    rpc: "https://rpc.magicblock.app/mainnet",
},

  robinhood: {
    name: "Robinhood Chain",
    kind: "evm",
    chainId: 4663,
    rpc: "https://rpc.mainnet.chain.robinhood.com/",
  },

  arc: {
    name: "Arc",
    kind: "evm",
    chainId: 5042,
    rpc: "https://rpc.mainnet.arc.io",
  },
};

const CONFIG = {
  MIN_LIQUIDITY: 5000,
  MIN_VOLUME_5M: 1000,
  MIN_TXNS_5M: 8,
  MIN_BUYS_5M: 3,

  MIN_BUY_RATIO: 0.30,
  MAX_SELL_RATIO: 0.70,

  MAX_AGE_HOURS: 48,
  MIN_PRICE_USD: 0.000000001,

  MAX_CANDIDATES_PER_CHAIN: 20,

  DEEP_MAX_PER_SCAN: 3,

  MAX_TOP3_HOLDER_PERCENT: 75,
  MAX_TOP10_HOLDER_PERCENT: 90,

  MAX_LIQUIDITY_DROP_PERCENT: 55,

    DEDUPE_SECONDS: 7 * 24 * 60 * 60,
  LOCK_SECONDS: 90,

  ROBINHOOD_RPC_DELAY_MS: 700,
  ROBINHOOD_RPC_RETRIES: 3,
};

const SOLANA_TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return json({
        ok: true,
        bot: "Degen Radar",
        status: "online",
        version: "5.0.0",
        autoScan: "every minute",
        chains: Object.keys(CHAINS),
      });
    }

    if (url.pathname === "/health") {
      return await health();
    }

    if (url.pathname === "/test") {
      return await testTelegram(env);
    }

    if (url.pathname === "/scan") {
      return json(await scan(env));
    }

    return json(
      {
        ok: false,
        error: "Not found",
      },
      404
    );
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      scan(env).catch((error) => {
        console.error(
          "Scheduled scan failed:",
          error
        );
      })
    );
  },
};


/* =========================================================
   MAIN SCANNER
========================================================= */

async function scan(env) {
  const lock = await acquireLock();

  if (!lock) {
    return {
      ok: true,
      skipped: true,
      reason: "another scan is running",
    };
  }

  const started = Date.now();

  try {
    const discovered =
      await discoverTokens();

    const candidates = [];

    for (
      const chain of Object.keys(
        CHAINS
      )
    ) {
      const addresses =
        discovered
          .filter(
            (x) =>
              x.chain === chain
          )
          .map(
            (x) => x.address
          )
          .slice(
            0,
            CONFIG.MAX_CANDIDATES_PER_CHAIN
          );

      if (!addresses.length) {
        continue;
      }

      const market =
        await getMarketData(
          chain,
          addresses
        );

      for (
        const token of market
      ) {
        if (
          passesMarketFilters(
            token
          )
        ) {
          candidates.push(
            token
          );
        }
      }
    }

    candidates.sort(
      (a, b) => {
        const liquidity =
          Number(
            b.liquidityUsd
          ) -
          Number(
            a.liquidityUsd
          );

        if (
          liquidity !== 0
        ) {
          return liquidity;
        }

        return (
          Number(
            b.volume5m
          ) -
          Number(
            a.volume5m
          )
        );
      }
    );

    const deepTargets =
      candidates.slice(
        0,
        CONFIG.DEEP_MAX_PER_SCAN
      );

    let deepPassed = 0;
    let sent = 0;

    const errors = [];

    for (
      const token of deepTargets
    ) {
      try {
        let passed;

        if (
          token.chain ===
          "solana"
        ) {
          passed =
            await deepCheckSolana(
              token
            );
        } else {
          passed =
            await deepCheckEvm(
              token
            );
        }

        if (!passed) {
          continue;
        }

        deepPassed++;

        const stable =
          await checkLiquidityStability(
            token
          );

        if (!stable) {
          continue;
        }

        if (
          await wasRecentlySent(
            token.chain,
            token.address
          )
        ) {
          continue;
        }

        await sendTelegramCandidate(
          env,
          token
        );

        await markSent(
          token.chain,
          token.address
        );

        sent++;
      } catch (error) {
        const message =
          String(
            error?.message ||
              error
          );

        errors.push({
          chain:
            token.chain,

          address:
            token.address,

          error:
            message,
        });

        console.error(
          "Deep check failed:",
          token.chain,
          token.address,
          error
        );
      }
    }

    return {
      ok: true,
      version: "5.0.0",

      discovered:
        discovered.length,

      candidates:
        candidates.length,

      deepChecked:
        deepTargets.length,

      deepPassed,
      sent,
      errors,

      durationMs:
        Date.now() -
        started,
    };
  } finally {
    // Lock expires automatically.
  }
}


/* =========================================================
   DISCOVERY
========================================================= */

async function discoverTokens() {
  const endpoints = [
    "/token-profiles/latest/v1",
    "/token-boosts/latest/v1",
    "/community-takeovers/latest/v1",
  ];

  const results =
    await Promise.all(
      endpoints.map(
        (path) =>
          fetchJson(
            `${DEX_API}${path}`
          ).catch(
            (error) => {
              console.error(
                "Discovery failed:",
                path,
                error
              );

              return [];
            }
          )
      )
    );

  const seen =
    new Set();

  const output = [];

  for (
    const list of results
  ) {
    if (
      !Array.isArray(list)
    ) {
      continue;
    }

    for (
      const item of list
    ) {
      const chain =
        normalizeChain(
          item?.chainId
        );

      const address =
        item?.tokenAddress;

      if (
        !chain ||
        !address
      ) {
        continue;
      }

      const key =
        `${chain}:${String(
          address
        ).toLowerCase()}`;

      if (
        seen.has(key)
      ) {
        continue;
      }

      seen.add(key);

      output.push({
        chain,
        address:
          String(address),
      });
    }
  }

  return output;
}


function normalizeChain(
  chainId
) {
  const id =
    String(
      chainId || ""
    ).toLowerCase();

  return Object.prototype.hasOwnProperty.call(
    CHAINS,
    id
  )
    ? id
    : null;
}


/* =========================================================
   MARKET DATA
========================================================= */

async function getMarketData(
  chain,
  addresses
) {
  const output = [];

  const batches =
    chunk(
      addresses,
      30
    );

  for (
    const batch of batches
  ) {
    const url =
      `${DEX_API}/tokens/v1/` +
      `${encodeURIComponent(
        chain
      )}/` +
      `${batch.join(",")}`;

    try {
      const data =
        await fetchJson(
          url
        );

      if (
        !Array.isArray(data)
      ) {
        continue;
      }

      for (
        const pair of data
      ) {
        if (
          !pair?.baseToken
            ?.address
        ) {
          continue;
        }

        output.push(
          normalizePair(
            pair,
            chain
          )
        );
      }
    } catch (error) {
      console.error(
        "Market data failed:",
        chain,
        error
      );
    }
  }

  const best =
    new Map();

  for (
    const token of output
  ) {
    const key =
      `${token.chain}:` +
      `${token.address.toLowerCase()}`;

    const old =
      best.get(key);

    if (
      !old ||
      token.liquidityUsd >
        old.liquidityUsd
    ) {
      best.set(
        key,
        token
      );
    }
  }

  return [
    ...best.values(),
  ];
}


function normalizePair(
  pair,
  chain
) {
  const txns =
    pair.txns?.m5 || {};

  const buys =
    Number(
      txns.buys || 0
    );

  const sells =
    Number(
      txns.sells || 0
    );

  const total =
    buys + sells;

  const liquidityUsd =
    Number(
      pair.liquidity?.usd ||
        0
    );

  const volume5m =
    Number(
      pair.volume?.m5 ||
        0
    );

  const priceUsd =
    Number(
      pair.priceUsd ||
        0
    );

  const created =
    Number(
      pair.pairCreatedAt ||
        0
    );

  return {
    chain,

    address:
      String(
        pair.baseToken.address
      ),

    symbol:
      String(
        pair.baseToken.symbol ||
          ""
      ),

    name:
      String(
        pair.baseToken.name ||
          ""
      ),

    pairAddress:
      String(
        pair.pairAddress ||
          ""
      ),

    dexId:
      String(
        pair.dexId || ""
      ),

    priceUsd,
    liquidityUsd,
    volume5m,

    buys5m:
      buys,

    sells5m:
      sells,

    txns5m:
      total,

    buyRatio:
      total
        ? buys / total
        : 0,

    sellRatio:
      total
        ? sells / total
        : 1,

    ageHours:
      created
        ? (
            Date.now() -
            created
          ) /
          3600000
        : Infinity,

    pairCreatedAt:
      created,

    fdv:
      Number(
        pair.fdv || 0
      ),

    marketCap:
      Number(
        pair.marketCap || 0
      ),

    url:
      String(
        pair.url || ""
      ),
  };
}


/* =========================================================
   MARKET FILTERS
========================================================= */

function passesMarketFilters(
  token
) {
  if (
    !token.address ||
    !token.pairAddress
  ) {
    return false;
  }

  if (
    token.liquidityUsd <
    CONFIG.MIN_LIQUIDITY
  ) {
    return false;
  }

  if (
    token.volume5m <
    CONFIG.MIN_VOLUME_5M
  ) {
    return false;
  }

  if (
    token.txns5m <
    CONFIG.MIN_TXNS_5M
  ) {
    return false;
  }

  if (
    token.buys5m <
    CONFIG.MIN_BUYS_5M
  ) {
    return false;
  }

  if (
    token.buyRatio <
    CONFIG.MIN_BUY_RATIO
  ) {
    return false;
  }

  if (
    token.sellRatio >
    CONFIG.MAX_SELL_RATIO
  ) {
    return false;
  }

  if (
    token.priceUsd <
    CONFIG.MIN_PRICE_USD
  ) {
    return false;
  }

  if (
    token.ageHours >
    CONFIG.MAX_AGE_HOURS
  ) {
    return false;
  }

  return true;
}


/* =========================================================
   SOLANA DEEP CHECK
========================================================= */

async function deepCheckSolana(
  token
) {
  const mint =
    token.address;

  const account =
    await solanaRpc(
      "getAccountInfo",
      [
        mint,
        {
          encoding:
            "jsonParsed",

          commitment:
            "confirmed",
        },
      ]
    );

  if (
    !account?.value
  ) {
    return false;
  }

  const owner =
    String(
      account.value.owner ||
        ""
    );

  if (
    !SOLANA_TOKEN_PROGRAMS.has(
      owner
    )
  ) {
    return false;
  }

  const parsed =
    account.value
      ?.data
      ?.parsed;

  if (
    !parsed ||
    parsed.type !==
      "mint"
  ) {
    return false;
  }

  const info =
    parsed.info || {};

  // Mint authority must be revoked.
  if (
    info.mintAuthority
  ) {
    return false;
  }

  // Freeze authority must be revoked.
  if (
    info.freezeAuthority
  ) {
    return false;
  }

  /*
    Reject several Token-2022
    extensions that can add
    unusual control over transfers.
  */

  const extensions =
    Array.isArray(
      info.extensions
    )
      ? info.extensions
      : [];

  const risky =
    new Set([
      "permanentDelegate",
      "transferHook",
      "confidentialTransferMint",
    ]);

  for (
    const extension of extensions
  ) {
    if (
      risky.has(
        extension?.extension
      )
    ) {
      return false;
    }
  }

  /*
    Supply
  */

  const supplyResult =
    await solanaRpc(
      "getTokenSupply",
      [
        mint,
        {
          commitment:
            "confirmed",
        },
      ]
    );

  let supply;

  try {
    supply =
      BigInt(
        String(
          supplyResult
            ?.value
            ?.amount ||
            "0"
        )
      );
  } catch {
    return false;
  }

  if (
    supply <= 0n
  ) {
    return false;
  }

  /*
    Largest token accounts
  */

  const largest =
    await solanaRpc(
      "getTokenLargestAccounts",
      [
        mint,
        {
          commitment:
            "confirmed",
        },
      ]
    );

  const accounts =
    Array.isArray(
      largest?.value
    )
      ? largest.value
      : [];

  if (
    !accounts.length
  ) {
    return false;
  }

  let top3 = 0;
  let top10 = 0;

  for (
    let i = 0;
    i <
    Math.min(
      accounts.length,
      10
    );
    i++
  ) {
    let amount;

    try {
      amount =
        BigInt(
          String(
            accounts[i]
              ?.amount ||
              "0"
          )
        );
    } catch {
      continue;
    }

    const percent =
      Number(
        (
          amount *
          1000000n
        ) /
          supply
      ) /
      10000;

    if (
      i < 3
    ) {
      top3 += percent;
    }

    top10 += percent;
  }

  if (
    top3 >
    CONFIG.MAX_TOP3_HOLDER_PERCENT
  ) {
    return false;
  }

  if (
    top10 >
    CONFIG.MAX_TOP10_HOLDER_PERCENT
  ) {
    return false;
  }

  const decimals =
    Number(
      info.decimals
    );

  if (
    !Number.isInteger(
      decimals
    ) ||
    decimals < 0 ||
    decimals > 18
  ) {
    return false;
  }

  return true;
}


/* =========================================================
   EVM DEEP CHECK
   Robinhood + Arc
========================================================= */

async function deepCheckEvm(
  token
) {
  const config =
    CHAINS[
      token.chain
    ];

  if (
    !config?.rpc ||
    !config.chainId
  ) {
    return false;
  }

  const address =
    token.address;

  if (
    !/^0x[a-fA-F0-9]{40}$/.test(
      address
    )
  ) {
    return false;
  }

  /*
    Verify chain ID
  */

  const chainHex =
    await evmRpc(
      config.rpc,
      "eth_chainId",
      []
    );

  const chainId =
    hexToNumber(
      chainHex
    );

  if (
    chainId !==
    config.chainId
  ) {
    return false;
  }

  /*
    Verify contract
  */

  const code =
    await evmRpc(
      config.rpc,
      "eth_getCode",
      [
        address,
        "latest",
      ]
    );

  if (
    !code ||
    code === "0x"
  ) {
    return false;
  }

  /*
    totalSupply()
  */

  const supplyHex =
    await evmCall(
      config.rpc,
      address,
      "0x18160ddd"
    );

  const supply =
    hexToBigInt(
      supplyHex
    );

  if (
    supply === null ||
    supply <= 0n
  ) {
    return false;
  }

  /*
    decimals()
  */

  const decimalsHex =
    await evmCall(
      config.rpc,
      address,
      "0x313ce567"
    );

  const decimals =
    hexToNumber(
      decimalsHex
    );

  if (
    decimals === null ||
    decimals < 0 ||
    decimals > 36
  ) {
    return false;
  }

  /*
    symbol()
  */

  const symbolHex =
    await evmCall(
      config.rpc,
      address,
      "0x95d89b41"
    );

  const symbol =
    decodeAbiString(
      symbolHex
    );

  if (
    !symbol ||
    symbol.length > 32
  ) {
    return false;
  }

  /*
    Optional paused()
  */

  try {
    const paused =
      await evmCall(
        config.rpc,
        address,
        "0x5c975abb"
      );

    if (
      isTrueAbiBool(
        paused
      )
    ) {
      return false;
    }
  } catch {
    // Most ERC-20s don't have paused().
  }

  return true;
}


/* =========================================================
   LIQUIDITY STABILITY
========================================================= */

async function checkLiquidityStability(
  token
) {
  /*
    Cloudflare edge cache is used
    as a lightweight snapshot store.

    First observation passes.
  */

  const cache =
    caches.default;

  const key =
    new Request(
      `https://degen-radar.local/liquidity/` +
      `${token.chain}/` +
      `${encodeURIComponent(
        token.address.toLowerCase()
      )}`
    );

  let previous = null;

  const response =
    await cache.match(
      key
    );

  if (
    response
  ) {
    try {
      previous =
        await response.json();
    } catch {
      previous = null;
    }
  }

  const current = {
    liquidityUsd:
      token.liquidityUsd,

    timestamp:
      Date.now(),
  };

  await cache.put(
    key,
    new Response(
      JSON.stringify(
        current
      ),
      {
        headers: {
          "Cache-Control":
            "public, max-age=600",

          "content-type":
            "application/json",
        },
      }
    )
  );

  if (
    !previous ||
    Number(
      previous.liquidityUsd
    ) <= 0
  ) {
    return true;
  }

  const oldLiquidity =
    Number(
      previous.liquidityUsd
    );

  const drop =
    (
      (
        oldLiquidity -
        token.liquidityUsd
      ) /
      oldLiquidity
    ) *
    100;

  return (
    drop <
    CONFIG.MAX_LIQUIDITY_DROP_PERCENT
  );
}


/* =========================================================
   DEDUPE
========================================================= */

async function wasRecentlySent(
  chain,
  address
) {
  const response =
    await caches.default.match(
      cacheRequest(
        `sent/${chain}/` +
        `${address.toLowerCase()}`
      )
    );

  return !!response;
}


async function markSent(
  chain,
  address
) {
  const request =
    cacheRequest(
      `sent/${chain}/` +
      `${address.toLowerCase()}`
    );

  await caches.default.put(
    request,
    new Response(
      "1",
      {
        headers: {
          "Cache-Control":
            `public, max-age=${CONFIG.DEDUPE_SECONDS}`,
        },
      }
    )
  );
}


/* =========================================================
   SCAN LOCK
========================================================= */

async function acquireLock() {
  const request =
    cacheRequest(
      "lock/scan"
    );

  const existing =
    await caches.default.match(
      request
    );

  if (
    existing
  ) {
    return false;
  }

  await caches.default.put(
    request,
    new Response(
      "locked",
      {
        headers: {
          "Cache-Control":
            `public, max-age=${CONFIG.LOCK_SECONDS}`,
        },
      }
    )
  );

  return true;
}


function cacheRequest(
  path
) {
  return new Request(
    `https://degen-radar.local/${path}`
  );
}


/* =========================================================
   TELEGRAM
========================================================= */

async function testTelegram(
  env
) {
  try {
    await sendTelegram(
      env,
      "🦍 <b>Degen Radar</b> online"
    );

    return json({
      ok: true,
      telegram: true,
      messageSent: true,
    });
  } catch (error) {
    return json(
      {
        ok: false,
        telegram: false,
        error:
          String(
            error?.message ||
              error
          ),
      },
      500
    );
  }
}


async function sendTelegramCandidate(
  env,
  token
) {
  const address =
    escapeHtml(
      token.address
    );

  const chain =
    escapeHtml(
      CHAINS[
        token.chain
      ].name
    );

  const message =
    `CA: <code>${address}</code>\n\n\u200B\n` +
    `Chain: ${chain}`;

  await sendTelegram(
    env,
    message
  );
}


async function sendTelegram(
  env,
  text
) {
  if (
    !env.TELEGRAM_BOT_TOKEN
  ) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN secret missing"
    );
  }

  if (
    !env.TELEGRAM_CHAT_ID
  ) {
    throw new Error(
      "TELEGRAM_CHAT_ID secret missing"
    );
  }

  const url =
    `https://api.telegram.org/bot` +
    `${env.TELEGRAM_BOT_TOKEN}` +
    `/sendMessage`;

  const response =
    await fetch(
      url,
      {
        method: "POST",

        headers: {
          "content-type":
            "application/json",
        },

        body:
          JSON.stringify({
            chat_id:
              env.TELEGRAM_CHAT_ID,

            text,

            parse_mode:
              "HTML",

            disable_web_page_preview:
              true,
          }),
      }
    );

  const data =
    await response.json();

  if (
    !data.ok
  ) {
    throw new Error(
      data.description ||
        "Telegram API error"
    );
  }

  return data;
}


/* =========================================================
   HEALTH
========================================================= */

async function health() {
  const result = {};

  /*
    Solana
  */

  try {
    const value =
      await solanaRpc(
        "getEpochInfo",
        []
      );

    result.solana = {
      ok:
        !!value,

      rpc:
        CHAINS.solana.rpc,
    };
  } catch (error) {
    result.solana = {
      ok: false,

      error:
        String(
          error?.message ||
            error
        ),
    };
  }

  /*
    Robinhood + Arc
  */

  for (
    const chain of [
      "robinhood",
      "arc",
    ]
  ) {
    try {
      const config =
        CHAINS[chain];

      const chainHex =
        await evmRpc(
          config.rpc,
          "eth_chainId",
          []
        );

      const actual =
        hexToNumber(
          chainHex
        );

      result[chain] = {
        ok:
          actual ===
          config.chainId,

        expectedChainId:
          config.chainId,

        actualChainId:
          actual,

        rpc:
          config.rpc,
      };
    } catch (error) {
      result[chain] = {
        ok: false,

        error:
          String(
            error?.message ||
              error
          ),
      };
    }
  }

  const ok =
    Object.values(
      result
    ).every(
      (item) =>
        item.ok === true
    );

  return json(
    {
      ok,
      chains:
        result,
    },
    ok ? 200 : 503
  );
}


/* =========================================================
   RPC
========================================================= */

async function solanaRpc(
  method,
  params
) {
  let lastError = null;

  for (const rpc of SOLANA_RPCS) {
    try {
      return await jsonRpc(
        rpc,
        method,
        params
      );
    } catch (error) {
      lastError = error;

      console.error(
        "Solana RPC failed:",
        rpc,
        method,
        error
      );
    }
  }

  throw new Error(
    `All Solana RPCs failed for ${method}: ` +
    String(
      lastError?.message ||
      lastError ||
      "unknown error"
    )
  );
}


async function evmRpc(
  rpc,
  method,
  params
) {
  const isRobinhood =
    rpc.includes(
      "robinhood"
    );

  if (isRobinhood) {
    let lastError = null;

    for (
      const endpoint of ROBINHOOD_RPCS
    ) {
      try {
        return await jsonRpc(
          endpoint,
          method,
          params
        );
      } catch (error) {
        lastError = error;

        console.error(
          "Robinhood RPC failed:",
          endpoint,
          method,
          error
        );
      }
    }

    throw new Error(
      `All Robinhood RPCs failed for ${method}: ` +
      String(
        lastError?.message ||
        lastError ||
        "unknown error"
      )
    );
  }

  return await jsonRpc(
    rpc,
    method,
    params
  );
}


async function evmCall(
  rpc,
  to,
  data
) {
  return await evmRpc(
    rpc,
    "eth_call",
    [
      {
        to,
        data,
      },

      "latest",
    ]
  );
}


async function jsonRpc(
  url,
  method,
  params
) {
  const response =
    await fetch(
      url,
      {
        method: "POST",

        headers: {
          "content-type":
            "application/json",

          accept:
            "application/json",
        },

        body:
          JSON.stringify({
            jsonrpc:
              "2.0",

            id:
              Date.now(),

            method,
            params,
          }),
      }
    );

  if (
    !response.ok
  ) {
    throw new Error(
      `RPC HTTP ${response.status}`
    );
  }

  const data =
    await response.json();

  if (
    data.error
  ) {
    throw new Error(
      data.error.message ||
        `${method} RPC error`
    );
  }

  return data.result;
}


/* =========================================================
   HTTP
========================================================= */

async function fetchJson(
  url
) {
  const response =
    await fetch(
      url,
      {
        headers: {
          accept:
            "application/json",
        },
      }
    );

  if (
    !response.ok
  ) {
    throw new Error(
      `HTTP ${response.status}: ${url}`
    );
  }

  return await response.json();
}


/* =========================================================
   HELPERS
========================================================= */

function hexToBigInt(
  hex
) {
  if (
    typeof hex !==
      "string" ||
    !hex.startsWith(
      "0x"
    )
  ) {
    return null;
  }

  try {
    return BigInt(
      hex
    );
  } catch {
    return null;
  }
}


function hexToNumber(
  hex
) {
  const value =
    hexToBigInt(
      hex
    );

  if (
    value === null
  ) {
    return null;
  }

  const number =
    Number(
      value
    );

  return Number.isFinite(
    number
  )
    ? number
    : null;
}


function isTrueAbiBool(
  hex
) {
  const value =
    hexToBigInt(
      hex
    );

  return (
    value !== null &&
    value !== 0n
  );
}


function decodeAbiString(
  hex
) {
  if (
    !hex ||
    hex === "0x"
  ) {
    return "";
  }

  try {
    const clean =
      hex.slice(2);

    /*
      Dynamic ABI string:
      offset + length + bytes
    */

    if (
      clean.length >=
      128
    ) {
      const length =
        parseInt(
          clean.slice(
            64,
            128
          ),
          16
        );

      if (
        Number.isFinite(
          length
        ) &&
        length > 0 &&
        length < 1000
      ) {
        const data =
          clean.slice(
            128,
            128 +
              length * 2
          );

        return hexBytesToString(
          data
        );
      }
    }

    /*
      bytes32 fallback
    */

    return hexBytesToString(
      clean
    ).replace(
      /\0/g,
      ""
    );
  } catch {
    return "";
  }
}


function hexBytesToString(
  hex
) {
  let output = "";

  for (
    let i = 0;
    i + 1 < hex.length;
    i += 2
  ) {
    const code =
      parseInt(
        hex.slice(
          i,
          i + 2
        ),
        16
      );

    if (!code) {
      continue;
    }

    output +=
      String.fromCharCode(
        code
      );
  }

  return output;
}


function escapeHtml(
  text
) {
  return String(text)
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /"/g,
      "&quot;"
    );
}


function chunk(
  array,
  size
) {
  const result = [];

  for (
    let i = 0;
    i < array.length;
    i += size
  ) {
    result.push(
      array.slice(
        i,
        i + size
      )
    );
  }

  return result;
}


function json(
  data,
  status = 200
) {
  return new Response(
    JSON.stringify(
      data,
      null,
      2
    ),
    {
      status,

      headers: {
        "content-type":
          "application/json; charset=utf-8",
      },
    }
  );
}