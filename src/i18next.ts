import type { Cookie, SessionStorage } from "@remix-run/server-runtime";
import { pick } from "accept-language-parser";
import type { InitOptions, TFunction } from "i18next";
import { createInstance } from "i18next";
import type { Backend, Language } from "./backend";
import { Cache, CacheKey, InMemoryLRUCache } from "./cache";

interface RemixI18NextOptions {
  /**
   * Define the list of supported languages, this is used to determine if one of
   * the languages requested by the user is supported by the application.
   * This should be be same as the supportedLngs in the i18next options.
   */
  supportedLanguages: string[];
  /**
   * Define the fallback language that it's going to be used in the case user
   * expected language is not supported.
   * This should be be same as the fallbackLng in the i18next options.
   */
  fallbackLng: string;
  /**
   * A class that implements the Cache interface and is used to store the
   * languages, in production, between requests to avoid loading them multiple
   * times, this is used so the user doesn't have to wait for the backend to
   * retrieve the translations every time.
   * By default, remix-i18next uses an in memory cache based on an ES Map
   * instance.
   */
  cache?: Cache;
  /**
   * If enabled, the cache will be used even in development mode.
   * This is disabled by default so while you code the languages are going to
   * be requested again on every request and be up-to-date.
   * Enabling may be useful if you request your translations from a server and
   * have a quote or rate limit on the number of requests.
   */
  cacheInDevelopment?: boolean;
  /**
   * If you want to use a cookie to store the user preferred language, you can
   * pass the Cookie object here.
   */
  cookie?: Cookie;
  /**
   * If you want to use a session to store the user preferred language, you can
   * pass the SessionStorage object here.
   */
  sessionStorage?: SessionStorage;
  /**
   * If defined a sessionStorage and want to change the default key used to
   * store the user preferred language, you can pass the key here.
   * @default "lng"
   */
  sessionKey?: string;
  /**
   * The order the library will use to detect the user preferred language.
   * By default the order is
   * - searchParams
   * - cookie
   * - session
   * - header
   * And finally the fallback language.
   */
  order?: Array<"searchParams" | "cookie" | "session" | "header">;
  i18nextOptions?: InitOptions;
}

export class RemixI18Next {
  private cache: Cache;
  constructor(private backend: Backend, private options: RemixI18NextOptions) {
    this.cache = options.cache ?? new InMemoryLRUCache();
  }

  async getTranslations(
    request: Request,
    namespaces: string | string[]
  ): Promise<Record<string, Language>>;
  async getTranslations(
    locale: string,
    namespaces: string | string[]
  ): Promise<Record<string, Language>>;
  async getTranslations(
    requestOrLocale: Request | string,
    namespaces: string | string[]
  ): Promise<Record<string, Language>> {
    let locale =
      typeof requestOrLocale === "string"
        ? requestOrLocale
        : await this.getLocale(requestOrLocale);

    if (Array.isArray(namespaces)) {
      let messages = await Promise.all(
        namespaces.map((namespace) =>
          this.getTranslation({ namespace, locale })
        )
      );
      return Object.fromEntries(
        messages.map((message, index) => [namespaces[index], message])
      );
    }

    return {
      [namespaces]: await this.getTranslation({
        namespace: namespaces,
        locale,
      }),
    };
  }

  /**
   * Get the user preferred language from the HTTP Request. This method will
   * try to get the language from the Accept-Language header, then the Cookie
   * and finally the search param `?lng`.
   * If none of the methods are able to get the language, it will return the
   * fallback language.
   */
  public async getLocale(request: Request): Promise<string> {
    let order = this.options.order ?? [
      "searchParams",
      "cookie",
      "session",
      "header",
    ];

    for (let method of order) {
      let locale: string | null = null;

      if (method === "searchParams") {
        locale = this.getLocaleFromSearchParams(request);
      }

      if (method === "cookie") {
        locale = await this.getLocaleFromCookie(request);
      }

      if (method === "session") {
        locale = await this.getLocaleFromSessionStorage(request);
      }

      if (method === "header") {
        locale = this.getLocaleFromHeader(request);
      }

      if (locale) return locale;
    }

    return this.options.fallbackLng;
  }

  async getFixedT(
    locale: string,
    namespace?: string,
    options?: InitOptions
  ): Promise<TFunction>;
  async getFixedT(
    request: Request,
    namespace?: string,
    options?: InitOptions
  ): Promise<TFunction>;
  async getFixedT(
    requestOrLocale: Request | string,
    namespace = "common",
    options: InitOptions = {}
  ) {
    let [instance, locale, translations] = await Promise.all([
      this.createInstance({
        ...this.options.i18nextOptions,
        ...options,
        fallbackNS: namespace,
        defaultNS: namespace,
      }),
      typeof requestOrLocale === "string"
        ? requestOrLocale
        : this.getLocale(requestOrLocale),
      typeof requestOrLocale === "string"
        ? this.getTranslations(requestOrLocale, namespace)
        : this.getTranslations(requestOrLocale, namespace),
      ,
    ]);

    return instance
      .addResourceBundle(locale, namespace, translations[namespace])
      .getFixedT(locale, namespace);
  }

  private async createInstance(options: InitOptions = {}) {
    let instance = createInstance();
    await instance.init({
      ...options,
      supportedLngs: this.options.supportedLanguages,
      fallbackLng: this.options.fallbackLng,
    });
    return instance;
  }

  /**
   * Get the user preferred language from the search param `?lng`
   */
  private getLocaleFromSearchParams(request: Request) {
    let url = new URL(request.url);
    if (!url.searchParams.has("lng")) return null;
    return this.getFromSupported(url.searchParams.get("lng"));
  }

  /**
   * Get the user preferred language from a Cookie.
   */
  private async getLocaleFromCookie(request: Request) {
    if (!this.options.cookie) return null;

    let cookie = this.options.cookie;
    let lng = (await cookie.parse(request.headers.get("Cookie"))) ?? "";
    if (!lng) return null;

    return this.getFromSupported(lng);
  }

  /**
   * Get the user preferred language from the Session.
   */
  private async getLocaleFromSessionStorage(request: Request) {
    if (!this.options.sessionStorage) return null;

    let session = await this.options.sessionStorage.getSession(
      request.headers.get("Cookie")
    );

    let lng = session.get(this.options.sessionKey ?? "lng");

    if (!lng) return null;

    return this.getFromSupported(lng);
  }

  /**
   * Get the user preferred language from the Accept-Language header.
   */
  private getLocaleFromHeader(request: Request) {
    let header = request.headers.get("Accept-Language");
    if (!header) return null;
    return this.getFromSupported(header);
  }

  private getFromSupported(language: string | null) {
    return pick(
      this.options.supportedLanguages,
      language ?? this.options.fallbackLng,
      { loose: true }
    );
  }

  private async getTranslation(key: CacheKey): Promise<Language> {
    if (this.cacheEnabled) {
      let cached = await this.cache.get(key);
      if (cached) return cached;
    }

    let translations = await this.backend.getTranslations(
      key.namespace,
      key.locale
    );

    if (this.cacheEnabled) {
      await this.cache.set(key, translations);
    }

    return translations;
  }

  private get cacheEnabled() {
    let env = process.env.NODE_ENV;
    if (env === "production") return true;

    let { cacheInDevelopment } = this.options;
    return cacheInDevelopment ?? false;
  }
}
