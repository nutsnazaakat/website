import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { GiftingFormValues } from "@/features/gifting/schema";
import { rfqApi } from "../api";
import type { RfqFormValues } from "../schema";

export const rfqKeys = {
  all: ["rfqs"] as const,
  list: () => [...rfqKeys.all, "list"] as const,
  detail: (id: string) => [...rfqKeys.all, "detail", id] as const,
};

export const useRfqs = () => useQuery({ queryKey: rfqKeys.list(), queryFn: rfqApi.list });

export const useRfq = (id: string) =>
  useQuery({ queryKey: rfqKeys.detail(id), queryFn: () => rfqApi.get(id) });

/**
 * `POST /rfqs` — a bulk quote request.
 *
 * One mutation per endpoint, not one taking a `kind` discriminant over a shared draft: a bulk
 * enquiry and a gifting enquiry send different bodies to different paths (`CreateRfqRequest` has
 * `lines`/`packaging`/`frequency`; `CreateGiftingRfqRequest` has `occasion`/`boxes`/`budgetPerBox`
 * and neither of the other two's), and a union input would still need every call site to build the
 * fields the other kind doesn't ask for. Two is clearer — see `useCreateGiftingRfq` below.
 */
export function useCreateRfq() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (values: RfqFormValues) => rfqApi.create(values),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: rfqKeys.all });
    },
  });
}

/** `POST /rfqs/gifting` — a corporate gifting enquiry. */
export function useCreateGiftingRfq() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (values: GiftingFormValues) => rfqApi.createGifting(values),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: rfqKeys.all });
    },
  });
}
