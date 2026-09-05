import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import type { AdminSetting } from "@/contract";
import { Page } from "@/components/page";
import { ToneBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/field";
import { Loading, Notice, Panel, PanelHeader } from "@/components/ui/panel";
import { errorMessage } from "@/features/orders/api/errors";
import {
  fetchSettings,
  isStringList,
  kindOf,
  saveSettings,
  unknownSettingKeys,
} from "@/features/settings/api/settings";
import { GROUPED_KEYS, SETTING_GROUPS, SETTING_META } from "@/features/settings/catalogue";
import { dateTime } from "@/lib/format";

/**
 * `/settings` — brief §26 and §37. **The screen the storefront is waiting for.**
 *
 * The WhatsApp number, the support email, the GSTIN, the FSSAI licence and the certifications are
 * all blank in a fresh database, and that is not an oversight to be fixed by typing something
 * plausible. Brief §26 requires certification information to be admin-editable, and §37 says in as
 * many words *"do not hardcode a fake number"* — so `settings.seed.ts` seeds them empty and the
 * storefront renders nothing for them. This screen is the only way they ever get a value, and it
 * says so at the top rather than leaving an operator to guess whether the blanks are a bug.
 *
 * **Only changed keys are sent.** The server writes one audit row per key that actually changed and
 * none for a request that changes nothing, so sending the whole table on every save would be
 * correct but would make "when did the WhatsApp number last change" unanswerable at a glance.
 *
 * **`isPublic` is shown and not editable**, because it is a property of what a setting is rather
 * than an operational choice — and this table holds a GSTIN.
 */
export const Route = createFileRoute("/_console/settings/")({
  component: SettingsScreen,
});

/** The editable form of a value: a string in every case, decoded back on save. */
type Draft = Record<string, string>;

function toDraftValue(value: unknown): string {
  if (isStringList(value)) return value.join("\n");
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" || typeof value === "string") return String(value);
  return JSON.stringify(value);
}

/**
 * Back to the shape the row already had.
 *
 * Keyed off the **current** value's type rather than the text, so a numeric setting stays a number
 * and a list stays a list. Typing letters into a numeric field is refused rather than silently
 * stored as a string that the storefront would then fail to compare against a threshold.
 */
function fromDraftValue(
  current: unknown,
  draft: string,
): { ok: true; value: unknown } | { ok: false } {
  switch (kindOf(current)) {
    case "number": {
      const parsed = Number(draft.trim());
      return draft.trim() === "" || !Number.isFinite(parsed)
        ? { ok: false }
        : { ok: true, value: parsed };
    }
    case "boolean":
      return { ok: true, value: draft === "true" };
    case "list":
      return {
        ok: true,
        // Blank lines dropped: an operator pressing Enter twice must not create an empty
        // certification that the storefront would render as a gap.
        value: draft
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== ""),
      };
    case "text":
      return { ok: true, value: draft };
    default:
      return { ok: false };
  }
}

function SettingsScreen() {
  const client = useQueryClient();
  const [draft, setDraft] = useState<Draft>({});
  const [refusedKeys, setRefusedKeys] = useState<string[] | null>(null);

  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: ({ signal }) => fetchSettings(signal),
  });

  const rows = settings.data ?? [];
  const byKey = new Map(rows.map((row) => [row.key, row]));

  /** Only what the operator actually changed, which is what keeps the audit trail readable. */
  const changed = Object.entries(draft).filter(([key, text]) => {
    const row = byKey.get(key);
    return row !== undefined && toDraftValue(row.value) !== text;
  });

  const mutation = useMutation({
    mutationFn: () => {
      const payload: { key: string; value: unknown }[] = [];
      for (const [key, text] of changed) {
        const row = byKey.get(key);
        if (row === undefined) continue;
        const decoded = fromDraftValue(row.value, text);
        if (!decoded.ok) throw new Error(`${key} must be a ${kindOf(row.value)}.`);
        payload.push({ key, value: decoded.value });
      }
      return saveSettings(payload);
    },
    onSuccess: () => {
      setDraft({});
      setRefusedKeys(null);
      void client.invalidateQueries({ queryKey: ["settings"] });
      // The dashboard groups its day buckets in the business timezone, so a timezone change moves
      // every bar on it. Cheaper to always invalidate than to special-case one key.
      void client.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success("Settings saved.");
    },
    onError: (error: unknown) => {
      const unknown = unknownSettingKeys(error);
      if (unknown !== null) {
        setRefusedKeys(unknown);
        toast.error("Some of those settings do not exist.");
        return;
      }
      toast.error(errorMessage(error));
    },
  });

  if (settings.isPending) {
    return (
      <Page title="Settings">
        <Loading label="Loading settings" />
      </Page>
    );
  }

  if (settings.isError) {
    return (
      <Page title="Settings">
        <Panel>
          <Notice
            tone="error"
            title="Settings could not be loaded."
            body={errorMessage(settings.error)}
            action={
              <Button variant="outline" onClick={() => void settings.refetch()}>
                Try again
              </Button>
            }
          />
        </Panel>
      </Page>
    );
  }

  const ungrouped = rows.filter((row) => !GROUPED_KEYS.has(row.key));
  const groups = [
    ...SETTING_GROUPS.map((group) => ({
      heading: group.heading,
      blurb: group.blurb,
      rows: group.keys
        .map((key) => byKey.get(key))
        .filter((row): row is AdminSetting => row !== undefined),
    })),
    ...(ungrouped.length === 0
      ? []
      : [
          {
            heading: "Other",
            blurb:
              "Settings this screen has not been told about. They are editable all the same — a key added by a later seed appears here rather than disappearing.",
            rows: ungrouped,
          },
        ]),
  ];

  return (
    <Page
      title="Settings"
      description={`${String(rows.length)} settings · ${String(changed.length)} changed`}
      actions={
        <>
          {changed.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setDraft({})}>
              Discard changes
            </Button>
          )}
          <Button
            disabled={mutation.isPending || changed.length === 0}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending
              ? "Saving…"
              : changed.length === 0
                ? "Nothing to save"
                : `Save ${String(changed.length)} ${changed.length === 1 ? "change" : "changes"}`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Panel className="px-3 py-3">
          <p className="text-[12px]">
            <strong className="font-medium">An empty field here is a real answer.</strong> The
            WhatsApp number, support email, GSTIN, FSSAI licence and certifications ship blank on
            purpose: brief §26 and §37 forbid inventing them, so the storefront renders nothing for
            them until somebody types the value the business actually holds. Filling one in is what
            makes it appear on the site.
          </p>
        </Panel>

        {refusedKeys !== null && (
          <Panel>
            <Notice
              tone="error"
              title="The server does not have those settings."
              body={`Refused: ${refusedKeys.join(", ")}. A new setting is added by the backend's seed, alongside the code that reads it — it cannot be created over HTTP, so a typo cannot leave a dead row behind. Nothing in this save was written.`}
              action={
                <Button variant="outline" onClick={() => setRefusedKeys(null)}>
                  Dismiss
                </Button>
              }
            />
          </Panel>
        )}

        {groups.map((group) => (
          <Panel key={group.heading}>
            <PanelHeader title={group.heading} />
            <p className="text-muted-foreground border-border border-b px-3 py-2 text-[11px]">
              {group.blurb}
            </p>
            {group.rows.length === 0 ? (
              <p className="text-muted-foreground px-3 py-3 text-[12px]">
                None of these keys exists in this database.
              </p>
            ) : (
              <div className="flex flex-col gap-4 px-3 py-3">
                {group.rows.map((row) => (
                  <SettingRow
                    key={row.key}
                    setting={row}
                    draft={draft[row.key] ?? toDraftValue(row.value)}
                    dirty={
                      draft[row.key] !== undefined && draft[row.key] !== toDraftValue(row.value)
                    }
                    onChange={(next) => setDraft((previous) => ({ ...previous, [row.key]: next }))}
                  />
                ))}
              </div>
            )}
          </Panel>
        ))}
      </div>
    </Page>
  );
}

function SettingRow({
  setting,
  draft,
  dirty,
  onChange,
}: {
  setting: AdminSetting;
  draft: string;
  dirty: boolean;
  onChange: (next: string) => void;
}) {
  const meta = SETTING_META[setting.key];
  const kind = kindOf(setting.value);
  const id = `setting-${setting.key}`;
  const empty = draft.trim() === "";

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline gap-2">
        <Label htmlFor={id}>{meta?.label ?? setting.key}</Label>
        <span className="text-muted-foreground tnum text-[10px]">{setting.key}</span>
        <ToneBadge
          tone={setting.isPublic ? "working" : "done"}
          title={
            setting.isPublic
              ? "Served by GET /settings — the storefront can read it."
              : "Private. Nothing outside this console reads it."
          }
        >
          {setting.isPublic ? "Public" : "Private"}
        </ToneBadge>
        {dirty && <ToneBadge tone="attention">Unsaved</ToneBadge>}
      </div>

      {kind === "boolean" ? (
        <label className="flex items-center gap-2 text-[12px]">
          <input
            id={id}
            type="checkbox"
            checked={draft === "true"}
            onChange={(event) => onChange(event.target.checked ? "true" : "false")}
          />
          {draft === "true" ? "On" : "Off"}
        </label>
      ) : kind === "list" ? (
        <Textarea
          id={id}
          rows={3}
          placeholder="One per line. Leave empty to render nothing."
          value={draft}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : kind === "unknown" ? (
        <>
          <Input id={id} value={draft} readOnly disabled />
          <p className="text-destructive text-[11px]">
            This value is not a string, number, boolean or list of strings, so this screen will not
            edit it rather than guess at a shape and write something the storefront cannot read.
          </p>
        </>
      ) : (
        <Input
          id={id}
          inputMode={kind === "number" ? "decimal" : undefined}
          value={draft}
          onChange={(event) => onChange(event.target.value)}
        />
      )}

      {meta?.hint !== undefined && <p className="text-muted-foreground text-[11px]">{meta.hint}</p>}

      <p className="text-muted-foreground text-[11px]">
        {empty && (kind === "text" || kind === "list") ? (
          <span>Empty — the storefront renders nothing for this. </span>
        ) : null}
        Last changed <span className="tnum">{dateTime(setting.updatedAt)}</span>
        {setting.updatedByUserId === null ? " (by the seed)" : ""}
      </p>
    </div>
  );
}
