import { useMutation } from "@tanstack/react-query";
import { contactApi } from "../api";
import type { ContactFormValues } from "../schema";

export const useSubmitContactMessage = () =>
  useMutation({
    mutationFn: (values: ContactFormValues) => contactApi.submit(values),
  });
