// src/worker.ts
// Мини-TDS на Cloudflare Workers с точным определением mobile и поисковых ботов.
// Поддерживает конфиг в формате config/routes.json, импортируемый на этапе сборки.

import ROUTES from "../config/routes.json" assert { type: "json" };

/** ----------------------------- Типы конфига ----------------------------- */

type Device = "mobile" | "desktop" | "tablet" | "any";

type MatchRule = {
  path?: string[];                 // Простейшие шаблоны: '/casino/*', '/go/*'
  pattern?: string[];              // RegExp-строки для pathname (без флагов /.../)
  countries?: string[];            // ISO-3166-1 alpha-2, напр. ["RU","BY"]
  devices?: Device[];              // ["mobile"], ["desktop"], ["mobile","tablet"], ...
  bot?: boolean;                   // true = только боты, false = исключать ботов, undefined = не важно
};

type RouteRule = {
  id?: string;
  match: MatchRule;
  target: string;                  // База redirect-а, напр. 'https://2win.click/tds/go.cgi?4'
  status?: number;                 // 301/302 и т.п. По умолчанию 302
  forwardQuery?: boolean;          // Протянуть оригинальные query-параметры
  appendPath?: boolean;            // Приклеить оригинальный path к target
  extraParams?: Record<string, unknown>; // Доп.параметры ?k=v
  trackingParam?: string;          // Доп. utm/src параметр
  trackingValue?: string;          // Значение для trackingParam
};

type FallbackConfig = {
  response?: {
    status?: number;
    headers?: Record<string, string>;
    body?: string;
  };
};

type RoutesConfig = {
  rules: RouteRule[];
  fallback?: FallbackConfig;
};

/** ----------------------------- Утилиты UA/боты ----------------------------- */

// Корректное определение поисковых ботов (whitelist — не редиректим).
function isSearchBot(uaRaw: string): boolean {
  const ua = (uaRaw || "").toLowerCase();
  const bots = [
    "yandexbot",
    "yandexmobilebot",
    "yandeximages",
    "yandexvideo",
    "yandexnews",
    "yandexwebmaster",
    "googlebot",
    "google-structured-data-testing-tool",
    "bingbot",
    "msnbot",
    "bingpreview",
    "duckduckbot",
    "baiduspider",
    "sogou",
    "exabot",
    "mj12bot",
    "semrushbot",
  ];
  return bots.some((sig) => ua.includes(sig));
}

// Мобильные устройства: телефоны iOS/Android/Windows Phone, исключаем планшеты.
function isMobileUA(uaRaw: string): boolean {
  if (!uaRaw) return false;
  const ua = uaRaw.toLowerCase();

  // Явные мобилки
  if (/(iphone|ipod|windows phone|iemobile|blackberry|opera mini)/i.test(uaRaw)) return true;

  // Android: у телефонов почти всегда присутствует "Mobile", у планшетов — нет
  if (ua.includes("android")) {
    return ua.includes("mobile");
  }

  // Общий маркер mobile (iOS Safari и др.)
  if (/\bmobile\b/i.test(uaRaw)) return true;

  // Явные планшеты
  if (ua.includes("ipad") || ua.includes("tablet")) return false;

  return false;
}

// Простейшее определение "tablet" (для полноты)
function isTabletUA(uaRaw: string): boolean {
  const ua = (uaRaw || "").toLowerCase();
  if (ua.includes("ipad")) return true;
  if (ua.includes("tablet")) return true;
  // Android-планшеты: android без mobile — вероятно планшет
  if (ua.includes("android") && !ua.includes("mobile")) return true;
  return false;
}

/** ----------------------------- Матчинг путей ----------------------------- */

// Простая проверка '/prefix/*' и точное совпадение '/foo/bar'
function matchPathSimple(pattern: string, pathname: string): boolean {
  if (!pattern) return false;
  if (pattern.endsWith("*")) {
    const base = pattern.slice(0, -1); // '/casino/*' -> '/casino/'
    return pathname.startsWith(base);
  }
  return pathname === pattern;
}

// Проверка регэксп-строк для pathname
function matchRegExpStrings(patterns: string[] | undefined, pathname: string): boolean {
  if (!patterns || patterns.length === 0) return true; // нет паттернов — не ограничиваем
  return patterns.some((src) => {
    try {
      const re = new RegExp(src);
      return re.test(pathname);
    } catch {
      return false;
    }
  });
}

// Главный матч по rule.match
function matchRule(
  rule: MatchRule,
  pathname: string,
  country: string,
  device: Device,
  isBot: boolean
): boolean {
  // 1) path (шаблоны)
  if (rule.path && rule.path.length > 0) {
    const ok = rule.path.some((p) => matchPathSimple(p, pathname));
    if (!ok) return false;
  }

  // 2) pattern (RegExp-строки)
  if (!matchRegExpStrings(rule.pattern, pathname)) return false;

  // 3) страны
  if (rule.countries && rule.countries.length > 0) {
    const ok = rule.countries.includes(country);
    if (!ok) return false;
  }

  // 4) устройcтва
  if (rule.devices && rule.devices.length > 0 && !rule.devices.includes("any")) {
    if (!rule.devices.includes(device)) return false;
  }

  // 5) боты/не боты
  if (typeof rule.bot === "boolean") {
    if (rule.bot === true && !isBot) return false;   // правило только для ботов
    if (rule.bot === false && isBot) return false;   // правило исключает ботов
  }

  return true;
}

/** ----------------------------- Построение редиректа ----------------------------- */

// Копируем Query из src → dst (без дубликатов)
function copyQueryParams(from: URL, to: URL) {
  for (const [k, v] of from.searchParams.entries()) {
    to.searchParams.set(k, v);
  }
}

// Приклеиваем path с учётом слешей
function appendPath(base: URL, extraPath: string) {
  if (!extraPath) return;
  const joined =
    base.pathname.endsWith("/") || extraPath.startsWith("/")
      ? `${base.pathname}${extraPath}`
      : `${base.pathname}/${extraPath}`;
  base.pathname = joined;
}

// Перенос первого сегмента исходного пути в query параметр.
// Пример: исходный path "/casino/888starz/..." + {stripPrefix:"/casino/", paramName:"bonus"}
// → добавит ?bonus=888starz
function applyPathToParam(
  dstUrl: URL,
  srcPath: string,
  opts?: { stripPrefix?: string; paramName?: string }
) {
  const stripPrefix = opts?.stripPrefix || "";
  const paramName = opts?.paramName || "";
  if (!paramName) return;

  let path = srcPath || "/";
  if (stripPrefix && path.startsWith(stripPrefix)) {
    path = path.slice(stripPrefix.length);
  }
  const seg = path.split("/").filter(Boolean)[0];
  if (seg) {
    dstUrl.searchParams.set(paramName, seg);
  }
}

// Сборка итогового redirect-URL согласно правилу
function buildRedirectUrl(rule: RouteRule, reqUrl: URL): URL {
  const target = new URL(rule.target);

  // 1) Приклеить оригинальный path
  if (rule.appendPath) {
    appendPath(target, reqUrl.pathname);
  }

  // 2) Протянуть оригинальные query-параметры
  if (rule.forwardQuery) {
    copyQueryParams(reqUrl, target);
  }

  // 3) Доп.параметры из extraParams (кроме служебных __*)
  if (rule.extraParams) {
    for (const [k, v] of Object.entries(rule.extraParams)) {
      if (k.startsWith("__")) continue; // служебные ключи пропускаем
      target.searchParams.set(k, String(v));
    }
  }

  // 4) Новая фича: перенос сегмента пути в параметр (?bonus=SEGMENT)
  //    Служебные ключи:
  //    - __pathToParam: string (имя параметра, напр. "bonus")
  //    - __stripPrefix: string (префикс, напр. "/casino/")
  const pathToParam = (rule.extraParams?.["__pathToParam"] ?? "") as string;
  if (pathToParam) {
    const stripPrefix = (rule.extraParams?.["__stripPrefix"] ?? "") as string;
    applyPathToParam(target, reqUrl.pathname, {
      stripPrefix,
      paramName: pathToParam,
    });
  }

  // 5) Трекинг
  if (rule.trackingParam && rule.trackingValue) {
    target.searchParams.set(rule.trackingParam, rule.trackingValue);
  }

  return target;
}

/** ----------------------------- Ответ по умолчанию ----------------------------- */

function fallbackResponse(cfg?: FallbackConfig): Response {
  const st = cfg?.response?.status ?? 204;
  const body = cfg?.response?.body ?? "";
  const headers = new Headers(cfg?.response?.headers ?? {});
  return new Response(body, { status: st, headers });
}

/** ----------------------------- Worker ----------------------------- */

export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    const cfg = (ROUTES as RoutesConfig) || { rules: [] };

    const url = new URL(request.url);
    const pathname = url.pathname;

    const ua = request.headers.get("user-agent") || "";

    const bot = isSearchBot(ua);

    // Страна из CF (если нет — пустая строка)
    const country = ((request as any).cf?.country || "").toUpperCase();

    // Определяем device
    let device: Device = "desktop";
    if (isTabletUA(ua)) device = "tablet";
    else if (isMobileUA(ua)) device = "mobile";

    // Пытаемся найти первое подходящее правило
    const rule = cfg.rules.find((r) => {
      try {
        return matchRule(r.match || {}, pathname, country, device, bot);
      } catch {
        return false;
      }
    });

    if (!rule) {
      // Правило не найдено — отдаём fallback
      return fallbackResponse(cfg.fallback);
    }

    // Если это правило вообще про редирект — собираем URL и редиректим
    const redirectUrl = buildRedirectUrl(rule, url);
    const code = rule.status ?? 302;

    return Response.redirect(redirectUrl.toString(), code);
  },
};
