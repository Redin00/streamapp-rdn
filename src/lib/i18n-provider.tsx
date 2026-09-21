import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
} from "react";

import { type Locale, LANGUAGES, DEFAULT_LOCALE, IT, EN } from "./i18n";

const STORAGE_KEY = "streamapp-locale";

interface LocaleContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  languages: typeof LANGUAGES;
  t: (key: string) => string;
  ready: boolean;
}

const LocaleContext = createContext<LocaleContextValue>({
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
  languages: LANGUAGES,
  t: (key: string) => key,
  ready: false,
});

export function useLocale() {
  return useContext(LocaleContext);
}

export function useSetLocale() {
  const { setLocale } = useLocale();
  return setLocale;
}

export function useLocaleReady() {
  const { ready } = useLocale();
  return ready;
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);
  const [ready, setReady] = useState(false);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    try {
      if (typeof window !== "undefined") {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved && LANGUAGES.some((l) => l.code === saved)) {
          setLocaleState(saved as Locale);
        }
      }
    } catch {
      // localStorage unavailable
    }
    setReady(true);
  }, []);

  const setLocale = useCallback((newLocale: Locale) => {
    if (!LANGUAGES.some((l) => l.code === newLocale)) return;
    setLocaleState(newLocale);
    try {
      localStorage.setItem(STORAGE_KEY, newLocale);
    } catch {
      // localStorage unavailable
    }
  }, []);

  const t = useCallback(
    (key: string) => {
      const dict = locale === "it" ? IT : EN;
      const keys = key.split(".");
      let value: unknown = dict;
      for (const k of keys) {
        if (value && typeof value === "object" && k in value) {
          value = (value as Record<string, unknown>)[k];
        } else {
          return key;
        }
      }
      return typeof value === "string" ? value : key;
    },
    [locale],
  );

  const contextValue = useMemo(
    () => ({
      locale,
      setLocale,
      languages: LANGUAGES,
      t,
      ready,
    }),
    [locale, setLocale, ready],
  );

  return <LocaleContext.Provider value={contextValue}>{children}</LocaleContext.Provider>;
}
