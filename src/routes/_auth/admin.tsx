import { queryOptions, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import {
  KeyRound,
  LockOpen,
  Pencil,
  Trash2,
  UserPlus,
  Camera,
  Loader2,
  Globe,
  RefreshCw,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "@/lib/i18n-hook";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { UploadProfilePictureDialog } from "@/components/UploadProfilePictureDialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  createAccount,
  deleteAccount,
  listAccounts,
  resetPassword,
  updateAccount,
} from "@/lib/auth.functions";
import { clearAllHistory, clearAllLibrary } from "@/lib/library.functions";
import type { AccountRow, Role } from "@/lib/auth/types";
import {
  checkDomainRedirect,
  getDomainSettings,
  updateDomainSettings,
  type DomainSettings,
} from "@/lib/settings.functions";

const accountsQuery = queryOptions({
  queryKey: ["accounts"],
  queryFn: () => listAccounts(),
});

const domainSettingsQuery = queryOptions({
  queryKey: ["domain-settings"],
  queryFn: () => getDomainSettings(),
});

export const Route = createFileRoute("/_auth/admin")({
  head: () => ({
    meta: [{ title: "Admin - StreamApp - Rdn" }],
  }),
  beforeLoad: ({ context }) => {
    if (context.viewer.role !== "admin") throw redirect({ to: "/" });
  },
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(accountsQuery),
      context.queryClient.ensureQueryData(domainSettingsQuery),
    ]),
  component: AdminPage,
});

const DEFAULT_COLOR = "#6366f1";

function isLocked(account: AccountRow) {
  return account.lockedUntil !== null && account.lockedUntil > Date.now();
}

function AdminPage() {
  const { viewer } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const { data: accounts } = useSuspenseQuery(accountsQuery);
  const { data: domainSettings } = useSuspenseQuery(domainSettingsQuery);
  const { t } = useTranslation();

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AccountRow | null>(null);
  const [resetting, setResetting] = useState<AccountRow | null>(null);
  const [deleting, setDeleting] = useState<AccountRow | null>(null);
  const [pictureing, setPictureing] = useState<AccountRow | null>(null);
  const [clearingAll, setClearingAll] = useState(false);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkingRedirect, setCheckingRedirect] = useState(false);
  const [redirectMessage, setRedirectMessage] = useState<{
    type: "success" | "info" | "error";
    text: string;
  } | null>(null);

  async function handleCheckRedirect() {
    setCheckingRedirect(true);
    setRedirectMessage(null);
    setError(null);
    try {
      const result = await checkDomainRedirect();
      if (result.checked) {
        await queryClient.invalidateQueries({ queryKey: domainSettingsQuery.queryKey });
        if (result.redirected) {
          const scChanged = result.sc?.redirected && result.sc.currentDomain;
          const vixChanged = result.vixsrc?.redirected && result.vixsrc.currentDomain;

          let msg = "";
          if (scChanged && vixChanged) {
            msg = t("admin_domainsRedirectDetectedBoth")
              .replace("{scDomain}", result.sc?.currentDomain ?? "")
              .replace("{vixsrcDomain}", result.vixsrc?.currentDomain ?? "");
          } else if (scChanged) {
            msg = t("admin_domainsRedirectDetectedSc").replace(
              "{domain}",
              result.sc?.currentDomain ?? "",
            );
          } else if (vixChanged) {
            msg = t("admin_domainsRedirectDetectedVixsrc").replace(
              "{domain}",
              result.vixsrc?.currentDomain ?? "",
            );
          } else {
            msg = t("admin_domainsRedirectDetected").replace(
              "{domain}",
              result.currentDomain ?? "",
            );
          }

          setRedirectMessage({
            type: "success",
            text: msg,
          });
        } else {
          setRedirectMessage({
            type: "info",
            text: t("admin_domainsNoRedirect"),
          });
        }
      } else {
        setRedirectMessage({
          type: "error",
          text: t("admin_domainsRedirectError").replace("{error}", result.error ?? t("misc_error")),
        });
      }
    } catch (err: unknown) {
      setRedirectMessage({
        type: "error",
        text: t("admin_domainsRedirectError").replace(
          "{error}",
          err instanceof Error ? err.message : t("misc_error"),
        ),
      });
    } finally {
      setCheckingRedirect(false);
    }
  }

  async function handleDomainSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRedirectMessage(null);
    const form = event.currentTarget;
    const scDomain = (form.elements.namedItem("scDomain") as HTMLInputElement).value;
    const vixsrcDomain = (form.elements.namedItem("vixsrcDomain") as HTMLInputElement).value;
    const result = await updateDomainSettings({ data: { scDomain, vixsrcDomain } });
    if (!result.ok) {
      setError(result.message ?? t("misc_error"));
      return;
    }
    await queryClient.invalidateQueries({ queryKey: domainSettingsQuery.queryKey });
    setError(null);
    setRedirectMessage({
      type: "success",
      text: t("admin_domainsSaved"),
    });
  }

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: accountsQuery.queryKey });
    void queryClient.invalidateQueries({ queryKey: ["profiles"] });
  }

  async function act(run: () => Promise<{ ok: boolean; message?: string }>) {
    try {
      const result = await run();
      if (!result.ok) {
        setError(result.message ?? t("misc_error"));
        return false;
      }
      return true;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("misc_error"));
      return false;
    }
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = (form.elements.namedItem("name") as HTMLInputElement).value.trim();
    const password = (form.elements.namedItem("password") as HTMLInputElement).value;
    const role = (form.elements.namedItem("role") as HTMLSelectElement).value as Role;
    const color = (form.elements.namedItem("color") as HTMLInputElement).value;
    const profilePicture = (form.elements.namedItem("profilePicture") as HTMLInputElement).value;

    const ok = await act(async () => {
      const result = await createAccount({
        data: {
          name,
          password,
          role,
          color: color || DEFAULT_COLOR,
          profilePicture: profilePicture || undefined,
        },
      });
      if (!result.ok) return result;
      await refresh();
      setCreating(false);
      return result;
    });
    if (!ok) return;
    setError(null);
  }

  async function handleUpdate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const form = event.currentTarget;
    const name = (form.elements.namedItem("name") as HTMLInputElement).value.trim();
    const color = (form.elements.namedItem("color") as HTMLInputElement).value;
    const profilePicture = (form.elements.namedItem("profilePicture") as HTMLInputElement).value;

    const ok = await act(async () => {
      const result = await updateAccount({
        data: {
          id: editing.id,
          name,
          color: color || undefined,
          profilePicture: profilePicture || undefined,
        },
      });
      if (!result.ok) return result;
      setEditing(null);
      await refresh();
      return result;
    });
    if (!ok) return;
    setError(null);
  }

  async function handleDelete() {
    if (!deleting) return;
    const ok = await act(async () => {
      const result = await deleteAccount({ data: { id: deleting.id } });
      if (!result.ok) return result;
      setDeleting(null);
      await refresh();
      return result;
    });
    if (!ok) return;
    setError(null);
  }

  async function handleClearAllData() {
    setClearingAll(true);
    setError(null);
    const historyResult = await clearAllHistory();
    const libraryResult = await clearAllLibrary();
    if (!historyResult.ok || !libraryResult.ok) {
      setError(
        (!historyResult.ok ? historyResult.message : libraryResult.message) ?? t("misc_error"),
      );
      setClearingAll(false);
      return;
    }
    await refresh();
    setClearingAll(false);
    setError(null);
  }

  async function handleReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!resetting) return;
    const form = event.currentTarget;
    const password = (form.elements.namedItem("password") as HTMLInputElement).value;

    const ok = await act(async () => {
      const result = await resetPassword({ data: { id: resetting.id, password } });
      if (!result.ok) return result;
      setResetting(null);
      await refresh();
      return result;
    });
    if (!ok) return;
    setError(null);
  }

  function displayEmail(account: AccountRow): string {
    if (account.email) return account.email;
    return `${account.name.toLowerCase().replace(/\s+/g, ".")}@streamapp.local`;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-3xl font-semibold text-foreground">{t("admin_title")}</h1>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setClearDialogOpen(true)}
            disabled={clearingAll}
            className="gap-2 text-destructive hover:bg-destructive/10"
          >
            {clearingAll ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Trash2 className="size-4" />
            )}
            {t("admin_clearAllData")}
          </Button>
          <Button type="button" size="sm" onClick={() => setCreating(true)} className="gap-2">
            <UserPlus className="size-4" />
            {t("admin_addUser")}
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="rounded-lg border border-border bg-card p-5">
        <div className="mb-4 flex items-start gap-3">
          <Globe className="mt-1 size-5 text-muted-foreground" />
          <div>
            <h2 className="font-display text-lg font-semibold">{t("admin_domainsTitle")}</h2>
            <p className="text-sm text-muted-foreground">{t("admin_domainsDescription")}</p>
          </div>
        </div>
        <form onSubmit={handleDomainSettings} className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="admin-scDomain">{t("admin_catalogueDomain")}</Label>
            <Input
              key={(domainSettings as DomainSettings).scDomain}
              id="admin-scDomain"
              name="scDomain"
              defaultValue={(domainSettings as DomainSettings).scDomain}
              placeholder="streamingcommunity.example"
              className="font-mono"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="admin-vixsrcDomain">{t("admin_playbackDomain")}</Label>
            <Input
              key={(domainSettings as DomainSettings).vixsrcDomain}
              id="admin-vixsrcDomain"
              name="vixsrcDomain"
              defaultValue={(domainSettings as DomainSettings).vixsrcDomain}
              placeholder="vixsrc.example"
              className="font-mono"
              required
            />
          </div>

          {redirectMessage ? (
            <div
              className={`sm:col-span-2 rounded-lg border p-3 text-sm ${
                redirectMessage.type === "success"
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                  : redirectMessage.type === "error"
                    ? "border-destructive/50 bg-destructive/10 text-destructive"
                    : "border-sky-500/40 bg-sky-500/10 text-sky-400"
              }`}
            >
              {redirectMessage.text}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <Button type="submit" className="gap-2">
              <Globe className="size-4" />
              {t("admin_domainsSave")}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handleCheckRedirect}
              disabled={checkingRedirect}
              className="gap-2"
            >
              {checkingRedirect ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              {checkingRedirect
                ? t("admin_domainsCheckingRedirect")
                : t("admin_domainsCheckRedirect")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground sm:col-span-2">
            {t("admin_domainsAutoRedirectNote")}
          </p>
        </form>
      </div>

      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[160px]">{t("admin_email")}</TableHead>
              <TableHead>{t("admin_role")}</TableHead>
              <TableHead>{t("admin_actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts?.map((account) => (
              <TableRow key={account.id}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Avatar className="size-8">
                      {account.profilePicture ? (
                        <img
                          src={account.profilePicture}
                          alt={account.name}
                          className="aspect-square h-full w-full rounded-full object-cover"
                        />
                      ) : (
                        <AvatarFallback style={{ backgroundColor: account.color }}>
                          {account.name.slice(0, 1).toUpperCase()}
                        </AvatarFallback>
                      )}
                    </Avatar>
                    <div>
                      <div className="text-sm font-medium">{account.name}</div>
                      <div className="text-xs text-muted-foreground">{displayEmail(account)}</div>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={account.role === "admin" ? "default" : "secondary"}>
                    {account.role === "admin" ? t("admin_admin") : t("admin_viewer")}
                  </Badge>
                </TableCell>
                <TableCell className="flex gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setEditing(account)}
                  >
                    <Pencil className="size-3.5" />
                    {t("admin_edit")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setResetting(account)}
                  >
                    <LockOpen className="size-3.5" />
                    {t("admin_resetPasswordTitle")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setDeleting(account)}
                    className="text-destructive hover:bg-destructive/10"
                  >
                    <Trash2 className="size-3.5" />
                    {t("admin_delete")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setPictureing(account)}
                  >
                    <Camera className="size-3.5" />
                    {t("admin_setProfilePicture")}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {accounts && accounts.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-6 text-center">
          <p className="text-sm text-muted-foreground">{t("admin_noUsers")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("admin_createFirst")}</p>
        </div>
      ) : null}

      {creating ? (
        <Dialog open={creating} onOpenChange={setCreating}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>{t("admin_addUserTitle")}</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="create-name">{t("admin_email")}</Label>
                <Input
                  id="create-name"
                  name="name"
                  type="text"
                  autoComplete="name"
                  autoFocus
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="create-password">{t("admin_password")}</Label>
                <Input
                  id="create-password"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="create-role">{t("admin_role")}</Label>
                <div className="flex gap-2">
                  <select
                    id="create-role"
                    name="role"
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm text-foreground shadow-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring"
                    defaultValue="member"
                  >
                    <option value="admin">{t("admin_admin")}</option>
                    <option value="member">{t("admin_viewer")}</option>
                  </select>
                  <Input
                    id="create-color"
                    name="color"
                    type="color"
                    defaultValue={DEFAULT_COLOR}
                    className="h-9 w-14 shrink-0 rounded-md border border-input bg-transparent p-1 cursor-pointer"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="create-profilePicture">Profile picture URL</Label>
                <Input
                  id="create-profilePicture"
                  name="profilePicture"
                  type="url"
                  placeholder="https://..."
                  className="font-mono"
                />
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setCreating(false)}>
                  {t("admin_cancel")}
                </Button>
                <Button type="submit">{t("admin_save")}</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      ) : null}

      {editing ? (
        <Dialog open={editing !== null} onOpenChange={() => setEditing(null)}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>{t("admin_editUserTitle")}</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleUpdate} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="edit-name">{t("admin_email")}</Label>
                <Input
                  id="edit-name"
                  name="name"
                  type="text"
                  defaultValue={editing.name}
                  autoFocus
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-color">{t("color_label")}</Label>
                <div className="flex gap-2">
                  <Input
                    id="edit-color"
                    name="color"
                    type="color"
                    defaultValue={editing.color}
                    className="h-9 w-14 shrink-0 rounded-md border border-input bg-transparent p-1 cursor-pointer"
                  />
                  <Input
                    name="color"
                    type="text"
                    defaultValue={editing.color}
                    className="flex-1 font-mono"
                    placeholder="#hex"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-profilePicture">Profile picture URL</Label>
                <Input
                  id="edit-profilePicture"
                  name="profilePicture"
                  type="url"
                  defaultValue={editing.profilePicture ?? ""}
                  placeholder="https://..."
                  className="font-mono"
                />
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                  {t("admin_cancel")}
                </Button>
                <Button type="submit">{t("admin_save")}</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      ) : null}

      {resetting ? (
        <Dialog open={resetting !== null} onOpenChange={() => setResetting(null)}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>{t("admin_resetPasswordTitle")}</DialogTitle>
              <DialogDescription>{t("admin_resetPasswordDescription")}</DialogDescription>
            </DialogHeader>
            <form onSubmit={handleReset} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="reset-password">{t("admin_password")}</Label>
                <Input
                  id="reset-password"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  autoFocus
                  required
                />
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setResetting(null)}>
                  {t("admin_cancel")}
                </Button>
                <Button type="submit">{t("admin_save")}</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      ) : null}

      {deleting ? (
        <Dialog open={deleting !== null} onOpenChange={() => setDeleting(null)}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>{t("admin_confirmDelete")}</DialogTitle>
              <DialogDescription>{displayEmail(deleting)}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDeleting(null)}>
                {t("admin_cancel")}
              </Button>
              <Button
                type="button"
                onClick={handleDelete}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {t("admin_deleteUser")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      <AlertDialog open={clearDialogOpen} onOpenChange={setClearDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("admin_clearAllDataTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("admin_clearAllDataDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clearingAll}>{t("admin_cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleClearAllData}
              disabled={clearingAll}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {clearingAll ? t("misc_loading") : t("admin_clearAllDataConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <UploadProfilePictureDialog
        open={pictureing !== null}
        onOpenChange={() => setPictureing(null)}
        account={pictureing}
        currentPicture={pictureing?.profilePicture}
        onSuccess={() => {
          setPictureing(null);
          void refresh();
        }}
      />

      {accounts ? (
        <p className="text-xs text-muted-foreground">
          {t("admin_showing")}
          {accounts.length}
          {t("admin_of")}
          {accounts.length}
          {t("admin_usersShown")}
        </p>
      ) : null}
    </div>
  );
}
