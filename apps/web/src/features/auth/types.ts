/**
 * The auth domain types live in `@/contract`, so the frontend and the API cannot drift on the
 * shape of a user. `AuthUser` is re-exported as `User` because that is the name this codebase
 * already uses; renaming every import to gain nothing would be churn.
 *
 * There is deliberately no `DemoAccount` here any more. Phase 1 advertised fixture logins on the
 * sign-in screen because auth was a mock; a real sign-in screen must not publish credentials, so
 * both the shape and the UI that rendered it are gone.
 */
export type {
  AuthUser as User,
  CompanyProfile,
  Credentials,
  RegisterInput,
  Role,
} from "@/contract";
