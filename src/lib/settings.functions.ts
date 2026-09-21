import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { messageFor, serviceFetch } from "./service";

export type DomainSettings = {
  scDomain: string;
  vixsrcDomain: string;
};

const domain = z
  .string()
  .trim()
  .min(1, "Domain is required")
  .max(253)
  .transform((value) => value.replace(/^https?:\/\//, "").replace(/\/$/, ""))
  .refine((value) => !/[\s/]/.test(value), "Enter a hostname without a path");

export const getDomainSettings = createServerFn({ method: "GET" }).handler(
  async (): Promise<DomainSettings> => serviceFetch<DomainSettings>("/settings/domains"),
);

export const updateDomainSettings = createServerFn({ method: "POST" })
  .validator((data) => z.object({ scDomain: domain, vixsrcDomain: domain }).parse(data))
  .handler(async ({ data }): Promise<{ ok: boolean; message?: string }> => {
    try {
      await serviceFetch<DomainSettings>("/settings/domains", {
        method: "PUT",
        body: JSON.stringify(data),
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, message: messageFor(error) };
    }
  });

export type DomainCheckDetail = {
  checked: boolean;
  redirected: boolean;
  previousDomain?: string;
  currentDomain?: string;
  error?: string;
};

export type CheckRedirectResult = {
  checked: boolean;
  redirected: boolean;
  previousDomain?: string;
  currentDomain?: string;
  previousVixsrcDomain?: string;
  currentVixsrcDomain?: string;
  sc?: DomainCheckDetail;
  vixsrc?: DomainCheckDetail;
  error?: string;
};

export const checkDomainRedirect = createServerFn({ method: "POST" }).handler(
  async (): Promise<CheckRedirectResult> => {
    try {
      return await serviceFetch<CheckRedirectResult>("/settings/domains/check-redirect", {
        method: "POST",
      });
    } catch (error) {
      return {
        checked: false,
        redirected: false,
        error: messageFor(error),
      };
    }
  },
);
