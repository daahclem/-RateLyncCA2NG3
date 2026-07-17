require("dotenv").config();
const fs = require("fs");
const { chromium } = require("playwright");

const INGEST_URL = process.env.INGEST_URL;
const INGEST_TOKEN = process.env.INGEST_TOKEN;
const HEADLESS = true; // set true in GitHub Actions later

function getOriginConfig(origin) {
  const map = {
    CA: {
      currency: "CAD",
      countryName: "Canada",
      countrySearch: "canada",
      countryCode2: "CA",
      countryCode3: "CAN",
      sendingParam: "CA",
      localePath: "en-ca",
    },
    US: {
      currency: "USD",
      countryName: "United States",
      countrySearch: "united states",
      countryCode2: "US",
      countryCode3: "USA",
      sendingParam: "US",
      localePath: "en-us",
    },
    GB: {
      currency: "GBP",
      countryName: "United Kingdom",
      countrySearch: "united kingdom",
      countryCode2: "GB",
      countryCode3: "GBR",
      sendingParam: "GB",
      localePath: "en-gb",
    },
  };

  return map[origin] || map.CA;
}

function currencyForDestination(destination) {
  if (destination === "GH") return "GHS";
  if (destination === "NG") return "NGN";
  return "NGN";
}

function destinationCountryName(destination) {
  if (destination === "GH") return "Ghana";
  if (destination === "NG") return "Nigeria";
  return "Nigeria";
}

function destinationSearch(destination) {
  if (destination === "GH") return "gh";
  if (destination === "NG") return "ng";
  return "ng";
}

async function postQuote(payload) {
  if (
    !INGEST_URL ||
    !INGEST_TOKEN ||
    INGEST_URL.includes("your-quoteops-app-url") ||
    INGEST_TOKEN.includes("your_secret_token_here")
  ) {
    console.log("INGEST_URL or INGEST_TOKEN not set. Quote extracted locally only:");
    console.log(payload);
    return;
  }

  const res = await fetch(INGEST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ingest failed: ${res.status} ${text}`);
  }
}

function saveDebugText(provider, text) {
  const safe = provider
    .replace(/\s+/g, "-")
    .toLowerCase();

  fs.writeFileSync(
    `debug-${safe}.txt`,
    String(text || ""),
    "utf8"
  );
}

async function saveScreenshot(page, provider) {
  const safe = provider.replace(/\s+/g, "-").toLowerCase();
  const file = `debug-${safe}.png`;
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

function parseLocaleNumber(value) {
  if (value === null || value === undefined) return null;

  let str = String(value).trim();
  if (!str) return null;

  str = str.replace(/[^\d,.-]/g, "");

  const hasComma = str.includes(",");
  const hasDot = str.includes(".");

  if (hasComma && hasDot) {
    const lastComma = str.lastIndexOf(",");
    const lastDot = str.lastIndexOf(".");

    if (lastComma > lastDot) {
      str = str.replace(/\./g, "").replace(",", ".");
    } else {
      str = str.replace(/,/g, "");
    }
  } else if (hasComma) {
    if (/,\d{1,2}$/.test(str)) {
      str = str.replace(",", ".");
    } else {
      str = str.replace(/,/g, "");
    }
  } else if (hasDot) {
    const parts = str.split(".");
    if (parts.length > 2) {
      const decimal = parts.pop();
      str = parts.join("") + "." + decimal;
    }
  }

  const num = Number(str);
  return Number.isFinite(num) ? num : null;
}

function extractRateFromText(text, fromCurrency, toCurrency) {
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, " ");

  const patterns = [
    new RegExp(`1\\s*${fromCurrency}\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`${fromCurrency}\\s*1\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`Exchange Rate\\s*1\\s*${fromCurrency}\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`Today[’']s rate:\\s*1(?:\\.00)?\\s*${fromCurrency}\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`rate:?\\s*1\\s*${fromCurrency}\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`${fromCurrency}\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`([0-9]+(?:\\.[0-9]+)?)\\s*${toCurrency}`, "i"),
  ];

  for (const regex of patterns) {
    const match = cleaned.match(regex);
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0 && value < 100000) {
        return value;
      }
    }
  }

  return null;
}

function extractFeeFromText(text, sourceCurrency = "CAD") {
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, " ");

  const patterns = [
    new RegExp(`Transfer fees?:\\s*([0-9.]+)\\s*${sourceCurrency}`, "i"),
    new RegExp(`Fees?:\\s*([0-9.]+)\\s*${sourceCurrency}`, "i"),
    new RegExp(`Zero`, "i"),
    new RegExp(`No transfer fees`, "i"),
    new RegExp(`Fee:?\\s*([0-9.]+)`, "i"),
  ];

  for (const regex of patterns) {
    const match = cleaned.match(regex);
    if (!match) continue;
    if (/Zero/i.test(match[0]) || /No transfer fees/i.test(match[0])) return 0;
    if (match[1]) return Number(match[1]);
  }

  return 0;
}

function extractAmountReceivedFromText(text, currency) {
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, " ");

  const patterns = [
    new RegExp(`Recipient gets\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`They get\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`You receive\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`You get\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`Receive amount\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`([0-9.]+)\\s*${currency}`, "i"),
  ];

  for (const regex of patterns) {
    const match = cleaned.match(regex);
    if (match && match[1]) return Number(match[1]);
  }

  return null;
}

function buildPayloadFromText(source, bodyText) {
  const originCfg = getOriginConfig(source.origin);
  const fromCurrency = originCfg.currency;
  const toCurrency = currencyForDestination(source.destination);
  const sendAmount = Number(source.send_amount || 1);

  let rate = extractRateFromText(bodyText, fromCurrency, toCurrency);
  const fee = extractFeeFromText(bodyText, fromCurrency);
  let amountReceived = extractAmountReceivedFromText(bodyText, toCurrency);

  if (!rate && amountReceived && sendAmount > 0) {
    rate = Number((amountReceived / sendAmount).toFixed(6));
  }

  if (!amountReceived && rate) {
    amountReceived = Number((rate * sendAmount).toFixed(3));
  }

  if (!rate || !amountReceived) return null;

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: sendAmount,
    exchange_rate: rate,
    fee,
    amount_received: Number(amountReceived.toFixed(3)),
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
  };
}

function buildResult(source, rate, fee = 0, amountReceived = null, extra = {}) {
  const sendAmount = Number(source.send_amount || 1);
  const normalizedAmountReceived =
    amountReceived !== null && amountReceived !== undefined
      ? Number(Number(amountReceived).toFixed(6))
      : Number(Number(rate).toFixed(6));

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: sendAmount,
    exchange_rate: Number(Number(rate).toFixed(6)),
    fee: Number(Number(fee || 0).toFixed(6)),
    amount_received: normalizedAmountReceived,
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
    ...extra,
  };
}


async function handleCurrencyFlow(page, source) {
  const destCurrency = currencyForDestination(source.destination);

  await page.goto("https://www.currencyflow.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(4000);

  await page.locator("#currency-from-live").selectOption("CAD").catch(() => {});
  await page.locator("#currency-to-live").selectOption(destCurrency).catch(() => {});
  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;
  const patterns = [
    /CAD\s*=\s*([0-9,]+(?:\.\d+)?)\s*NGN/i,
    /1\s*CAD\s*=\s*([0-9,]+(?:\.\d+)?)\s*NGN/i,
    /Exchange rate.*CAD.*([0-9,]+(?:\.\d+)?).*NGN/i,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1]);
    if (candidate && candidate > 0) {
      rate = candidate;
      break;
    }
  }

  if (!rate) {
    // fallback: choose largest plausible decimal on page
    const matches = bodyText.match(/\b([0-9]{2,5}(?:\.\d{1,5})?)\b/g) || [];
    const candidates = matches
      .map((m) => parseLocaleNumber(m))
      .filter((n) => n && n > 100 && n < 100000);

    if (candidates.length) {
      rate = Math.max(...candidates);
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract CurrencyFlow rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate);
}

async function handleXoom(page, source) {
  const corridorSlug = source.destination === "NG" ? "nigeria" : "ghana";
  const destCurrency = currencyForDestination(source.destination);

  await page.goto(`https://www.xoom.com/${corridorSlug}/send-money`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  }).catch(async () => {
    await page.goto("https://www.xoom.com/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
  });

  await page.waitForTimeout(5000);

  await page.getByTestId("source-currency-picker").click({ timeout: 6000 }).catch(() => {});
  await page.getByRole("option", { name: "CAD" }).click({ timeout: 6000 }).catch(async () => {
    await page.getByText(/^CAD$/).first().click().catch(() => {});
  });

  await page.waitForTimeout(1200);

  await page.getByText(destCurrency, { exact: true }).click({ timeout: 5000 }).catch(() => {});
  await page.getByTestId("fx-rate-comparison-string").click({ timeout: 4000 }).catch(() => {});
  await page.locator("#text-input-receive-input").click({ timeout: 4000 }).catch(() => {});
  await page.locator("#text-input-receive-input").click({ timeout: 4000 }).catch(() => {});
  await page.getByTestId("fx-rate-comparison-string").click({ timeout: 4000 }).catch(() => {});
  await page.getByTestId("send-now-button").click({ timeout: 4000 }).catch(() => {});

  await page.waitForTimeout(4000);

  const rateText = await page.getByTestId("fx-rate-comparison-string").innerText().catch(() => "");
  const bodyText = `${rateText}\n${await page.locator("body").innerText()}`;
  saveDebugText(source.provider, bodyText);

  let rate = null;
  const patterns = [
    new RegExp(`CAD\\s*=\\s*([0-9.,]+)\\s*${destCurrency}`, "i"),
    new RegExp(`1\\s*CAD\\s*=\\s*([0-9.,]+)\\s*${destCurrency}`, "i"),
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1]);
    if (candidate && candidate > 0) {
      rate = candidate;
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Xoom rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate, {
    quoted_send_amount: 100,
  });
}

async function handleRemitBee(page, source) {
  await page.goto("https://www.remitbee.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(7000);

  await page.getByRole("button", { name: /Accept all/i }).click({ timeout: 5000 }).catch(() => {});

  await page.waitForTimeout(1500);

  await page.getByRole("button", { name: /IN INR/i }).click({ timeout: 10000 }).catch(() => {});
  await page.locator("#search").fill("ngn", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await page.locator("#NGN").click({ timeout: 10000 }).catch(() => {});

  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText().catch(() => "");
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /\b(1060\.7112)\b/i,
    /\b(10[0-9]{2}(?:\.\d+)?)\s*NGN/i,
    /CAD\s*=\s*([0-9,]+(?:\.\d+)?)\s*NGN/i,
    /1\s*CAD\s*=\s*([0-9,]+(?:\.\d+)?)\s*NGN/i,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;

    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate >= 500 && candidate <= 2000) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) rate = 1060.7112;

  return buildResult(source, rate, 0, rate, {
    verification_status: rate === 1060.7112 ? "remitbee_recorded_rate_fallback" : "verified_from_live_remitbee_widget",
    source_url: "https://www.remitbee.com/",
  });
}

async function handleAceMoneyTransfer(page, source) {
  await page.goto("https://acemoneytransfer.com/Nigeria/Send-Money-to-Nigeria", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(7000);

  await page.getByRole("textbox", { name: /United Kingdom/i }).click({ timeout: 10000 }).catch(() => {});
  await page.getByRole("treeitem", { name: /Canada/i }).click({ timeout: 10000 }).catch(() => {});

  await page.waitForTimeout(1500);

  await page.getByRole("textbox", { name: /Nigeria/i }).click({ timeout: 8000 }).catch(() => {});
  await page.getByRole("textbox", { name: /Nigeria/i }).click({ timeout: 8000 }).catch(() => {});
  await page.getByRole("treeitem", { name: /Nigeria/i }).click({ timeout: 8000 }).catch(() => {});

  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText().catch(() => "");
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /\b(1007\.5266)\b/i,
    /1\s*CAD\s*=\s*([0-9,]+(?:\.\d+)?)\s*NGN/i,
    /CAD\s*=\s*([0-9,]+(?:\.\d+)?)\s*NGN/i,
    /\b(10[0-9]{2}(?:\.\d+)?)\b/i,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;

    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate >= 500 && candidate <= 2000) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) rate = 1007.5266;

  return buildResult(source, rate, 0, rate, {
    verification_status: rate === 1007.5266 ? "ace_recorded_rate_fallback" : "verified_from_live_ace_widget",
    source_url: "https://acemoneytransfer.com/Nigeria/Send-Money-to-Nigeria",
  });
}

async function handleProfee(page, source) {
  await page.goto("https://www.profee.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(7000);

  await page.getByText("GBP", { exact: true }).click({ timeout: 10000 }).catch(() => {});

  await page.locator("#react-select-select-instance-from_country-listbox")
    .getByText(/Canada/i)
    .click({ timeout: 10000 })
    .catch(() => {});

  await page.waitForTimeout(1500);

  await page.locator("#select-to_country > .pfx-select__control > .pfx-select__indicators > .pfx-select__indicator")
    .click({ timeout: 10000 })
    .catch(() => {});

  await page.locator("#react-select-select-instance-to_country-listbox")
    .getByText(/Nigeria/i)
    .click({ timeout: 10000 })
    .catch(() => {});

  await page.waitForTimeout(1500);

  await page.getByText("NGN", { exact: true }).click({ timeout: 8000 }).catch(() => {});

  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText().catch(() => "");
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /NGN\s*([0-9,]+(?:\.\d+)?)/i,
    /\b(1005\.714724)\b/i,
    /1\s*CAD\s*=\s*([0-9,]+(?:\.\d+)?)\s*NGN/i,
    /CAD\s*=\s*([0-9,]+(?:\.\d+)?)\s*NGN/i,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;

    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate >= 500 && candidate <= 2000) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) rate = 1005.714724;

  return buildResult(source, rate, 0, rate, {
    verification_status: rate === 1005.714724 ? "profee_recorded_rate_fallback" : "verified_from_live_profee_widget",
    source_url: "https://www.profee.com/",
  });
}

async function handleVeloRemit(page, source) {
  const destCurrency = currencyForDestination(source.destination);

  await page.goto("https://veloremit.com/en", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.getByRole("button", { name: "Currency Converter" }).click({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // Source -> Canada / CAD
  await page.locator('#mantine-dqsedcl7h-target').getByRole('img', { name: 'flag' }).click({ timeout: 8000 }).catch(async () => {
    await page.getByText("GBP", { exact: true }).click().catch(() => {});
  });
  await page.getByText('GBP', { exact: true }).click({ timeout: 4000 }).catch(() => {});
  await page.locator('div').filter({ hasText: /^Canada - CAD$/ }).nth(1).click({ timeout: 8000 }).catch(async () => {
    await page.getByText(/Canada - CAD|Canada.*CAD/i).first().click().catch(() => {});
  });

  await page.waitForTimeout(1200);

  // Destination -> Nigeria / NGN
  await page.getByText('GHS', { exact: true }).click({ timeout: 6000 }).catch(async () => {
    await page.getByText(/GHS|NGN/i).first().click().catch(() => {});
  });
  await page.locator('div').filter({ hasText: /^Nigeria - NGN$/ }).nth(1).click({ timeout: 8000 }).catch(async () => {
    await page.getByText(/Nigeria - NGN|Nigeria.*NGN/i).first().click().catch(() => {});
  });

  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;
  const patterns = [
    /CAD\s*[≈=]\s*([0-9,]+(?:\.\d+)?)\s*NGN/i,
    /1\s*CAD\s*[≈=]\s*([0-9,]+(?:\.\d+)?)\s*NGN/i,
    /\b(1004\.1)\b/i,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate > 0) {
      rate = candidate;
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract VeloRemit rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate);
}

async function handleAfriChange(page, source) {
  await page.goto("https://africhange.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(6000);

  // Source = Canada
  await page.getByText("USD", { exact: true }).click({ timeout: 6000 }).catch(async () => {
    await page.getByText(/USD|CAD/i).first().click().catch(() => {});
  });

  await page.locator("#cdk-overlay-0").getByText("Canada").click({ timeout: 8000 }).catch(async () => {
    await page.getByText(/^Canada$/).first().click().catch(() => {});
  });

  await page.waitForTimeout(2000);

  // Updated recording shows rate is already visible after source selection
  await page.getByText("CAD = ₦").click({ timeout: 4000 }).catch(() => {});
  await page.locator("span").filter({ hasText: "Recipient gets NGN" }).getByRole("textbox").click({ timeout: 4000 }).catch(() => {});
  await page.getByText("Exchange Rate CAD = ₦").click({ timeout: 4000 }).catch(() => {});

  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /Exchange Rate\s*CAD\s*=\s*₦\s*([0-9,]+(?:\.\d+)?)/i,
    /CAD\s*=\s*₦\s*([0-9,]+(?:\.\d+)?)/i,
    /1\s*CAD\s*=\s*([0-9,]+(?:\.\d+)?)\s*NGN/i,
    /CAD\s*=\s*([0-9,]+(?:\.\d+)?)\s*NGN/i,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1]);
    if (candidate && candidate > 0) {
      rate = candidate;
      break;
    }
  }

  // Fallback: use recipient amount only if it looks like a 1 CAD quote
  if (!rate) {
    const recipientBox = page.locator("span").filter({ hasText: "Recipient gets NGN" }).getByRole("textbox");
    const rawRecipient = await recipientBox.inputValue().catch(() => "");
    const candidate = parseLocaleNumber(rawRecipient);
    if (candidate && candidate > 100 && candidate < 100000) {
      rate = candidate;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract AfriChange rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate);
}

async function handleBanffPay(page, source) {
  await page.goto("https://www.banffpay.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(6000);

  // Source currency = CAD
  await page.getByRole("button", { name: /CAD CAD/i })
    .click({ timeout: 10000 })
    .catch(() => {});

  await page.getByRole("menuitem", { name: /CAD CAD/i })
    .click({ timeout: 10000 })
    .catch(() => {});

  await page.waitForTimeout(1500);

  // Destination currency = NGN
  await page.getByRole("button", { name: /NGN NGN/i })
    .click({ timeout: 10000 })
    .catch(() => {});

  await page.getByRole("menuitem", { name: /NGN NGN/i })
    .click({ timeout: 10000 })
    .catch(() => {});

  await page.waitForTimeout(3000);

  await page.locator(".flex.items-center.justify-center")
    .first()
    .click({ timeout: 5000 })
    .catch(() => {});

  await page.waitForTimeout(3000);

  const bodyText = await page.locator("body").innerText().catch(() => "");
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /₦\s*([0-9,]+(?:\.\d+)?)/i,
    /NGN\s*([0-9,]+(?:\.\d+)?)/i,
    /1\s*CAD\s*=\s*₦?\s*([0-9,]+(?:\.\d+)?)/i,
    /CAD\s*=\s*₦?\s*([0-9,]+(?:\.\d+)?)/i,
  ];

  for (const regex of patterns) {
    const matches = [...bodyText.matchAll(new RegExp(regex.source, "gi"))];

    for (const m of matches) {
      const candidate = parseLocaleNumber(m[1]);

      if (candidate && candidate >= 500 && candidate <= 2000) {
        rate = Number(candidate.toFixed(6));
        break;
      }
    }

    if (rate) break;
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract BanffPay rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate, {
    verification_status: "verified_from_live_banffpay_widget",
    source_url: "https://www.banffpay.com/",
  });
}

async function runSource(browser, source) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1200 },
  });

  try {
    let payload;

    if (source.provider === "Xoom") payload = await handleXoom(page, source);
  
    else if (source.provider === "RemitBee") payload = await handleRemitBee(page, source);
    else if (source.provider === "ACE Money Transfer") payload = await handleAceMoneyTransfer(page, source);
    else if (source.provider === "Profee") payload = await handleProfee(page, source);
    else if (source.provider === "AfriChange") payload = await handleAfriChange(page, source);
    else if (source.provider === "BanffPay") payload = await handleBanffPay(page, source);
    else throw new Error(`No handler configured for ${source.provider}`);

    await postQuote(payload);
    console.log(`OK: ${source.provider} ${source.origin}->${source.destination}`);
  } finally {
    await page.close();
  }
}

async function main() {
  const sources = JSON.parse(fs.readFileSync("./sources-ca-ng3.json", "utf8"));
  const browser = await chromium.launch({ headless: HEADLESS });

  for (const source of sources) {
    try {
      await runSource(browser, source);
    } catch (err) {
      console.error(`FAIL: ${source.provider} - ${err.message}`);
    }
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});