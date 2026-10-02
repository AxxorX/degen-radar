// @ts-nocheck

const DEX_API = "https://api.dexscreener.com";

const CONFIG = {
  MIN_LIQUIDITY: 5000,
  MIN_VOLUME_5M: 1000,
  MIN_TXNS_5M: 8,
  MIN_BUYS_5M: 3,

  MIN_BUY_RATIO: 0.30,
  MAX_SELL_RATIO: 0.70,

  MIN_LIQUIDITY_TO_VOLUME: 0.05,

  MAX_AGE_HOURS: 48,
  MIN_PRICE_USD: 0.000000001,

  MAX_CANDIDATES: 30
};


export default {

  async fetch(request, env, ctx) {

    const url = new URL(request.url);

    try {

      // ================================
      // HEALTH CHECK
      // ================================

      if (url.pathname === "/") {

        return response({
          ok: true,
          bot: "Degen Radar",
          status: "online",
          version: "2.1.0"
        });

      }


      // ================================
      // TELEGRAM TEST
      // ================================

      if (url.pathname === "/test") {

        return await telegramTest(env);

      }


      // ================================
      // MANUAL SCAN
      // ================================

      if (url.pathname === "/scan") {

        const result = await scan(env);

        return response(result);

      }


      return response({
        ok: false,
        error: "Not Found"
      }, 404);


    } catch (error) {

      return response({
        ok: false,
        error: error?.message || String(error)
      }, 500);

    }
  },


  // ================================
  // CRON
  // ================================

  async scheduled(event, env, ctx) {

    ctx.waitUntil(

      scan(env).catch(error => {

        console.log(
          "Cron error:",
          error?.message || error
        );

      })

    );

  }

};


// ==========================================
// MAIN SCANNER
// ==========================================

async function scan(env) {

  const profiles = await getLatestProfiles();


  const candidates = profiles
    .filter(item => {

      if (!item?.tokenAddress) {
        return false;
      }


      const chain =
        String(item.chainId || "")
          .toLowerCase();


      return (
        chain === "solana" ||
        chain === "robinhood" ||
        chain === "arc"
      );

    })
    .slice(0, CONFIG.MAX_CANDIDATES);


  let checked = 0;
  let passed = 0;
  let sent = 0;


  const seen = new Set();


  for (const token of candidates) {

    const address =
      token.tokenAddress;


    const chain =
      String(token.chainId)
        .toLowerCase();


    const key =
      `${chain}:${address}`;


    if (seen.has(key)) {
      continue;
    }


    seen.add(key);

    checked++;


    try {

      const pairs =
        await getPairs(
          chain,
          address
        );


      const pair =
        selectBestPair(pairs);


      if (!pair) {
        continue;
      }


      if (!passesFilters(pair)) {
        continue;
      }


      passed++;


      // =================================
      // TELEGRAM MESSAGE
      // =================================

      const message =
        `CA: <code>${escapeHtml(address)}</code>\n\n` +
        `Chain: ${escapeHtml(chainName(chain))}`;


      await sendTelegram(
        env,
        message
      );


      sent++;


    } catch (error) {

      console.log(
        "Token error:",
        address,
        error?.message || error
      );

    }

  }


  return {

    ok: true,

    version: "2.1.0",

    discovered: profiles.length,

    candidates: candidates.length,

    checked,

    passed,

    sent

  };

}


// ==========================================
// DEXSCREENER
// ==========================================

async function getLatestProfiles() {

  const res = await fetch(
    `${DEX_API}/token-profiles/latest/v1`
  );


  if (!res.ok) {

    throw new Error(
      `DexScreener HTTP ${res.status}`
    );

  }


  const data =
    await res.json();


  return Array.isArray(data)
    ? data
    : [];

}


async function getPairs(
  chain,
  address
) {

  const url =
    `${DEX_API}/tokens/v1/` +
    `${encodeURIComponent(chain)}/` +
    `${encodeURIComponent(address)}`;


  const res =
    await fetch(url);


  if (!res.ok) {

    throw new Error(
      `Token data HTTP ${res.status}`
    );

  }


  const data =
    await res.json();


  return Array.isArray(data)
    ? data
    : [];

}


function selectBestPair(pairs) {

  if (!pairs.length) {
    return null;
  }


  return [...pairs]

    .filter(
      pair =>
        Number(
          pair?.liquidity?.usd || 0
        ) > 0
    )

    .sort(

      (a, b) =>

        Number(
          b?.liquidity?.usd || 0
        )

        -

        Number(
          a?.liquidity?.usd || 0
        )

    )[0] || null;

}


// ==========================================
// FILTER ENGINE
// ==========================================

function passesFilters(pair) {

  const liquidity =
    Number(
      pair?.liquidity?.usd || 0
    );


  const volume5m =
    Number(
      pair?.volume?.m5 || 0
    );


  const buys5m =
    Number(
      pair?.txns?.m5?.buys || 0
    );


  const sells5m =
    Number(
      pair?.txns?.m5?.sells || 0
    );


  const txns5m =
    buys5m + sells5m;


  const price =
    Number(
      pair?.priceUsd || 0
    );


  const created =
    Number(
      pair?.pairCreatedAt || 0
    );


  // =================================
  // LIQUIDITY
  // =================================

  if (
    liquidity <
    CONFIG.MIN_LIQUIDITY
  ) {

    return false;

  }


  // =================================
  // VOLUME
  // =================================

  if (
    volume5m <
    CONFIG.MIN_VOLUME_5M
  ) {

    return false;

  }


  // =================================
  // TRANSACTIONS
  // =================================

  if (
    txns5m <
    CONFIG.MIN_TXNS_5M
  ) {

    return false;

  }


  // =================================
  // BUYERS
  // =================================

  if (
    buys5m <
    CONFIG.MIN_BUYS_5M
  ) {

    return false;

  }


  // =================================
  // BUY / SELL BALANCE
  // =================================

  const buyRatio =
    buys5m /
    Math.max(txns5m, 1);


  const sellRatio =
    sells5m /
    Math.max(txns5m, 1);


  if (
    buyRatio <
    CONFIG.MIN_BUY_RATIO
  ) {

    return false;

  }


  if (
    sellRatio >
    CONFIG.MAX_SELL_RATIO
  ) {

    return false;

  }


  // =================================
  // LIQUIDITY / VOLUME SANITY
  // =================================

  const liquidityVolumeRatio =
    liquidity /
    Math.max(volume5m, 1);


  if (
    liquidityVolumeRatio <
    CONFIG.MIN_LIQUIDITY_TO_VOLUME
  ) {

    return false;

  }


  // =================================
  // PRICE SANITY
  // =================================

  if (
    !Number.isFinite(price) ||
    price <
    CONFIG.MIN_PRICE_USD
  ) {

    return false;

  }


  // =================================
  // TOKEN AGE
  // =================================

  if (created > 0) {

    const ageHours =
      (
        Date.now() - created
      ) / 3600000;


    if (
      ageHours < 0 ||
      ageHours >
      CONFIG.MAX_AGE_HOURS
    ) {

      return false;

    }

  }


  // =================================
  // EXTREME SELL PRESSURE
  // =================================

  if (
    buys5m > 0 &&
    sells5m / buys5m > 4
  ) {

    return false;

  }


  // =================================
  // PAIR DATA
  // =================================

  if (
    !pair?.baseToken?.address ||
    !pair?.quoteToken?.address
  ) {

    return false;

  }


  return true;

}


// ==========================================
// TELEGRAM TEST
// ==========================================

async function telegramTest(env) {

  if (!env.TELEGRAM_BOT_TOKEN) {

    return response({

      ok: false,

      error:
        "TELEGRAM_BOT_TOKEN secret missing"

    }, 500);

  }


  if (!env.TELEGRAM_CHAT_ID) {

    return response({

      ok: false,

      error:
        "TELEGRAM_CHAT_ID secret missing"

    }, 500);

  }


  await sendTelegram(
    env,
    "🦍 Degen Radar V2.1 online"
  );


  return response({

    ok: true,

    telegram: true,

    messageSent: true

  });

}


// ==========================================
// TELEGRAM
// ==========================================

async function sendTelegram(
  env,
  text
) {

  const url =
    `https://api.telegram.org/bot` +
    `${env.TELEGRAM_BOT_TOKEN}` +
    `/sendMessage`;


  const res =
    await fetch(url, {

      method: "POST",

      headers: {

        "Content-Type":
          "application/json"

      },

      body: JSON.stringify({

        chat_id:
          env.TELEGRAM_CHAT_ID,

        text,

        parse_mode:
          "HTML"

      })

    });


  const data =
    await res.json();


  if (
    !res.ok ||
    !data.ok
  ) {

    throw new Error(

      data?.description ||
      "Telegram API error"

    );

  }


  return data;

}


// ==========================================
// HTML ESCAPE
// ==========================================

function escapeHtml(text) {

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
    );

}


// ==========================================
// CHAIN NAME
// ==========================================

function chainName(chain) {

  if (
    chain === "solana"
  ) {

    return "Solana";

  }


  if (
    chain === "robinhood"
  ) {

    return "Robinhood Chain";

  }


  if (
    chain === "arc"
  ) {

    return "Arc";

  }


  return chain;

}


// ==========================================
// RESPONSE
// ==========================================

function response(
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

        "Content-Type":
          "application/json",

        "Cache-Control":
          "no-store"

      }

    }

  );

}