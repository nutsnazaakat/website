import { Mail, MapPin, MessageCircle, Phone } from "lucide-react";
import { settings } from "@/config/settings";

/**
 * Every channel here is admin-configurable and empty by default. The brief forbids
 * hardcoding a phone or WhatsApp number, so each row renders only once its setting has a
 * value — and when none of them do, the panel says so instead of leaving a blank card on
 * the page.
 */
export function ContactDetails() {
  const rows = [
    settings.supportEmail !== "" && {
      key: "email",
      icon: Mail,
      label: "Email",
      value: settings.supportEmail,
      href: `mailto:${settings.supportEmail}`,
    },
    settings.supportPhone !== "" && {
      key: "phone",
      icon: Phone,
      label: "Phone",
      value: settings.supportPhone,
      href: `tel:${settings.supportPhone}`,
    },
    settings.whatsappNumber !== "" && {
      key: "whatsapp",
      icon: MessageCircle,
      label: "WhatsApp",
      value: settings.whatsappNumber,
      href: `https://wa.me/${settings.whatsappNumber}`,
    },
  ].filter((r): r is Exclude<typeof r, false> => r !== false);

  const hasAddress = settings.addressLines.length > 0;
  const hasSocial = settings.social.length > 0;

  if (rows.length === 0 && !hasAddress && !hasSocial) {
    return (
      <div className="border-border bg-sand border p-6">
        <p className="text-[13px] font-bold">Phone, WhatsApp and certifications</p>
        <p className="text-muted-foreground mt-2 text-sm">
          Our phone, email and WhatsApp lines are being set up. The form on this page reaches us in
          the meantime, and we reply to every message.
        </p>
        <p className="sr-only">Contact details coming soon</p>
      </div>
    );
  }

  return (
    <div className="border-border bg-card border p-6">
      <p className="font-display text-2xl">Reach us directly</p>
      <ul className="mt-4 space-y-3 text-sm">
        {rows.map((r) => (
          <li key={r.key} className="flex items-start gap-3">
            <r.icon className="text-gold mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              <span className="text-muted-foreground block">{r.label}</span>
              <a href={r.href} className="underline underline-offset-4">
                {r.value}
              </a>
            </span>
          </li>
        ))}
        {hasAddress && (
          <li className="flex items-start gap-3">
            <MapPin className="text-gold mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              <span className="text-muted-foreground block">Address</span>
              <address className="not-italic">
                {settings.addressLines.map((l) => (
                  <span key={l} className="block">
                    {l}
                  </span>
                ))}
              </address>
            </span>
          </li>
        )}
      </ul>
      {hasSocial && (
        <ul className="border-border mt-5 flex flex-wrap gap-3 border-t pt-4 text-sm">
          {settings.social.map((s) => (
            <li key={s.label}>
              <a
                href={s.url}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-4"
              >
                {s.label}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
